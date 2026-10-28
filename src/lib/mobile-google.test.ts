import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { magicLink } from "better-auth/plugins";
import { symmetricDecrypt } from "better-auth/crypto";
import { googleAuthOptions } from "@/lib/google-auth-options";
import { nativeClientPlugins } from "@/lib/native-clients";
import { challengeOf, exchangeCode, sessionRedirectPlugins } from "@/lib/mobile-code";

// Google from the native app: linking it to the signed-in user, and signing in with it. The real
// Better Auth (in memory, the real OAuth callback code) with only Google's token endpoint faked.
// What matters here is what the redirect to the app's deep link carries after Google sends the
// browser back: a session only when a session was made, and then only as a one-time code.

const BASE = "http://localhost:3000";
const SCHEME = "betterauthmulti://";

let google = { sub: "unset", email: "unset@example.com" };
const realFetch = globalThis.fetch;
const base64url = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");

beforeEach(() => {
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === "https://oauth2.googleapis.com/token") {
      return Response.json({
        access_token: "access-token",
        token_type: "Bearer",
        expires_in: 3600,
        id_token: `${base64url({ alg: "none", typ: "JWT" })}.${base64url({
          sub: google.sub,
          email: google.email,
          email_verified: true,
          name: "Google User",
        })}.sig`,
      });
    }
    return realFetch(input, init);
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const cookiesOf = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");

function createTestAuth() {
  const tokens = new Map<string, string>();
  const auth = betterAuth({
    baseURL: BASE,
    secret: "test-secret-test-secret-test-secret-123456",
    trustedOrigins: [SCHEME],
    database: memoryAdapter({ user: [], session: [], account: [], verification: [], jwks: [] }),
    plugins: [
      magicLink({
        sendMagicLink: async ({ email, token }) => {
          tokens.set(email, token);
        },
      }),
      ...nativeClientPlugins(),
      ...sessionRedirectPlugins(),
    ],
    ...googleAuthOptions(
      { clientId: "client-id", clientSecret: "client-secret" },
      { notifyLinked: async () => {} },
    ),
  });

  // A signed-in web session (the cookie), made by the real magic link.
  async function signIn(email: string): Promise<string> {
    await auth.api.signInMagicLink({ body: { email }, headers: new Headers() });
    const token = tokens.get(email);
    if (!token) throw new Error("no magic link token was sent");
    const res = await auth.api.magicLinkVerify({ query: { token }, headers: new Headers(), asResponse: true });
    return cookiesOf(res);
  }

  /** Starts Google (linking when a session cookie is given, signing in otherwise) and plays Google's redirect back. */
  async function viaGoogle(
    identity: typeof google,
    callbackURL: string,
    sessionCookie = "",
  ): Promise<{ location: URL; setCookie: string[] }> {
    google = identity;
    const start = sessionCookie
      ? await auth.api.linkSocialAccount({
          body: { provider: "google", callbackURL, errorCallbackURL: callbackURL },
          headers: new Headers({ cookie: sessionCookie }),
          asResponse: true,
        })
      : await auth.api.signInSocial({
          body: { provider: "google", callbackURL, errorCallbackURL: callbackURL },
          headers: new Headers(),
          asResponse: true,
        });
    const { url } = (await start.json()) as { url: string };
    const state = new URL(url).searchParams.get("state");
    if (!state) throw new Error("the Google redirect had no state");
    const res = await auth.handler(
      new Request(`${BASE}/api/auth/callback/google?code=code&state=${state}`, {
        headers: { cookie: [sessionCookie, cookiesOf(start)].filter(Boolean).join("; ") },
      }),
    );
    return { location: new URL(res.headers.get("location") ?? "", BASE), setCookie: res.headers.getSetCookie() };
  }

  const consume = async (identifier: string) => (await auth.$context).internalAdapter.consumeVerificationValue(identifier);
  const open = async (sealed: string) => symmetricDecrypt({ key: (await auth.$context).secretConfig, data: sealed });
  const providers = async (cookie: string) =>
    (await auth.api.listUserAccounts({ headers: new Headers({ cookie }) })).map((a) => a.providerId);

  return { auth, signIn, viaGoogle, deps: { consume, open }, providers };
}

const newVerifier = () => randomBytes(32).toString("base64url");

describe("linking Google from the native app", () => {
  it("links, and the redirect to the app carries no session, no code and no error", async () => {
    const t = createTestAuth();
    const cookie = await t.signIn("a@example.com");

    const { location } = await t.viaGoogle(
      { sub: "g-1", email: "a@example.com" },
      `${SCHEME}/?state=s1`,
      cookie,
    );

    expect(location.protocol).toBe("betterauthmulti:");
    expect(await t.providers(cookie)).toContain("google");
    // Nothing was signed in, so nothing is handed over (the cookie the web app set only forgets
    // the OAuth state).
    expect(location.searchParams.has("cookie")).toBe(false);
    expect(location.searchParams.has("code")).toBe(false);
    expect(location.searchParams.has("error")).toBe(false);
    expect(location.searchParams.get("state")).toBe("s1");
  });
});

describe("signing in with Google from the native app", () => {
  async function userWithGoogle(t: ReturnType<typeof createTestAuth>) {
    const cookie = await t.signIn("a@example.com");
    await t.viaGoogle({ sub: "g-1", email: "a@example.com" }, `${SCHEME}/?state=link`, cookie);
  }

  it("hands over a one-time code, never the session, to a link that carries a challenge", async () => {
    const t = createTestAuth();
    await userWithGoogle(t);
    const verifier = newVerifier();

    const { location } = await t.viaGoogle(
      { sub: "g-1", email: "a@example.com" },
      `${SCHEME}/?state=s2&cc=${challengeOf(verifier)}`,
    );

    expect(location.searchParams.has("cookie")).toBe(false);
    const code = location.searchParams.get("code") ?? "";
    expect(code).not.toBe("");
    const exchanged = await exchangeCode({ code, verifier }, t.deps);
    expect(exchanged.ok).toBe(true);
    if (!exchanged.ok) return;
    const sessionCookie = /(?:__Secure-)?better-auth\.session_token=[^;,\s]+/.exec(exchanged.cookie)?.[0] ?? "";
    expect(sessionCookie).not.toBe("");
    const session = await t.auth.api.getSession({ headers: new Headers({ cookie: sessionCookie }) });
    expect(session?.user.email).toBe("a@example.com");
  });

  it("hands over nothing to a link with no challenge", async () => {
    const t = createTestAuth();
    await userWithGoogle(t);
    const { location } = await t.viaGoogle({ sub: "g-1", email: "a@example.com" }, `${SCHEME}/?state=s3`);
    expect(location.searchParams.get("error")).toBe("missing_challenge");
    expect(location.searchParams.has("code")).toBe(false);
    expect(location.searchParams.has("cookie")).toBe(false);
  });

  it("does not sign in a Google account nobody linked, and hands over nothing", async () => {
    const t = createTestAuth();
    await t.signIn("a@example.com");
    const { location } = await t.viaGoogle(
      { sub: "stranger", email: "stranger@example.com" },
      `${SCHEME}/?state=s4&cc=${challengeOf(newVerifier())}`,
    );
    expect(location.searchParams.has("code")).toBe(false);
    expect(location.searchParams.has("cookie")).toBe(false);
    expect(location.searchParams.get("error")).not.toBeNull();
  });
});

// Login CSRF: the proxy plants a state cookie in whatever browser opens it, so an attacker can make
// a victim's browser finish the attacker's own Google sign-in (his code, his state). Both ways to
// sign that browser in are closed: the proxy only takes a state made for the app, and the callback
// to the app hands the browser no session (the app gets it by the code).
describe("login CSRF through the sign-in proxy", () => {
  const sessionCookiesOf = (setCookie: string[]) =>
    setCookie.filter((cookie) => /session_token=[^;]+/.test(cookie));

  async function attack(callbackURL: string) {
    const t = createTestAuth();
    const own = await t.signIn("attacker@example.com");
    await t.viaGoogle({ sub: "g-att", email: "attacker@example.com" }, `${SCHEME}/?state=link`, own);

    // The attacker starts a sign-in of his own linked Google account, and keeps the state.
    google = { sub: "g-att", email: "attacker@example.com" };
    const start = await t.auth.api.signInSocial({
      body: { provider: "google", callbackURL, errorCallbackURL: callbackURL },
      headers: new Headers(),
      asResponse: true,
    });
    const { url } = (await start.json()) as { url: string };
    const state = new URL(url).searchParams.get("state") ?? "";

    // Victim, link 1: the proxy. Victim, link 2: the callback with the attacker's code and state.
    const planted = await t.auth.handler(
      new Request(`${BASE}/api/auth/expo-authorization-proxy?authorizationURL=${encodeURIComponent(url)}`),
    );
    const callback = await t.auth.handler(
      new Request(`${BASE}/api/auth/callback/google?code=code&state=${state}`, {
        headers: { cookie: cookiesOf(planted) },
      }),
    );
    return { planted, callback };
  }

  it("does not plant the state of a sign-in that returns to the web app", async () => {
    const { planted, callback } = await attack("/");
    expect(planted.status).toBe(400);
    expect(sessionCookiesOf(callback.headers.getSetCookie())).toEqual([]);
    expect(callback.headers.get("location")).toContain("error=state_mismatch");
  });

  it("signs the victim's browser in for neither, when the sign-in returns to the app", async () => {
    const { planted, callback } = await attack(`${SCHEME}/?state=s9&cc=${challengeOf(newVerifier())}`);
    expect(planted.status).toBe(302);
    // The redirect to the app carries the code (the app's own way to the session) ...
    expect(callback.headers.get("location")).toContain("code=");
    // ... and the browser is given no session.
    expect(sessionCookiesOf(callback.headers.getSetCookie())).toEqual([]);
  });
});
