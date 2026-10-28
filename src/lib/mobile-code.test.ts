import { describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { betterAuth } from "better-auth";
import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import { memoryAdapter } from "better-auth/adapters/memory";
import { magicLink } from "better-auth/plugins";
import { googleAuthOptions } from "@/lib/google-auth-options";
import { nativeClientPlugins } from "@/lib/native-clients";
import {
  CODE_TTL_MS,
  challengeOf,
  exchangeCode,
  identifierOf,
  sessionRedirectPlugins,
  setsSession,
  replaceCookieWithCode,
  withoutSessionCookies,
} from "@/lib/mobile-code";

// The real plugin chain of auth.ts (in memory): a sign-in link verified over HTTP must send the
// app a code, never the session.
const BASE = "http://localhost:3000";
const SCHEME = "betterauthmulti://";

function createTestAuth({ withPlugin = true }: { withPlugin?: boolean } = {}) {
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
      ...(withPlugin ? sessionRedirectPlugins() : sessionRedirectPlugins().slice(0, 1)),
    ],
    ...googleAuthOptions(null, { notifyLinked: async () => {} }),
  });

  /** Asks for a sign-in link with this callbackURL and opens it: returns the redirect Response. */
  async function openLink(email: string, callbackURL: string): Promise<Response> {
    await auth.api.signInMagicLink({ body: { email, callbackURL }, headers: new Headers() });
    const token = tokens.get(email);
    if (!token) throw new Error("no magic link token was sent");
    const url = new URL(`${BASE}/api/auth/magic-link/verify`);
    url.searchParams.set("token", token);
    url.searchParams.set("callbackURL", callbackURL);
    return auth.handler(new Request(url, { headers: { origin: BASE } }));
  }

  const consume = async (identifier: string) => {
    const { internalAdapter } = await auth.$context;
    return internalAdapter.consumeVerificationValue(identifier);
  };
  const open = async (sealed: string) => {
    const { secretConfig } = await auth.$context;
    return symmetricDecrypt({ key: secretConfig, data: sealed });
  };
  const seal = async (cookie: string) => {
    const { secretConfig } = await auth.$context;
    return symmetricEncrypt({ key: secretConfig, data: cookie });
  };

  return { auth, openLink, consume, open, seal, deps: { consume, open } };
}

const newVerifier = () => randomBytes(32).toString("base64url");

describe("sessionRedirectPlugins", () => {
  it("keeps expo() first: the code plugin only works on what expo() has already changed", () => {
    expect(sessionRedirectPlugins().map((plugin) => plugin.id)).toEqual(["expo", "mobile-code-exchange"]);
  });
});

describe("the redirect to the app after a sign-in link", () => {
  it("carries a code and no session", async () => {
    const t = createTestAuth();
    const verifier = newVerifier();

    const res = await t.openLink(
      "a@example.com",
      `${SCHEME}/?state=abc&cc=${challengeOf(verifier)}`,
    );

    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location") ?? "");
    expect(location.protocol).toBe("betterauthmulti:");
    expect(location.searchParams.get("state")).toBe("abc");
    expect(location.searchParams.get("code")).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    // Nothing that can be used as a session is in the link.
    expect(location.searchParams.has("cookie")).toBe(false);
    expect(location.searchParams.has("cc")).toBe(false);
    expect(location.toString()).not.toContain("session_token");
  });

  it("is what expo() alone does without this plugin: the cookie is in the link (why the plugin exists)", async () => {
    const t = createTestAuth({ withPlugin: false });
    const res = await t.openLink("a@example.com", `${SCHEME}/?state=abc&cc=${challengeOf(newVerifier())}`);
    expect(new URL(res.headers.get("location") ?? "").searchParams.get("cookie")).toContain("session_token");
  });

  it("hands over no session when the link carries no challenge", async () => {
    const t = createTestAuth();
    for (const callbackURL of [`${SCHEME}/?state=abc`, `${SCHEME}/?state=abc&cc=short`]) {
      const res = await t.openLink(`x${callbackURL.length}@example.com`, callbackURL);
      const location = new URL(res.headers.get("location") ?? "");
      expect(location.searchParams.get("error")).toBe("missing_challenge");
      expect(location.searchParams.has("code")).toBe(false);
      expect(location.searchParams.has("cookie")).toBe(false);
    }
  });

  it("does not touch a redirect to the web app (the browser keeps its cookie as before)", async () => {
    const t = createTestAuth();
    const res = await t.openLink("w@example.com", "/profile");
    expect(res.headers.get("location")).toBe(`${BASE}/profile`);
    expect(res.headers.getSetCookie().join(";")).toContain("session_token");
  });
});

describe("exchanging the code", () => {
  async function signInForCode(t: ReturnType<typeof createTestAuth>, email = "a@example.com") {
    const verifier = newVerifier();
    const res = await t.openLink(email, `${SCHEME}/?state=s&cc=${challengeOf(verifier)}`);
    const code = new URL(res.headers.get("location") ?? "").searchParams.get("code") ?? "";
    return { code, verifier };
  }

  it("gives the session to the app that holds the verifier, and works as a session", async () => {
    const t = createTestAuth();
    const { code, verifier } = await signInForCode(t);

    const result = await exchangeCode({ code, verifier }, t.deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The cookie is the same string expo() used to put in the link: the app stores it as before,
    // and it is a real session.
    const session = await t.auth.api.getSession({ headers: new Headers({ cookie: result.cookie.split(";")[0] }) });
    expect(session?.user.email).toBe("a@example.com");
  });

  it("refuses a code taken from the link without the verifier", async () => {
    const t = createTestAuth();
    const { code } = await signInForCode(t);
    const result = await exchangeCode({ code, verifier: newVerifier() }, t.deps);
    expect(result).toMatchObject({ ok: false });
  });

  it("uses the code up on the first try, so a wrong verifier cannot be retried", async () => {
    const t = createTestAuth();
    const { code, verifier } = await signInForCode(t);
    expect(await exchangeCode({ code, verifier: newVerifier() }, t.deps)).toMatchObject({ ok: false });
    expect(await exchangeCode({ code, verifier }, t.deps)).toMatchObject({ ok: false });
  });

  it("does not give the session twice", async () => {
    const t = createTestAuth();
    const { code, verifier } = await signInForCode(t);
    expect((await exchangeCode({ code, verifier }, t.deps)).ok).toBe(true);
    expect((await exchangeCode({ code, verifier }, t.deps)).ok).toBe(false);
  });

  it("does not accept a code for another sign-in's verifier", async () => {
    const t = createTestAuth();
    const first = await signInForCode(t, "a@example.com");
    const second = await signInForCode(t, "b@example.com");
    expect(await exchangeCode({ code: first.code, verifier: second.verifier }, t.deps)).toMatchObject({ ok: false });
  });

  it("expires after CODE_TTL_MS", async () => {
    const t = createTestAuth();
    const { code, verifier } = await signInForCode(t);
    // Move the stored record's clock: ask for it after its expiry through the same adapter.
    const { internalAdapter } = await t.auth.$context;
    const record = await internalAdapter.findVerificationValue(identifierOf(code));
    expect(record).not.toBeNull();
    expect(record!.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(CODE_TTL_MS);
    expect(record!.expiresAt.getTime() - Date.now()).toBeGreaterThan(CODE_TTL_MS - 5_000);
    // And a record that has expired is refused.
    const old = await replaceCookieWithCode(
      `${SCHEME}/?cookie=x%3Dy&cc=${challengeOf(verifier)}`,
      {
        seal: t.seal,
        store: async (identifier, value, expiresAt) => {
          await internalAdapter.createVerificationValue({ identifier, value, expiresAt });
        },
      },
      new Date(Date.now() - 10 * 60_000),
    );
    const oldCode = new URL(old ?? "").searchParams.get("code") ?? "";
    expect(await exchangeCode({ code: oldCode, verifier }, t.deps)).toMatchObject({ ok: false });
  });

  it("tells the log which check refused, and nothing else (the caller gets one answer)", async () => {
    const t = createTestAuth();
    const { code, verifier } = await signInForCode(t);
    const wrong = await exchangeCode({ code, verifier: newVerifier() }, t.deps);
    expect(wrong).toEqual({ ok: false, why: "verifier-mismatch" });
    const used = await exchangeCode({ code, verifier }, t.deps);
    expect(used).toEqual({ ok: false, why: "unknown-or-used-or-expired" });
    const bad = await exchangeCode({ code: "short", verifier }, t.deps);
    expect(bad).toEqual({ ok: false, why: "malformed" });
    // Nothing secret in what is logged.
    expect(JSON.stringify([wrong, used, bad])).not.toContain(code);
    expect(JSON.stringify([wrong, used, bad])).not.toContain(verifier);
  });

  it("does not keep a usable session in the database: the stored cookie is encrypted", async () => {
    const t = createTestAuth();
    const { code } = await signInForCode(t);
    const { internalAdapter } = await t.auth.$context;
    const record = await internalAdapter.findVerificationValue(identifierOf(code));
    expect(record?.value).toBeTruthy();
    expect(record?.value).not.toContain("session_token");
    expect(record?.value).not.toContain("better-auth");
  });

  it("answers the same when the stored record cannot be opened (a different secret)", async () => {
    const t = createTestAuth();
    const { code, verifier } = await signInForCode(t);
    const result = await exchangeCode(
      { code, verifier },
      { consume: t.consume, open: async () => { throw new Error("wrong key"); } },
    );
    expect(result).toEqual({ ok: false, why: "unreadable-record" });
  });

  it("answers unreadable-record for a stored value that is not what this plugin writes", async () => {
    const t = createTestAuth();
    const verifier = newVerifier();
    const consumeJunk = async () => ({ value: "not json" });
    const result = await exchangeCode({ code: "x".repeat(43), verifier }, { consume: consumeJunk, open: t.open });
    expect(result).toEqual({ ok: false, why: "unreadable-record" });
  });

  it("gives the session to only one of two simultaneous exchanges", async () => {
    const t = createTestAuth();
    const { code, verifier } = await signInForCode(t);
    const results = await Promise.all([
      exchangeCode({ code, verifier }, t.deps),
      exchangeCode({ code, verifier }, t.deps),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });

  it("does not hand over a link with a cookie when the code cannot be stored", async () => {
    const challenge = challengeOf(newVerifier());
    // The failure reaches the caller as an exception: no location (and so no cookie) comes back.
    await expect(
      replaceCookieWithCode(`${SCHEME}/?state=s&cookie=better-auth.session_token%3Dabc&cc=${challenge}`, {
        seal: async (c) => c,
        store: async () => {
          throw new Error("database down");
        },
      }),
    ).rejects.toThrow("database down");
  });

  it("does not keep the code in the database, only a hash of it", async () => {
    const t = createTestAuth();
    const { code } = await signInForCode(t);
    const { internalAdapter } = await t.auth.$context;
    expect(await internalAdapter.findVerificationValue(`mobile-code:${code}`)).toBeNull();
    expect(await internalAdapter.findVerificationValue(identifierOf(code))).not.toBeNull();
  });

  it.each([
    ["no code", { code: undefined, verifier: newVerifier() }],
    ["a code that is not a string", { code: 5, verifier: newVerifier() }],
    ["a short code", { code: "abc", verifier: newVerifier() }],
    ["no verifier", { code: "x".repeat(43), verifier: undefined }],
    ["a short verifier", { code: "x".repeat(43), verifier: "short" }],
    ["a verifier with characters outside the set", { code: "x".repeat(43), verifier: "é".repeat(50) }],
    ["a code nobody issued", { code: randomBytes(32).toString("base64url"), verifier: newVerifier() }],
  ])("refuses %s", async (_label, input) => {
    const t = createTestAuth();
    expect(await exchangeCode(input, t.deps)).toMatchObject({ ok: false });
  });
});

describe("helpers", () => {
  it("computes the challenge the way RFC 7636 does (S256, base64url, no padding)", () => {
    // The example from RFC 7636 appendix B.
    expect(challengeOf("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
    expect(challengeOf("x")).toBe(createHash("sha256").update("x").digest("base64url"));
  });

  it("leaves a redirect to the web, or a link with no cookie (an error redirect), alone", async () => {
    const stored: string[] = [];
    const deps = { seal: async (c: string) => c, store: async (id: string) => void stored.push(id) };
    expect(await replaceCookieWithCode("https://example.com/?cookie=x", deps)).toBeNull();
    expect(await replaceCookieWithCode(`${SCHEME}/?error=INVALID_TOKEN`, deps)).toBeNull();
    expect(await replaceCookieWithCode("not a url", deps)).toBeNull();
    expect(stored).toEqual([]);
  });
});

describe("setsSession", () => {
  it("is true only for a cookie that gives the browser a session", () => {
    expect(setsSession("better-auth.session_token=abc.def; Path=/; HttpOnly")).toBe(true);
    expect(setsSession("__Secure-better-auth.session_token=abc.def; Path=/; Secure")).toBe(true);
    // expo() joins several Set-Cookie headers into one text: the session can come after another.
    expect(setsSession("better-auth.oauth_state=; Max-Age=0; Path=/, better-auth.session_token=abc; Path=/")).toBe(true);
  });

  it("is false for a cookie that only forgets something", () => {
    expect(setsSession("better-auth.oauth_state=; Max-Age=0; Path=/")).toBe(false);
    expect(setsSession("better-auth.session_token=; Max-Age=0; Path=/")).toBe(false);
    expect(setsSession("")).toBe(false);
    expect(setsSession("other.session_token=abc")).toBe(false);
  });

  it("keeps the redirect as it is, minus the cookie, when no session was made", async () => {
    const stored: string[] = [];
    const deps = { seal: async (c: string) => c, store: async (id: string) => void stored.push(id) };
    const next = await replaceCookieWithCode(
      `${SCHEME}/?state=s1&cookie=${encodeURIComponent("better-auth.oauth_state=; Max-Age=0; Path=/")}`,
      deps,
    );
    const url = new URL(next ?? "");
    expect(url.searchParams.get("state")).toBe("s1");
    expect(url.searchParams.has("cookie")).toBe(false);
    expect(url.searchParams.has("code")).toBe(false);
    expect(url.searchParams.has("error")).toBe(false);
    expect(stored).toEqual([]);
  });
});

describe("withoutSessionCookies", () => {
  it("drops the cookies that sign a browser in, and keeps the rest", () => {
    expect(
      withoutSessionCookies([
        "better-auth.session_token=abc.sig; Path=/; HttpOnly",
        "__Secure-better-auth.session_token=abc.sig; Path=/; Secure",
        "better-auth.session_data=eyJ; Path=/",
        "better-auth.dont_remember=true; Path=/",
        "better-auth.state=s.sig; Path=/",
      ]),
    ).toEqual(["better-auth.state=s.sig; Path=/"]);
  });

  it("keeps a cookie that only deletes a session", () => {
    const deleting = "better-auth.session_token=; Max-Age=0; Path=/";
    expect(withoutSessionCookies([deleting])).toEqual([deleting]);
  });
});
