import { describe, expect, it } from "vitest";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { magicLink } from "better-auth/plugins";
import { googleAuthOptions } from "@/lib/google-auth-options";
import { nativeClientPlugins } from "@/lib/native-clients";
import { updateNameFromApp, type MobileProfileDeps } from "@/lib/mobile-profile";

// Runs the real Better Auth configuration (same options and plugins as auth.ts, in memory), so the
// bearer token really is turned into a session and updateUser really runs.
const BASE = "http://localhost:3000";

function createTestAuth() {
  const tokens = new Map<string, string>();
  const auth = betterAuth({
    baseURL: BASE,
    secret: "test-secret-test-secret-test-secret-123456",
    database: memoryAdapter({ user: [], session: [], account: [], verification: [], jwks: [] }),
    plugins: [
      magicLink({
        sendMagicLink: async ({ email, token }) => {
          tokens.set(email, token);
        },
      }),
      ...nativeClientPlugins(),
    ],
    ...googleAuthOptions(null, { notifyLinked: async () => {} }),
  });

  const deps: MobileProfileDeps = {
    getSession: (headers) => auth.api.getSession({ headers }),
    updateName: async (headers, name) => {
      await auth.api.updateUser({ headers, body: { name } });
    },
  };

  // Signs in through the real magic link flow. Returns the session token a native app would hold
  // (the session cookie's value) and the cookie itself.
  async function signIn(email: string) {
    await auth.api.signInMagicLink({ body: { email }, headers: new Headers() });
    const token = tokens.get(email);
    if (!token) throw new Error("no magic link token was sent");
    const res = await auth.api.magicLinkVerify({
      query: { token },
      headers: new Headers(),
      asResponse: true,
    });
    const cookie = res.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    return { cookie, bearer: cookie.slice(cookie.indexOf("=") + 1) };
  }

  async function currentName(cookie: string) {
    const session = await auth.api.getSession({ headers: new Headers({ cookie }) });
    return session?.user.name;
  }

  return { auth, deps, signIn, currentName };
}

const patch = (headers: Record<string, string>, body: unknown) =>
  new Request(`${BASE}/api/mobile/profile`, {
    method: "PATCH",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("updateNameFromApp", () => {
  it("changes the name for a signed bearer token with no cookie", async () => {
    const t = createTestAuth();
    const { cookie, bearer } = await t.signIn("a@example.com");

    const res = await updateNameFromApp(
      patch({ authorization: `Bearer ${bearer}` }, { name: "  Alice  " }),
      t.deps,
    );

    expect(res).toEqual({ status: 200, body: { name: "Alice" } });
    expect(await t.currentName(cookie)).toBe("Alice");
  });

  it("refuses a request with no authorization header (401)", async () => {
    const t = createTestAuth();
    await t.signIn("a@example.com");
    const res = await updateNameFromApp(patch({}, { name: "X" }), t.deps);
    expect(res.status).toBe(401);
  });

  it("refuses a bearer token that is not a session (401), and changes nothing", async () => {
    const t = createTestAuth();
    const { cookie } = await t.signIn("a@example.com");
    const before = await t.currentName(cookie);
    const res = await updateNameFromApp(patch({ authorization: "Bearer not-a-token" }, { name: "X" }), t.deps);
    expect(res.status).toBe(401);
    expect(await t.currentName(cookie)).toBe(before);
  });

  it("refuses the raw session token: only the signed value counts", async () => {
    const t = createTestAuth();
    const { cookie, bearer } = await t.signIn("a@example.com");
    const before = await t.currentName(cookie);
    const raw = decodeURIComponent(bearer).split(".")[0];
    const res = await updateNameFromApp(patch({ authorization: `Bearer ${raw}` }, { name: "X" }), t.deps);
    expect(res.status).toBe(401);
    expect(await t.currentName(cookie)).toBe(before);
  });

  it("refuses a bearer token sent together with a Cookie header (403)", async () => {
    const t = createTestAuth();
    const { cookie, bearer } = await t.signIn("a@example.com");
    const before = await t.currentName(cookie);
    const res = await updateNameFromApp(
      patch({ authorization: `Bearer ${bearer}`, cookie }, { name: "X" }),
      t.deps,
    );
    expect(res.status).toBe(403);
    expect(await t.currentName(cookie)).toBe(before);
  });

  it("treats an empty or non-bearer authorization header as signed out (401)", async () => {
    const t = createTestAuth();
    await t.signIn("a@example.com");
    for (const authorization of ["Bearer ", "Bearer", "Basic abc"]) {
      expect((await updateNameFromApp(patch({ authorization }, { name: "X" }), t.deps)).status).toBe(401);
    }
  });

  it("refuses a Cookie alone (403): a browser session cannot use this endpoint", async () => {
    const t = createTestAuth();
    const { cookie } = await t.signIn("a@example.com");
    const before = await t.currentName(cookie);
    const res = await updateNameFromApp(patch({ cookie }, { name: "X" }), t.deps);
    expect(res.status).toBe(403);
    expect(await t.currentName(cookie)).toBe(before);
  });

  it.each([
    ["an empty name", { name: "" }],
    ["a blank name", { name: "   " }],
    ["a name over 50 characters", { name: "a".repeat(51) }],
    ["a NUL character", { name: "a\0b" }],
    ["a name that is not a string", { name: 5 }],
    ["no name", {}],
    ["a body that is not an object", []],
  ])("refuses %s with 422 and does not save", async (_label, body) => {
    const t = createTestAuth();
    const { cookie, bearer } = await t.signIn("a@example.com");
    const before = await t.currentName(cookie);
    const res = await updateNameFromApp(patch({ authorization: `Bearer ${bearer}` }, body), t.deps);
    expect(res.status).toBe(422);
    expect(await t.currentName(cookie)).toBe(before);
  });

  it("counts 50 characters as code points, not UTF-16 units", async () => {
    const t = createTestAuth();
    const { bearer } = await t.signIn("a@example.com");
    const res = await updateNameFromApp(
      patch({ authorization: `Bearer ${bearer}` }, { name: "😀".repeat(50) }),
      t.deps,
    );
    expect(res.status).toBe(200);
  });

  it("refuses a body that is not JSON (400) or too large (413)", async () => {
    const t = createTestAuth();
    const { bearer } = await t.signIn("a@example.com");
    const headers = { authorization: `Bearer ${bearer}` };
    expect((await updateNameFromApp(patch(headers, "not json"), t.deps)).status).toBe(400);
    expect((await updateNameFromApp(patch(headers, { name: "a".repeat(5000) }), t.deps)).status).toBe(413);
  });

  it("does not write when the name is unchanged", async () => {
    const t = createTestAuth();
    const { bearer } = await t.signIn("a@example.com");
    const headers = { authorization: `Bearer ${bearer}` };
    await updateNameFromApp(patch(headers, { name: "Alice" }), t.deps);

    let writes = 0;
    const res = await updateNameFromApp(patch(headers, { name: " Alice " }), {
      ...t.deps,
      updateName: async () => {
        writes++;
      },
    });

    expect(res).toEqual({ status: 200, body: { name: "Alice" } });
    expect(writes).toBe(0);
  });

  it("answers 503 when the session cannot be read", async () => {
    const t = createTestAuth();
    const { bearer } = await t.signIn("a@example.com");
    const res = await updateNameFromApp(patch({ authorization: `Bearer ${bearer}` }, { name: "Bob" }), {
      ...t.deps,
      getSession: async () => {
        throw new Error("db down");
      },
    });
    expect(res).toEqual({ status: 503, body: { error: "unavailable" } });
  });

  it("answers 413 from content-length before reading the body", async () => {
    const t = createTestAuth();
    const { bearer } = await t.signIn("a@example.com");
    const res = await updateNameFromApp(
      patch({ authorization: `Bearer ${bearer}`, "content-length": "999999" }, { name: "Bob" }),
      t.deps,
    );
    expect(res.status).toBe(413);
  });

  it("answers 500 without details when the write fails", async () => {
    const t = createTestAuth();
    const { bearer } = await t.signIn("a@example.com");
    const res = await updateNameFromApp(patch({ authorization: `Bearer ${bearer}` }, { name: "Bob" }), {
      ...t.deps,
      updateName: async () => {
        throw new Error("db password is hunter2");
      },
    });
    expect(res).toEqual({ status: 500, body: { error: "could not save" } });
  });
});
