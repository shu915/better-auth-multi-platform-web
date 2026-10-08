import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { jwt, magicLink } from "better-auth/plugins";
import { count, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "@/db/schema";
import { googleAuthOptions } from "@/lib/google-auth-options";

// These run against a real Postgres, with the real tables from drizzle/ (the migrations are
// applied here), so the foreign keys, the unique constraints and the jwks table are the real
// ones, which the in-memory database of google-auth.test.ts cannot show. They need
// TEST_DATABASE_URL; each run works in its own throwaway schema, which is dropped afterwards, so
// nothing else in that database is touched. Never point it at a database with real data.

const url = process.env.TEST_DATABASE_URL;
const schemaName = `web_test_${randomBytes(4).toString("hex")}`;

const BASE = "http://localhost:3000";
const AUDIENCE = "api.test";

function cookiesOf(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
}

describe.runIf(Boolean(url))("Better Auth on a real Postgres", () => {
  let admin: Pool;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;

  beforeAll(async () => {
    admin = new Pool({ connectionString: url });
    await admin.query(`CREATE SCHEMA "${schemaName}"`);
    pool = new Pool({ connectionString: url, options: `-c search_path=${schemaName}` });
    db = drizzle(pool, { schema });
    // The same SQL files the project's own migration step applies, run into this schema.
    for (const file of readdirSync("drizzle").filter((f) => f.endsWith(".sql")).sort()) {
      // The foreign keys name the "public" schema; point them at this run's schema.
      const sql = readFileSync(join("drizzle", file), "utf8").replaceAll('"public".', `"${schemaName}".`);
      const statements = sql.split("--> statement-breakpoint");
      for (const statement of statements) await pool.query(statement);
    }
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    await admin?.end();
  });

  function createAuth() {
    const tokens = new Map<string, string>();
    const auth = betterAuth({
      baseURL: BASE,
      secret: "test-secret-test-secret-test-secret-123456",
      database: drizzleAdapter(db, { provider: "pg", schema }),
      plugins: [
        magicLink({
          sendMagicLink: async ({ email, token }) => {
            tokens.set(email, token);
          },
        }),
        jwt({
          jwt: { issuer: BASE, audience: AUDIENCE, expirationTime: "5m", definePayload: () => ({}) },
        }),
      ],
      ...googleAuthOptions(null, { notifyLinked: async () => {} }),
    });

    async function signIn(email: string): Promise<string> {
      await auth.api.signInMagicLink({ body: { email }, headers: new Headers() });
      const token = tokens.get(email);
      if (!token) throw new Error("no magic link token was sent");
      const res = await auth.api.magicLinkVerify({
        query: { token },
        headers: new Headers(),
        asResponse: true,
      });
      return cookiesOf(res);
    }

    return { auth, signIn };
  }

  async function rowCounts(userId: string) {
    const [u] = await db.select({ n: count() }).from(schema.user).where(eq(schema.user.id, userId));
    const [s] = await db.select({ n: count() }).from(schema.session).where(eq(schema.session.userId, userId));
    const [a] = await db.select({ n: count() }).from(schema.account).where(eq(schema.account.userId, userId));
    return { user: u.n, session: s.n, account: a.n };
  }

  it("applies the migrations: every table Better Auth needs exists", async () => {
    const { rows } = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = $1`,
      [schemaName],
    );
    const names = rows.map((r) => r.table_name);
    for (const table of ["user", "session", "account", "verification", "jwks"]) {
      expect(names).toContain(table);
    }
  });

  it("enforces the foreign keys: a session or account for a missing user is refused", async () => {
    const now = new Date();
    await expect(
      db.insert(schema.session).values({
        id: "s-orphan", token: "t-orphan", expiresAt: now, updatedAt: now, userId: "no-such-user",
      }),
    ).rejects.toThrow();
    await expect(
      db.insert(schema.account).values({
        id: "a-orphan", accountId: "x", providerId: "google", userId: "no-such-user", updatedAt: now,
      }),
    ).rejects.toThrow();
  });

  it("refuses two users with the same email", async () => {
    await db.insert(schema.user).values({ id: "dup-1", name: "A", email: "dup@example.com" });
    await expect(
      db.insert(schema.user).values({ id: "dup-2", name: "B", email: "dup@example.com" }),
    ).rejects.toThrow();
  });

  it("deleting a user row removes its sessions and accounts, and only its own", async () => {
    const now = new Date();
    await db.insert(schema.user).values([
      { id: "c-1", name: "One", email: "c1@example.com" },
      { id: "c-2", name: "Two", email: "c2@example.com" },
    ]);
    for (const id of ["c-1", "c-2"]) {
      await db.insert(schema.session).values({
        id: `s-${id}`, token: `t-${id}`, expiresAt: now, updatedAt: now, userId: id,
      });
      await db.insert(schema.account).values({
        id: `a-${id}`, accountId: id, providerId: "google", userId: id, updatedAt: now,
      });
    }

    await db.delete(schema.user).where(eq(schema.user.id, "c-1"));

    expect(await rowCounts("c-1")).toEqual({ user: 0, session: 0, account: 0 });
    expect(await rowCounts("c-2")).toEqual({ user: 1, session: 1, account: 1 });
  });

  it("signs in by magic link, issues a JWT from the real jwks table, and deletes the account", async () => {
    const { auth, signIn } = createAuth();
    const cookie = await signIn("root@example.com");
    const headers = new Headers({ cookie });

    const session = await auth.api.getSession({ headers });
    const userId = session?.user.id;
    if (!userId) throw new Error("no session");
    expect((await rowCounts(userId)).user).toBe(1);

    // The JWT's subject is the user id (this is what the Go API trusts) and the signing key
    // was stored in the real jwks table.
    const { token } = await auth.api.getToken({ headers });
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
    expect(payload).toMatchObject({ sub: userId, iss: BASE, aud: AUDIENCE });
    const [{ n: keys }] = await db.select({ n: count() }).from(schema.jwks);
    expect(keys).toBeGreaterThan(0);

    // A linked sign-in method (as Google would be) and a second user who must not be affected.
    const now = new Date();
    await db.insert(schema.account).values({
      id: "a-linked", accountId: "g-1", providerId: "google", userId, updatedAt: now,
    });
    const otherCookie = await signIn("other@example.com");
    const otherId = (await auth.api.getSession({ headers: new Headers({ cookie: otherCookie }) }))?.user.id;
    if (!otherId) throw new Error("no second session");
    expect((await rowCounts(userId)).account).toBe(1);

    await auth.api.deleteUser({ headers, body: {} });

    expect(await rowCounts(userId)).toEqual({ user: 0, session: 0, account: 0 });
    expect((await rowCounts(otherId)).user).toBe(1);
    expect((await rowCounts(otherId)).session).toBe(1);
    expect(await auth.api.getSession({ headers })).toBeNull();
    const [{ n: keysAfter }] = await db.select({ n: count() }).from(schema.jwks);
    expect(keysAfter).toBe(keys); // the signing keys are shared, not the user's data
  });
});
