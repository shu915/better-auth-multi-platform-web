import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { symmetricEncrypt } from "better-auth/crypto";
import { expo } from "@better-auth/expo";

// Handing the session to the native app without putting it in a URL.
//
// Better Auth's expo() plugin, after a sign-in link (or an OAuth callback) redirects to the app's
// deep link (betterauthmulti://...), appends the session cookie to that link as "?cookie=...".
// Any app on the phone can register the same custom scheme and read it. So this plugin, placed
// after expo(), takes the cookie out of the link and puts a short-lived one-time CODE there
// instead. The app trades the code for the session at POST /api/mobile/exchange, proving it is the
// app that asked for the sign-in with a secret (the verifier) that never travelled in a link:
// this is PKCE (RFC 7636). A code taken from a link is worthless without the verifier.
//
//   app:   verifier = random; challenge = base64url(SHA-256(verifier))
//          asks for the sign-in link with callbackURL "/?state=...&cc=<challenge>"
//   here:  after the link is verified, "?cookie=..." becomes "?code=..." (stored, bound to the
//          challenge, valid for CODE_TTL_MS, usable once)
//   app:   POST /api/mobile/exchange { code, verifier } -> { cookie }
//
// The code travels in the deep link, and the browser has to open the app for it to arrive. A
// browser can refuse to (it asks, or it stops asking after a few tries on a desktop), and then the
// app never sees the code. So the same record is also stored under the sign-in's `state` (the app
// made it and keeps it): the app can ask for it by state, with the same verifier, while it waits:
//   app:   POST /api/mobile/exchange-state { state, verifier } -> { cookie } or "not yet"
// The state alone gets no session (the verifier is the proof, as for the code). It is seen in more
// places than the code (the sign-in mail's address, the proxy's address), so someone who knows it
// can only make the sign-in fail, not take the session. The two records are independent: both hold the same session, and both need the
// verifier.

export const CODE_TTL_MS = 60_000;
export const CODE_PREFIX = "mobile-code:";

const sha256 = (value: string) => createHash("sha256").update(value).digest();

/** base64url(SHA-256(verifier)): what the app sends as "cc" and what the exchange recomputes. */
export const challengeOf = (verifier: string) => sha256(verifier).toString("base64url");

// 43 characters: the base64url of a SHA-256 digest, no padding.
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
export const isChallenge = (value: unknown): value is string =>
  typeof value === "string" && CHALLENGE.test(value);

// RFC 7636: 43 to 128 characters of the unreserved set.
const VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;
export const isVerifier = (value: unknown): value is string =>
  typeof value === "string" && VERIFIER.test(value);

export const STATE_PREFIX = "mobile-state:";

// The app's own state: made by the app (hex or base64url), long enough to be unguessable.
const STATE = /^[A-Za-z0-9_-]{16,128}$/;
export const isState = (value: unknown): value is string =>
  typeof value === "string" && STATE.test(value);

/** What is stored under a state. Only a hash of the state is the key. */
export const stateIdentifierOf = (state: string) =>
  STATE_PREFIX + sha256(state).toString("base64url");

/** What is stored under a code. Only a hash of the code is the key: the code is not in the database. */
export const identifierOf = (code: string) => CODE_PREFIX + sha256(code).toString("base64url");

// `sealed` is the session cookie encrypted with the server's secret (see `seal`): what is stored is
// not usable as a session by anyone who can read the database.
type Stored = { sealed: string; challenge: string };

function parseStored(value: string): Stored | null {
  try {
    const raw: unknown = JSON.parse(value);
    if (typeof raw !== "object" || raw === null) return null;
    const { sealed, challenge } = raw as Record<string, unknown>;
    if (typeof sealed === "string" && sealed !== "" && isChallenge(challenge)) {
      return { sealed, challenge };
    }
  } catch {
    // fall through
  }
  return null;
}

export type ExchangeDeps = {
  /** Reads and deletes in one step (Better Auth's consumeVerificationValue): usable once. */
  consume: (identifier: string) => Promise<{ value: string } | null>;
  /** Undoes `seal`. Throws when the text was not sealed by this server. */
  open: (sealed: string) => Promise<string>;
};

// `why` is for the server's log only (never sent to the caller, who gets one answer for every
// failure): which check refused. It holds no secret.
export type ExchangeFailure =
  | "malformed"
  | "unknown-or-used-or-expired"
  | "unreadable-record"
  | "verifier-mismatch";
export type ExchangeResult = { ok: true; cookie: string } | { ok: false; why: ExchangeFailure };

/**
 * Trades a code and the verifier for the session cookie. Every failure is the same answer, and the
 * code is used up by the first attempt whatever the verifier, so a wrong verifier cannot be retried.
 */
export async function exchangeCode(
  input: { code: unknown; verifier: unknown },
  deps: ExchangeDeps,
): Promise<ExchangeResult> {
  const { code, verifier } = input;
  if (typeof code !== "string" || code.length < 20 || code.length > 100 || !isVerifier(verifier)) {
    return { ok: false, why: "malformed" };
  }
  const record = await deps.consume(identifierOf(code));
  if (!record) return { ok: false, why: "unknown-or-used-or-expired" };
  const stored = parseStored(record.value);
  if (!stored) return { ok: false, why: "unreadable-record" };
  const expected = Buffer.from(stored.challenge);
  const actual = Buffer.from(challengeOf(verifier));
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return { ok: false, why: "verifier-mismatch" };
  }
  try {
    return { ok: true, cookie: await deps.open(stored.sealed) };
  } catch {
    return { ok: false, why: "unreadable-record" };
  }
}

export type StateExchangeFailure = "malformed" | "unreadable-record" | "verifier-mismatch";
export type StateExchangeResult =
  | { ok: true; cookie: string }
  // Nothing under this state (yet): the sign-in is not finished, or it was used or expired. Nothing
  // is used up by asking, so the app can ask again.
  | { ok: false; pending: true }
  | { ok: false; pending: false; why: StateExchangeFailure };

/**
 * The same trade as exchangeCode, asked for by state. A state with nothing stored is "not yet" (the
 * app asks every few seconds while the browser is open). Once a record is found it is used up by the
 * first attempt whatever the verifier, like a code: a wrong verifier cannot be retried.
 */
export async function exchangeState(
  input: { state: unknown; verifier: unknown },
  deps: ExchangeDeps,
): Promise<StateExchangeResult> {
  const { state, verifier } = input;
  if (!isState(state) || !isVerifier(verifier)) {
    return { ok: false, pending: false, why: "malformed" };
  }
  const record = await deps.consume(stateIdentifierOf(state));
  if (!record) return { ok: false, pending: true };
  const stored = parseStored(record.value);
  if (!stored) return { ok: false, pending: false, why: "unreadable-record" };
  const expected = Buffer.from(stored.challenge);
  const actual = Buffer.from(challengeOf(verifier));
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return { ok: false, pending: false, why: "verifier-mismatch" };
  }
  try {
    return { ok: true, cookie: await deps.open(stored.sealed) };
  } catch {
    return { ok: false, pending: false, why: "unreadable-record" };
  }
}

// Whether this Set-Cookie text gives the browser a session (a non-empty session token). A cookie
// that only deletes one (Max-Age=0, empty value) does not. expo() joins several Set-Cookie headers
// into one text, so the name can come after a comma.
const SESSION_COOKIE = /(?:^|[,\s])(?:__Secure-)?better-auth\.session_token=([^;,\s]+)/;
export const setsSession = (setCookie: string): boolean => SESSION_COOKIE.test(setCookie);

/**
 * A redirect to the desktop app's own local receiver (RFC 8252, "loopback"): `http://127.0.0.1:<port>/…`.
 * The address is the literal 127.0.0.1 (not "localhost", which a resolver could point elsewhere), a
 * plain http URL with a port, and nothing else (no user name, no password). The port is the app's own
 * choice for each sign-in. Such a redirect is to the app on this machine like a deep link is, so the
 * session goes by the code and not in the browser. Anything else on http(s) is a web page.
 */
export function isLoopbackUrl(url: URL): boolean {
  return (
    url.protocol === "http:" &&
    url.hostname === "127.0.0.1" &&
    /^[0-9]{1,5}$/.test(url.port) &&
    url.username === "" &&
    url.password === ""
  );
}

/**
 * Rewrites the redirect to the app's deep link: the "cookie" parameter that expo() added goes, a
 * "code" takes its place. Returns the new location, or null when there is nothing to do (a web
 * redirect, or a link with no cookie such as an error redirect).
 * `store` saves what the code stands for and returns nothing: it is given the finished record.
 */
export async function replaceCookieWithCode(
  location: string,
  deps: {
    /** Encrypts the cookie before it is stored (Better Auth's symmetricEncrypt with the secret). */
    seal: (cookie: string) => Promise<string>;
    store: (identifier: string, value: string, expiresAt: Date) => Promise<void>;
  },
  now: Date = new Date(),
): Promise<string | null> {
  let url: URL;
  try {
    url = new URL(location);
  } catch {
    return null;
  }
  if ((url.protocol === "http:" || url.protocol === "https:") && !isLoopbackUrl(url)) return null;
  const cookie = url.searchParams.get("cookie");
  if (cookie === null) return null;
  const challenge = url.searchParams.get("cc");

  url.searchParams.delete("cookie");
  url.searchParams.delete("cc");

  // No session was made (linking an account to a user who is already signed in, a refused or
  // cancelled sign-in): the cookie only forgets the OAuth state, and there is nothing to hand over.
  // The link goes on without it, with no code and no error: the app is not waiting for a session.
  if (!setsSession(cookie)) return url.toString();

  // No (valid) challenge: the app is not one of ours, or an old one. No session is handed over.
  if (!isChallenge(challenge)) {
    url.searchParams.set("error", "missing_challenge");
    return url.toString();
  }

  const code = randomBytes(32).toString("base64url");
  const record = JSON.stringify({ sealed: await deps.seal(cookie), challenge } satisfies Stored);
  const expiresAt = new Date(now.getTime() + CODE_TTL_MS);
  await deps.store(identifierOf(code), record, expiresAt);
  // The same record by the app's state, for an app whose browser did not open it (see the top).
  const state = url.searchParams.get("state");
  if (isState(state)) await deps.store(stateIdentifierOf(state), record, expiresAt);
  url.searchParams.set("code", code);
  return url.toString();
}

// The cookies that make a browser signed in: the session token, the session cache and the
// "don't remember me" flag. A cookie that only deletes one (empty value) is kept.
const SESSION_COOKIE_NAME = /^(?:__Secure-)?better-auth\.(?:session_token|session_data|dont_remember)=([^;]*)/;

/**
 * The Set-Cookie headers of a redirect to the app, without the ones that sign the browser in. The
 * app gets its session through the code, and the browser has no use for it. Left in, a callback
 * opened in a browser whose OAuth state cookie matches (see isNativeAppState) would sign that
 * browser in, as whoever the code belongs to.
 */
export function withoutSessionCookies(setCookies: string[]): string[] {
  return setCookies.filter((cookie) => {
    const match = SESSION_COOKIE_NAME.exec(cookie);
    return match === null || match[1] === "";
  });
}

// The paths where expo() adds the cookie to the redirect.
const redirectsWithSession = (path: string | undefined) =>
  !!path &&
  (path.startsWith("/callback") || path.startsWith("/magic-link/verify") || path.startsWith("/verify-email"));

/**
 * For a redirect to the loopback receiver: the same "?cookie=<Set-Cookie>" that expo() puts on a deep
 * link, so that replaceCookieWithCode can turn it into a code. Other locations are returned as they are.
 */
export function withCookieForLoopback(location: string, setCookie: string | null): string {
  let url: URL;
  try {
    url = new URL(location);
  } catch {
    return location;
  }
  if (!isLoopbackUrl(url) || setCookie === null) return location;
  url.searchParams.set("cookie", setCookie);
  return url.toString();
}

/** Must come AFTER expo() in the plugin list: it reads the redirect that expo() has changed. */
export function mobileCodeExchange(): BetterAuthPlugin {
  return {
    id: "mobile-code-exchange",
    hooks: {
      after: [
        {
          matcher: (context) => redirectsWithSession(context.path),
          handler: createAuthMiddleware(async (ctx) => {
            const location = ctx.context.responseHeaders?.get("location");
            if (!location) return;
            // expo() adds the session as "?cookie=" only for a deep link, never for http. A redirect
            // to the app's loopback receiver is handled the same way, so the cookie is added here.
            const toReplace = withCookieForLoopback(location, ctx.context.responseHeaders?.get("set-cookie") ?? null);
            const next = await replaceCookieWithCode(toReplace, {
              seal: (cookie) => symmetricEncrypt({ key: ctx.context.secretConfig, data: cookie }),
              store: async (identifier, value, expiresAt) => {
                await ctx.context.internalAdapter.createVerificationValue({ identifier, value, expiresAt });
              },
            });
            if (next === null) return;
            ctx.setHeader("location", next);
            // To the app: the session goes by the code only, so the browser keeps none.
            const headers = ctx.context.responseHeaders;
            if (headers) {
              const kept = withoutSessionCookies(headers.getSetCookie());
              headers.delete("set-cookie");
              for (const cookie of kept) headers.append("set-cookie", cookie);
            }
          }),
        },
      ],
    },
  };
}

/**
 * expo() and mobileCodeExchange() in the one order that works, defined once so auth.ts and the tests
 * use the same list. Put the other way round, the hook finds no cookie to replace, expo() adds it
 * afterwards, and the session is back in the link with every test still green: the test
 * "keeps expo() first" checks the order.
 */
export const sessionRedirectPlugins = (): BetterAuthPlugin[] => [expo(), mobileCodeExchange()];
