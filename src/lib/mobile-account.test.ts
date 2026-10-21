import { describe, expect, it, vi } from "vitest";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { magicLink } from "better-auth/plugins";
import { FRESH_SESSION_SECONDS, googleAuthOptions } from "@/lib/google-auth-options";
import { nativeClientPlugins } from "@/lib/native-clients";
import { deleteAccountFromApp, type MobileAccountDeps } from "@/lib/mobile-account";

// The real Better Auth configuration in memory (as in mobile-profile.test.ts), so the bearer token
// really becomes a session, the other sessions are really revoked and the user is really deleted.
// Only the Go API call and the notice email are fakes.
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

  const calls = { apiData: 0, notices: [] as string[] };
  const fail = { step: null as null | "delete-api-data" };

  const deps: MobileAccountDeps = {
    getSession: (headers) => auth.api.getSession({ headers }),
    steps: (headers) => ({
      revokeOtherSessions: async () => {
        await auth.api.revokeOtherSessions({ headers });
      },
      deleteApiData: async () => {
        if (fail.step === "delete-api-data") throw new Error("go api is down; secret=hunter2");
        calls.apiData++;
      },
      deleteUser: async () => {
        await auth.api.deleteUser({ headers, body: {} });
      },
      notifyDeleted: async ({ to }) => {
        calls.notices.push(to);
      },
    }),
  };

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

  const sessionOf = (cookie: string) => auth.api.getSession({ headers: new Headers({ cookie }) });

  return { auth, deps, calls, fail, signIn, sessionOf };
}

const del = (headers: Record<string, string>, body: unknown) =>
  new Request(`${BASE}/api/mobile/account`, {
    method: "DELETE",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("deleteAccountFromApp", () => {
  it("deletes the account: the Go data, the user and the sessions, and sends the notice", async () => {
    const t = createTestAuth();
    const { cookie, bearer } = await t.signIn("a@example.com");

    const res = await deleteAccountFromApp(
      del({ authorization: `Bearer ${bearer}` }, { confirmEmail: " A@Example.com " }),
      t.deps,
    );

    expect(res).toEqual({ status: 200, body: { deleted: true } });
    expect(t.calls.apiData).toBe(1);
    expect(t.calls.notices).toEqual(["a@example.com"]);
    expect(await t.sessionOf(cookie)).toBeNull();
  });

  it("revokes the user's other sessions, not only the one that asked", async () => {
    const t = createTestAuth();
    const other = await t.signIn("a@example.com");
    const mine = await t.signIn("a@example.com");

    await deleteAccountFromApp(
      del({ authorization: `Bearer ${mine.bearer}` }, { confirmEmail: "a@example.com" }),
      t.deps,
    );

    expect(await t.sessionOf(other.cookie)).toBeNull();
  });

  it("deletes only the caller's account", async () => {
    const t = createTestAuth();
    const a = await t.signIn("a@example.com");
    const b = await t.signIn("b@example.com");

    await deleteAccountFromApp(
      del({ authorization: `Bearer ${a.bearer}` }, { confirmEmail: "a@example.com" }),
      t.deps,
    );

    expect(await t.sessionOf(a.cookie)).toBeNull();
    expect((await t.sessionOf(b.cookie))?.user.email).toBe("b@example.com");
  });

  it("refuses a different email (422) and deletes nothing", async () => {
    const t = createTestAuth();
    const { cookie, bearer } = await t.signIn("a@example.com");
    for (const body of [{ confirmEmail: "other@example.com" }, {}, { confirmEmail: 5 }, []]) {
      const res = await deleteAccountFromApp(del({ authorization: `Bearer ${bearer}` }, body), t.deps);
      expect(res).toEqual({ status: 422, body: { error: "email_mismatch" } });
    }
    expect(t.calls.apiData).toBe(0);
    expect(await t.sessionOf(cookie)).not.toBeNull();
  });

  it("refuses an old session (403) before anything is deleted", async () => {
    const t = createTestAuth();
    const { cookie, bearer } = await t.signIn("a@example.com");
    const later = new Date(Date.now() + (FRESH_SESSION_SECONDS - 10) * 1000); // inside 5 min, past the margin

    const res = await deleteAccountFromApp(
      del({ authorization: `Bearer ${bearer}` }, { confirmEmail: "a@example.com" }),
      { ...t.deps, now: () => later },
    );

    expect(res).toEqual({ status: 403, body: { error: "recent_sign_in_required" } });
    expect(t.calls.apiData).toBe(0);
    expect(await t.sessionOf(cookie)).not.toBeNull();
  });

  it("answers 500 without details when a step fails, and leaves the user in place", async () => {
    const t = createTestAuth();
    const { cookie, bearer } = await t.signIn("a@example.com");
    t.fail.step = "delete-api-data";
    const log = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await deleteAccountFromApp(
      del({ authorization: `Bearer ${bearer}` }, { confirmEmail: "a@example.com" }),
      t.deps,
    );
    log.mockRestore();

    expect(res).toEqual({ status: 500, body: { error: "failed" } });
    expect(JSON.stringify(res)).not.toContain("hunter2");
    expect(await t.sessionOf(cookie)).not.toBeNull();
    expect(t.calls.notices).toEqual([]);
  });

  it("can be repeated after a failure and then finishes", async () => {
    const t = createTestAuth();
    const { cookie, bearer } = await t.signIn("a@example.com");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    t.fail.step = "delete-api-data";
    const request = () => del({ authorization: `Bearer ${bearer}` }, { confirmEmail: "a@example.com" });
    expect((await deleteAccountFromApp(request(), t.deps)).status).toBe(500);
    log.mockRestore();

    t.fail.step = null;
    // revokeOtherSessions kept this session, so the retry runs with the same bearer token.
    expect((await deleteAccountFromApp(request(), t.deps)).status).toBe(200);
    expect(await t.sessionOf(cookie)).toBeNull();
  });

  it("refuses without a bearer token (401), with a bad one (401), and with a Cookie (403)", async () => {
    const t = createTestAuth();
    const { cookie, bearer } = await t.signIn("a@example.com");
    const body = { confirmEmail: "a@example.com" };
    expect((await deleteAccountFromApp(del({}, body), t.deps)).status).toBe(401);
    expect((await deleteAccountFromApp(del({ authorization: "Bearer nope" }, body), t.deps)).status).toBe(401);
    expect((await deleteAccountFromApp(del({ authorization: "Bearer " }, body), t.deps)).status).toBe(401);
    expect(
      (await deleteAccountFromApp(del({ authorization: `Bearer ${bearer}`, cookie }, body), t.deps)).status,
    ).toBe(403);
    expect((await deleteAccountFromApp(del({ cookie }, body), t.deps)).status).toBe(403);
    expect(t.calls.apiData).toBe(0);
    expect(await t.sessionOf(cookie)).not.toBeNull();
  });

  it("refuses a body that is not JSON (400) or too large (413)", async () => {
    const t = createTestAuth();
    const { bearer } = await t.signIn("a@example.com");
    const headers = { authorization: `Bearer ${bearer}` };
    expect((await deleteAccountFromApp(del(headers, "not json"), t.deps)).status).toBe(400);
    expect(
      (await deleteAccountFromApp(del(headers, { confirmEmail: "a".repeat(5000) }), t.deps)).status,
    ).toBe(413);
    expect(t.calls.apiData).toBe(0);
  });
});
