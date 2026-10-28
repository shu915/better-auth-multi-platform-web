import { describe, expect, it } from "vitest";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import {
  googleAuthOptions,
  isGoogleAuthorizationUrl,
  isSafeOauthState,
} from "@/lib/google-auth-options";
import { nativeClientPlugins } from "@/lib/native-clients";
import { sessionRedirectPlugins } from "@/lib/mobile-code";

// The native app opens /api/auth/expo-authorization-proxy in the browser to start Google's sign-in.
// The expo plugin's own check lets any https address through, so our guard narrows it to the one
// address Better Auth builds for our own Google app.

const BASE = "http://localhost:3000";
const OURS = {
  clientId: "client-id",
  redirectUri: `${BASE}/api/auth/callback/google`,
};
const AUTH = "https://accounts.google.com/o/oauth2/v2/auth";

function googleUrl(params: Record<string, string>): string {
  return `${AUTH}?${new URLSearchParams(params)}`;
}
const GOOGLE = googleUrl({
  client_id: OURS.clientId,
  redirect_uri: OURS.redirectUri,
  state: "abc",
});

describe("isGoogleAuthorizationUrl", () => {
  it("accepts our own Google request", () => {
    expect(isGoogleAuthorizationUrl(GOOGLE, OURS)).toBe(true);
  });

  it("judges by the host the browser really goes to", () => {
    // A backslash counts as a slash, so this is Google (the rest is a path); it is refused anyway,
    // because the text is not in its parsed form (the plugin would put the text in Location).
    expect(
      isGoogleAuthorizationUrl(
        "https://accounts.google.com\\@evil.example/o/oauth2/v2/auth",
        OURS,
      ),
    ).toBe(false);
  });

  it("refuses every other place", () => {
    for (const value of [
      "https://evil.example/",
      "https://accounts.google.com.evil.example/",
      "https://evil.example/accounts.google.com",
      "https://accounts.google.com@evil.example/",
      "http://accounts.google.com/o/oauth2/v2/auth",
      "https://accounts.google.com:8443/o/oauth2/v2/auth",
      "https://accounts.google.com/Logout?continue=https://evil.example",
      "https://accounts.google.com/o/oauth2/v2/auth#x",
      "https://ACCOUNTS.google.com/o/oauth2/v2/auth",
      "//accounts.google.com/",
      "javascript:alert(1)",
      "",
      "not a url",
      undefined,
      42,
    ]) {
      expect(isGoogleAuthorizationUrl(value, OURS), String(value)).toBe(false);
    }
  });

  it("refuses Google's page asked for by someone else's app", () => {
    const other = {
      client_id: "attacker-app",
      redirect_uri: OURS.redirectUri,
      state: "abc",
    };
    expect(isGoogleAuthorizationUrl(googleUrl(other), OURS)).toBe(false);
    const elsewhere = {
      client_id: OURS.clientId,
      redirect_uri: "https://evil.example/cb",
      state: "abc",
    };
    expect(isGoogleAuthorizationUrl(googleUrl(elsewhere), OURS)).toBe(false);
    // Repeated parameters: Google could read the other one.
    expect(
      isGoogleAuthorizationUrl(`${GOOGLE}&client_id=attacker-app`, OURS),
    ).toBe(false);
    expect(
      isGoogleAuthorizationUrl(
        `${GOOGLE}&redirect_uri=https%3A%2F%2Fevil.example%2Fcb`,
        OURS,
      ),
    ).toBe(false);
    expect(isGoogleAuthorizationUrl(googleUrl({ state: "abc" }), OURS)).toBe(
      false,
    );
  });

  it("refuses an absurdly long address", () => {
    expect(
      isGoogleAuthorizationUrl(`${GOOGLE}&x=${"a".repeat(3000)}`, OURS),
    ).toBe(false);
  });
});

describe("isSafeOauthState", () => {
  it("accepts a missing value and an ordinary one", () => {
    expect(isSafeOauthState(undefined)).toBe(true);
    expect(isSafeOauthState("abc.DEF-123_%2B%3D")).toBe(true);
  });

  it("refuses what could break out of a cookie, and what is too long", () => {
    for (const value of [
      "",
      "a;b",
      "a,b",
      "a b",
      'a"b',
      "a\\b",
      "a\nb",
      "a\tb",
      "a\u0000b",
      "a".repeat(513),
      5,
    ]) {
      expect(isSafeOauthState(value), JSON.stringify(value)).toBe(false);
    }
  });
});

function createTestAuth(
  google: { clientId: string; clientSecret: string } | null,
) {
  return betterAuth({
    baseURL: BASE,
    secret: "test-secret-test-secret-test-secret-123456",
    trustedOrigins: ["betterauthmulti://"],
    database: memoryAdapter({
      user: [],
      session: [],
      account: [],
      verification: [],
      jwks: [],
    }),
    plugins: [...nativeClientPlugins(), ...sessionRedirectPlugins()],
    ...googleAuthOptions(google, { notifyLinked: async () => {} }),
  });
}

const ENABLED = { clientId: OURS.clientId, clientSecret: "client-secret" };

function proxy(
  auth: ReturnType<typeof createTestAuth>,
  authorizationURL: string,
  oauthState?: string,
) {
  const query =
    `authorizationURL=${encodeURIComponent(authorizationURL)}` +
    (oauthState === undefined
      ? ""
      : `&oauthState=${encodeURIComponent(oauthState)}`);
  return auth.handler(
    new Request(`${BASE}/api/auth/expo-authorization-proxy?${query}`),
  );
}

describe("/expo-authorization-proxy", () => {
  it("passes the address Better Auth itself builds for sign-in", async () => {
    // The real thing, not a made-up address: what the native app is given by /sign-in/social.
    const auth = createTestAuth(ENABLED);
    const { url } = await auth.api.signInSocial({
      body: { provider: "google", callbackURL: "betterauthmulti://" },
    });
    expect(url).toBeTruthy();
    const res = await proxy(auth, url ?? "");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(url);
    expect(
      res.headers
        .getSetCookie()
        .map((cookie) => cookie.split("=")[0])
        .join(";"),
    ).toContain("better-auth.state");
  });

  it("passes the oauthState route, and sets the oauth_state cookie", async () => {
    const res = await proxy(createTestAuth(ENABLED), GOOGLE, "abc.def");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(GOOGLE);
    expect(
      res.headers.getSetCookie().map((cookie) => cookie.split("=")[0]),
    ).toContain("better-auth.oauth_state");
  });

  it("does not redirect to another site or another app, and sets no cookie", async () => {
    const auth = createTestAuth(ENABLED);
    // With a state in the address, and with the oauthState parameter: the plugin has two paths.
    for (const target of [
      "https://evil.example/phish?state=abc",
      "https://accounts.google.com.evil.example/?state=abc",
      googleUrl({
        client_id: "attacker-app",
        redirect_uri: OURS.redirectUri,
        state: "abc",
      }),
    ]) {
      for (const oauthState of [undefined, "abc"]) {
        const res = await proxy(auth, target, oauthState);
        expect(res.status, `${target} ${oauthState}`).toBe(400);
        expect(res.headers.get("location")).toBeNull();
        expect(res.headers.getSetCookie()).toEqual([]);
      }
    }
  });

  it("refuses an oauthState that could break a cookie", async () => {
    const res = await proxy(
      createTestAuth(ENABLED),
      GOOGLE,
      "abc; Path=/; Domain=evil.example",
    );
    expect(res.status).toBe(400);
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it("is closed when Google is off", async () => {
    const res = await proxy(createTestAuth(null), GOOGLE);
    expect(res.status).toBe(400);
    expect(res.headers.getSetCookie()).toEqual([]);
  });
});
