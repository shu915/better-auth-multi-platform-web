import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "@/db/schema";
import { createDatabaseRateLimiter, type SqlExecutor } from "@/lib/database-rate-limit";

// The first group needs no database. The second runs the limiter against a real Postgres, with
// the real rate_limit table from drizzle/ in its own throwaway schema (like auth-postgres.test.ts),
// so what is checked is the SQL itself: the atomic counting, not a copy of it.

describe("when the database cannot be reached", () => {
  it("lets the request through and reports the failure (a counting outage must not lock users out)", async () => {
    const onError = vi.fn();
    const broken: SqlExecutor = {
      execute: async () => {
        throw new Error("connection refused");
      },
    };
    const limiter = createDatabaseRateLimiter({
      name: "t",
      rule: { windowMs: 1000, max: 1 },
      getDb: async () => broken,
      onError,
    });

    expect(await limiter.check("u1")).toEqual({ allowed: true });
    expect(await limiter.check("u1")).toEqual({ allowed: true });
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it("also lets it through when opening the database fails", async () => {
    const onError = vi.fn();
    const limiter = createDatabaseRateLimiter({
      name: "t",
      rule: { windowMs: 1000, max: 1 },
      getDb: async () => {
        throw new Error("DATABASE_URL is required");
      },
      onError,
    });
    expect(await limiter.check("u1")).toEqual({ allowed: true });
    expect(onError).toHaveBeenCalledTimes(1);
  });
});

const url = process.env.TEST_DATABASE_URL;
const schemaName = `web_test_${randomBytes(4).toString("hex")}`;

describe.runIf(Boolean(url))("the database rate limiter on a real Postgres", () => {
  let admin: Pool;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let clock = 1_000_000_000_000;

  beforeAll(async () => {
    admin = new Pool({ connectionString: url });
    await admin.query(`CREATE SCHEMA "${schemaName}"`);
    pool = new Pool({ connectionString: url, options: `-c search_path=${schemaName}` });
    db = drizzle(pool, { schema });
    for (const file of readdirSync("drizzle").filter((f) => f.endsWith(".sql")).sort()) {
      const text = readFileSync(join("drizzle", file), "utf8").replaceAll('"public".', `"${schemaName}".`);
      for (const statement of text.split("--> statement-breakpoint")) await pool.query(statement);
    }
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    await admin?.end();
  });

  const make = (name: string, rule: { windowMs: number; max: number }) =>
    createDatabaseRateLimiter({ name, rule, getDb: async () => db, now: () => clock });

  it("lets max attempts through and blocks the next, saying how long to wait", async () => {
    const limiter = make("basic", { windowMs: 10_000, max: 3 });
    for (let i = 0; i < 3; i++) expect(await limiter.check("u1")).toEqual({ allowed: true });
    expect(await limiter.check("u1")).toEqual({ allowed: false, retryAfterSeconds: 10 });
    clock += 4_000;
    expect(await limiter.check("u1")).toEqual({ allowed: false, retryAfterSeconds: 6 });
  });

  it("lets attempts through again once the window is over", async () => {
    const limiter = make("window", { windowMs: 10_000, max: 1 });
    expect(await limiter.check("u1")).toEqual({ allowed: true });
    expect((await limiter.check("u1")).allowed).toBe(false);
    clock += 10_000;
    expect(await limiter.check("u1")).toEqual({ allowed: true });
    expect((await limiter.check("u1")).allowed).toBe(false);
  });

  it("does not move the window when an attempt is blocked, so waiting is enough", async () => {
    const limiter = make("blocked", { windowMs: 10_000, max: 1 });
    await limiter.check("u1");
    for (let i = 0; i < 20; i++) {
      clock += 400; // hammering while blocked, for 8 seconds
      expect((await limiter.check("u1")).allowed).toBe(false);
    }
    clock += 2_000;
    expect(await limiter.check("u1")).toEqual({ allowed: true });
  });

  it("never lets more than max through when requests arrive at the same time", async () => {
    const limiter = make("race", { windowMs: 60_000, max: 5 });

    const results = await Promise.all(Array.from({ length: 40 }, () => limiter.check("same-key")));

    expect(results.filter((r) => r.allowed)).toHaveLength(5);
    expect(results.filter((r) => !r.allowed)).toHaveLength(35);
  });

  it("keeps keys and names apart", async () => {
    const a = make("name-a", { windowMs: 10_000, max: 1 });
    const b = make("name-b", { windowMs: 10_000, max: 1 });
    expect(await a.check("u1")).toEqual({ allowed: true });
    expect(await a.check("u2")).toEqual({ allowed: true }); // another key
    expect(await b.check("u1")).toEqual({ allowed: true }); // another limiter, same key
    expect((await a.check("u1")).allowed).toBe(false);
  });

  it("writes keys that cannot collide with Better Auth's own (which look like 'ip|/path')", async () => {
    const limiter = make("keys", { windowMs: 10_000, max: 1 });
    await limiter.check("203.0.113.7|/sign-in/social");
    const { rows } = await pool.query<{ key: string }>(`SELECT key FROM rate_limit WHERE key LIKE '%keys%'`);
    expect(rows.map((r) => r.key)).toEqual(["action:keys:203.0.113.7|/sign-in/social"]);
  });

  it("deletes rows that are long past every window when a new window starts", async () => {
    await db.execute(
      sql`INSERT INTO rate_limit (id, key, count, last_request) VALUES ('old-1', 'action:old:x', 1, ${clock - 2 * 60 * 60_000}::bigint)`,
    );
    const limiter = make("cleanup", { windowMs: 10_000, max: 1 });

    await limiter.check("fresh");

    const { rows } = await pool.query(`SELECT 1 FROM rate_limit WHERE key = 'action:old:x'`);
    expect(rows).toHaveLength(0);
  });
});
