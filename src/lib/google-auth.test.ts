import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { jwt, magicLink } from "better-auth/plugins";
import {
  FRESH_SESSION_SECONDS,
  googleAuthOptions,
  type LinkedNotice,
} from "@/lib/google-auth-options";

// These run the real Better Auth (in-memory database, real magic link and OAuth callback code)
// with only Google's token endpoint faked. They pin the sign-in policy: the magic link creates
// the user, Google can only be added by a signed-in user, and it can never create a user.

const BASE = "http://localhost:3000";

type GoogleIdentity = { sub: string; email: string };
let google: GoogleIdentity = { sub: "unset", email: "unset@example.com" };

const realFetch = globalThis.fetch;

function base64url(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

// Better Auth reads the Google user from the id_token it gets back (no signature check).
function fakeIdToken({ sub, email }: GoogleIdentity): string {
  const header = base64url({ alg: "none", typ: "JWT" });
  const payload = base64url({ sub, email, email_verified: true, name: "Google User" });
  return `${header}.${payload}.sig`;
}

beforeEach(() => {
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === "https://oauth2.googleapis.com/token") {
      return Response.json({
        access_token: "access-token",
        token_type: "Bearer",
        expires_in: 3600,
        id_token: fakeIdToken(google),
      });
    }
    return realFetch(input, init);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// Moves the clock past the fresh-session window, so every session made so far is "old".
function makeSessionsStale() {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(Date.now() + (FRESH_SESSION_SECONDS + 60) * 1000));
}

function cookiesOf(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
}

function mergeCookies(...parts: string[]): string {
  return parts.filter(Boolean).join("; ");
}

function createTestAuth(
  notify: (notice: LinkedNotice) => Promise<void> = async () => {},
  { rateLimit = false }: { rateLimit?: boolean } = {},
) {
  const notifyLinked = vi.fn(notify);
  const options = googleAuthOptions(
    { clientId: "client-id", clientSecret: "client-secret" },
    { notifyLinked },
  );
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
      // Same shape as auth.ts, so the /token and /jwks endpoints can be tested.
      jwt({
        jwt: { issuer: BASE, audience: "api.test", expirationTime: "5m", definePayload: () => ({}) },
      }),
    ],
    ...options,
    // The rules are the real ones from googleAuthOptions; only the production-only switch is on.
    ...(rateLimit && { rateLimit: { ...options.rateLimit, enabled: true } }),
  });

  // Signs the email in through the real magic link flow, which creates the user. Returns the
  // session cookie.
  async function signInWithMagicLink(email: string): Promise<string> {
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

  // Starts the Google flow, then plays Google's redirect back to our callback. `sessionCookie`
  // is set for linking (needs a session) and empty for signing in.
  async function googleCallback(
    identity: GoogleIdentity,
    mode: "signIn" | "link",
    sessionCookie = "",
  ) {
    google = identity;
    const start =
      mode === "link"
        ? await auth.api.linkSocialAccount({
            body: { provider: "google", callbackURL: "/profile", errorCallbackURL: "/profile" },
            headers: new Headers({ cookie: sessionCookie }),
            asResponse: true,
          })
        : await auth.api.signInSocial({
            body: { provider: "google", callbackURL: "/", errorCallbackURL: "/login" },
            headers: new Headers(),
            asResponse: true,
          });
    const { url } = (await start.json()) as { url: string };
    const state = new URL(url).searchParams.get("state");
    if (!state) throw new Error("the Google redirect had no state");

    const res = await auth.handler(
      new Request(`${BASE}/api/auth/callback/google?code=code&state=${state}`, {
        headers: { cookie: mergeCookies(sessionCookie, cookiesOf(start)) },
      }),
    );
    const location = new URL(res.headers.get("location") ?? "", BASE);
    return {
      path: location.pathname,
      error: location.searchParams.get("error"),
      cookie: cookiesOf(res),
    };
  }

  async function userByEmail(email: string) {
    const context = await auth.$context;
    return context.internalAdapter.findUserByEmail(email);
  }

  async function linkedProviders(cookie: string): Promise<string[]> {
    const accounts = await auth.api.listUserAccounts({ headers: new Headers({ cookie }) });
    return accounts.map((account) => account.providerId);
  }

  async function sessionUserId(cookie: string): Promise<string | undefined> {
    const session = await auth.api.getSession({ headers: new Headers({ cookie }) });
    return session?.user.id;
  }

  return {
    auth,
    notifyLinked,
    signInWithMagicLink,
    googleCallback,
    userByEmail,
    linkedProviders,
    sessionUserId,
  };
}

describe("Google sign-in policy", () => {
  it("does not create a user for a Google account nobody linked", async () => {
    const t = createTestAuth();

    const result = await t.googleCallback({ sub: "g-new", email: "new@example.com" }, "signIn");

    expect(result.path).toBe("/login");
    expect(result.error).toBe("signup_disabled");
    expect(result.cookie).not.toContain("session_token");
    expect(await t.userByEmail("new@example.com")).toBeNull();
  });

  it("does not sign in by email match: a Google account with a user's email must be linked first", async () => {
    const t = createTestAuth();
    const sessionCookie = await t.signInWithMagicLink("root@example.com");

    const result = await t.googleCallback({ sub: "g-same", email: "root@example.com" }, "signIn");

    expect(result.path).toBe("/login");
    expect(result.error).toBe("account_not_linked");
    expect(result.cookie).not.toContain("session_token");
    expect(await t.linkedProviders(sessionCookie)).toEqual([]);
  });

  it("links Google to the signed-in user, even when the Google email differs", async () => {
    const t = createTestAuth();
    const sessionCookie = await t.signInWithMagicLink("root@example.com");

    const result = await t.googleCallback(
      { sub: "g-other", email: "other@gmail.com" },
      "link",
      sessionCookie,
    );

    expect(result.path).toBe("/profile");
    expect(result.error).toBeNull();
    expect(await t.linkedProviders(sessionCookie)).toEqual(["google"]);
    expect(await t.userByEmail("other@gmail.com")).toBeNull();
  });

  it("signs in as the same user once Google is linked", async () => {
    const t = createTestAuth();
    const sessionCookie = await t.signInWithMagicLink("root@example.com");
    const rootId = await t.sessionUserId(sessionCookie);
    const identity = { sub: "g-linked", email: "other@gmail.com" };
    await t.googleCallback(identity, "link", sessionCookie);

    const result = await t.googleCallback(identity, "signIn");

    expect(result.path).toBe("/");
    expect(result.error).toBeNull();
    expect(rootId).toBeDefined();
    expect(await t.sessionUserId(result.cookie)).toBe(rootId);
  });

  it("stops a Google account from signing in after it is unlinked", async () => {
    const t = createTestAuth();
    const sessionCookie = await t.signInWithMagicLink("root@example.com");
    const identity = { sub: "g-unlink", email: "other@gmail.com" };
    await t.googleCallback(identity, "link", sessionCookie);
    const accounts = await t.auth.api.listUserAccounts({
      headers: new Headers({ cookie: sessionCookie }),
    });
    const googleAccount = accounts.find((account) => account.providerId === "google");
    if (!googleAccount) throw new Error("Google was not linked");

    await t.auth.api.unlinkAccount({
      body: { accountId: googleAccount.id },
      headers: new Headers({ cookie: sessionCookie }),
    });
    const result = await t.googleCallback(identity, "signIn");

    expect(await t.linkedProviders(sessionCookie)).toEqual([]);
    expect(result.path).toBe("/login");
    expect(result.error).toBe("signup_disabled");
    expect(result.cookie).not.toContain("session_token");
  });

  it("does not link a Google account that already belongs to another user", async () => {
    const t = createTestAuth();
    const aliceCookie = await t.signInWithMagicLink("alice@example.com");
    const bobCookie = await t.signInWithMagicLink("bob@example.com");
    const identity = { sub: "g-shared", email: "shared@gmail.com" };
    await t.googleCallback(identity, "link", aliceCookie);

    const result = await t.googleCallback(identity, "link", bobCookie);

    expect(result.error).toBe("account_already_linked_to_different_user");
    expect(await t.linkedProviders(bobCookie)).toEqual([]);
  });

  it("refuses to link with a session older than the fresh window", async () => {
    const t = createTestAuth();
    const sessionCookie = await t.signInWithMagicLink("root@example.com");
    makeSessionsStale();

    await expect(
      t.auth.api.linkSocialAccount({
        body: { provider: "google", callbackURL: "/profile" },
        headers: new Headers({ cookie: sessionCookie }),
      }),
    ).rejects.toMatchObject({ status: "FORBIDDEN", body: { code: "SESSION_NOT_FRESH" } });
    expect(await t.linkedProviders(sessionCookie)).toEqual([]);
    expect(t.notifyLinked).not.toHaveBeenCalled();
  });

  it("links again after the user signs in anew", async () => {
    const t = createTestAuth();
    await t.signInWithMagicLink("root@example.com");
    makeSessionsStale();
    const freshCookie = await t.signInWithMagicLink("root@example.com");

    const result = await t.googleCallback(
      { sub: "g-again", email: "other@gmail.com" },
      "link",
      freshCookie,
    );

    expect(result.error).toBeNull();
    expect(await t.linkedProviders(freshCookie)).toEqual(["google"]);
  });

  it("refuses to unlink with a session older than the fresh window", async () => {
    const t = createTestAuth();
    const sessionCookie = await t.signInWithMagicLink("root@example.com");
    await t.googleCallback({ sub: "g-old", email: "other@gmail.com" }, "link", sessionCookie);
    const accounts = await t.auth.api.listUserAccounts({
      headers: new Headers({ cookie: sessionCookie }),
    });
    const googleAccount = accounts.find((account) => account.providerId === "google");
    if (!googleAccount) throw new Error("Google was not linked");
    makeSessionsStale();

    await expect(
      t.auth.api.unlinkAccount({
        body: { accountId: googleAccount.id },
        headers: new Headers({ cookie: sessionCookie }),
      }),
    ).rejects.toMatchObject({ status: "FORBIDDEN", body: { code: "SESSION_NOT_FRESH" } });
    expect(await t.linkedProviders(sessionCookie)).toEqual(["google"]);
  });

  it("emails the user's own address when Google is linked, not the Google address", async () => {
    const t = createTestAuth();
    const sessionCookie = await t.signInWithMagicLink("root@example.com");

    await t.googleCallback({ sub: "g-notice", email: "other@gmail.com" }, "link", sessionCookie);

    expect(t.notifyLinked).toHaveBeenCalledTimes(1);
    expect(t.notifyLinked).toHaveBeenCalledWith({ to: "root@example.com", provider: "google" });
  });

  it("sends no notice when nothing was linked", async () => {
    const t = createTestAuth();
    await t.signInWithMagicLink("root@example.com");

    await t.googleCallback({ sub: "g-none", email: "root@example.com" }, "signIn");

    expect(t.notifyLinked).not.toHaveBeenCalled();
  });

  it("still links when the notice cannot be sent", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const t = createTestAuth(async () => {
      throw new Error("mail is down");
    });
    const sessionCookie = await t.signInWithMagicLink("root@example.com");

    const result = await t.googleCallback(
      { sub: "g-mail-down", email: "other@gmail.com" },
      "link",
      sessionCookie,
    );

    expect(result.error).toBeNull();
    expect(await t.linkedProviders(sessionCookie)).toEqual(["google"]);
  });

  it("refuses to start linking without a session", async () => {
    const t = createTestAuth();

    await expect(
      t.auth.api.linkSocialAccount({
        body: { provider: "google", callbackURL: "/profile" },
        headers: new Headers(),
      }),
    ).rejects.toMatchObject({ status: "UNAUTHORIZED" });
  });

  describe("account deletion", () => {
    async function rowCounts(t: ReturnType<typeof createTestAuth>, email: string) {
      const context = await t.auth.$context;
      const found = await context.internalAdapter.findUserByEmail(email);
      return found ? { user: 1 } : { user: 0 };
    }

    it("deletes the user and the linked Google account, and Google can no longer sign in", async () => {
      const t = createTestAuth();
      const sessionCookie = await t.signInWithMagicLink("root@example.com");
      const identity = { sub: "g-del", email: "other@gmail.com" };
      await t.googleCallback(identity, "link", sessionCookie);
      const userId = await t.sessionUserId(sessionCookie);
      if (!userId) throw new Error("no user");
      const context = await t.auth.$context;
      expect(await context.internalAdapter.findAccounts(userId)).toHaveLength(1);

      await t.auth.api.deleteUser({ headers: new Headers({ cookie: sessionCookie }), body: {} });

      expect(await rowCounts(t, "root@example.com")).toEqual({ user: 0 });
      expect(await context.internalAdapter.findAccounts(userId)).toEqual([]);
      expect(await t.sessionUserId(sessionCookie)).toBeUndefined();
      const result = await t.googleCallback(identity, "signIn");
      expect(result.error).toBe("signup_disabled");
      expect(result.cookie).not.toContain("session_token");
    });

    it("refuses to delete with a session older than the fresh window", async () => {
      const t = createTestAuth();
      const sessionCookie = await t.signInWithMagicLink("root@example.com");
      makeSessionsStale();

      await expect(
        t.auth.api.deleteUser({ headers: new Headers({ cookie: sessionCookie }), body: {} }),
      // Better Auth answers 400 "Session expired" here, not the 403 our link hook uses.
      ).rejects.toMatchObject({ status: "BAD_REQUEST" });
      expect(await rowCounts(t, "root@example.com")).toEqual({ user: 1 });
    });

    it("refuses to delete without a session", async () => {
      const t = createTestAuth();
      await expect(
        t.auth.api.deleteUser({ headers: new Headers(), body: {} }),
      ).rejects.toMatchObject({ status: "UNAUTHORIZED" });
    });
  });
});

describe("rate limits on the auth endpoints", () => {
  const ip = { "x-forwarded-for": "203.0.113.7" };

  async function post(t: ReturnType<typeof createTestAuth>, path: string, cookie = "") {
    const res = await t.auth.handler(
      new Request(`${BASE}/api/auth/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE, cookie, ...ip },
        body: JSON.stringify({}),
      }),
    );
    return res.status;
  }

  it("limits the other account actions too", async () => {
    for (const [path, max] of [
      ["unlink-account", 5],
      ["link-social", 5],
      ["sign-in/social", 10],
    ] as const) {
      const t = createTestAuth(undefined, { rateLimit: true });
      const statuses = [];
      for (let i = 0; i < max + 1; i++) statuses.push(await post(t, path));
      expect(statuses.slice(0, max), path).not.toContain(429);
      expect(statuses[max], path).toBe(429);
    }
  });

  it("keeps the magic link limit: the sixth request in a minute gets 429", async () => {
    const t = createTestAuth(undefined, { rateLimit: true });
    const statuses = [];
    for (let i = 0; i < 6; i++) {
      const res = await t.auth.handler(
        new Request(`${BASE}/api/auth/sign-in/magic-link`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: BASE, ...ip },
          body: JSON.stringify({ email: "root@example.com" }),
        }),
      );
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 5)).not.toContain(429);
    expect(statuses[5]).toBe(429);
  });

  it("does not limit when the switch is off (development)", async () => {
    const t = createTestAuth();
    const statuses = [];
    for (let i = 0; i < 12; i++) statuses.push(await post(t, "sign-in/social"));
    expect(statuses).not.toContain(429);
  });
});

describe("endpoints that only our Server Actions may call", () => {
  async function http(t: ReturnType<typeof createTestAuth>, path: string, cookie: string, body: object) {
    const res = await t.auth.handler(
      new Request(`${BASE}/api/auth/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE, cookie },
        body: JSON.stringify(body),
      }),
    );
    return { status: res.status, body: await res.text() };
  }

  it("refuses to delete the account over HTTP, even with a fresh session", async () => {
    const t = createTestAuth();
    const cookie = await t.signInWithMagicLink("root@example.com");

    const res = await http(t, "delete-user", cookie, {});

    expect(res.status).toBe(403);
    expect(res.body).toContain("SERVER_ONLY");
    expect(await t.userByEmail("root@example.com")).not.toBeNull();
    expect(await t.sessionUserId(cookie)).toBeDefined();
  });

  it("refuses to update the user over HTTP, so the name rules cannot be skipped", async () => {
    const t = createTestAuth();
    const cookie = await t.signInWithMagicLink("root@example.com");

    const res = await http(t, "update-user", cookie, { name: "x".repeat(100_000) });

    expect(res.status).toBe(403);
    const user = await t.userByEmail("root@example.com");
    expect(user?.user.name.length ?? 0).toBeLessThan(100);
  });

  it("does not hand a JWT to the browser: GET /token is refused over HTTP", async () => {
    const t = createTestAuth();
    const cookie = await t.signInWithMagicLink("root@example.com");

    const res = await t.auth.handler(
      new Request(`${BASE}/api/auth/token`, { headers: { cookie, origin: BASE } }),
    );
    const text = await res.text();

    expect(res.status).toBe(403);
    expect(text).toContain("SERVER_ONLY");
    expect(text).not.toMatch(/eyJ/); // a JWT starts with this
  });

  it("still issues the JWT to our own server code, and still serves the public keys over HTTP", async () => {
    const t = createTestAuth();
    const cookie = await t.signInWithMagicLink("root@example.com");

    const { token } = await t.auth.api.getToken({ headers: new Headers({ cookie }) });
    expect(token.split(".")).toHaveLength(3);

    // The Go API fetches these over HTTP, so they must stay public.
    const jwks = await t.auth.handler(new Request(`${BASE}/api/auth/jwks`));
    expect(jwks.status).toBe(200);
    expect((await jwks.json()).keys.length).toBeGreaterThan(0);
  });

  it("still lets our own server code update and delete (the Server Actions do)", async () => {
    const t = createTestAuth();
    const cookie = await t.signInWithMagicLink("root@example.com");
    const headers = new Headers({ cookie });

    await t.auth.api.updateUser({ headers, body: { name: "Alice" } });
    expect((await t.userByEmail("root@example.com"))?.user.name).toBe("Alice");

    await t.auth.api.deleteUser({ headers, body: {} });
    expect(await t.userByEmail("root@example.com")).toBeNull();
  });
});
