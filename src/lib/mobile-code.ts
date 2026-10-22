import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
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

/** What is stored under a code. Only a hash of the code is the key: the code is not in the database. */
export const identifierOf = (code: string) => CODE_PREFIX + sha256(code).toString("base64url");

type Stored = { cookie: string; challenge: string };

function parseStored(value: string): Stored | null {
  try {
    const raw: unknown = JSON.parse(value);
    if (typeof raw !== "object" || raw === null) return null;
    const { cookie, challenge } = raw as Record<string, unknown>;
    if (typeof cookie === "string" && cookie !== "" && isChallenge(challenge)) {
      return { cookie, challenge };
    }
  } catch {
    // fall through
  }
  return null;
}

export type ExchangeDeps = {
  /** Reads and deletes in one step (Better Auth's consumeVerificationValue): usable once. */
  consume: (identifier: string) => Promise<{ value: string } | null>;
};

export type ExchangeResult = { ok: true; cookie: string } | { ok: false };

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
    return { ok: false };
  }
  const record = await deps.consume(identifierOf(code));
  if (!record) return { ok: false };
  const stored = parseStored(record.value);
  if (!stored) return { ok: false };
  const expected = Buffer.from(stored.challenge);
  const actual = Buffer.from(challengeOf(verifier));
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return { ok: false };
  return { ok: true, cookie: stored.cookie };
}

/**
 * Rewrites the redirect to the app's deep link: the "cookie" parameter that expo() added goes, a
 * "code" takes its place. Returns the new location, or null when there is nothing to do (a web
 * redirect, or a link with no cookie such as an error redirect).
 * `store` saves what the code stands for and returns nothing: it is given the finished record.
 */
export async function replaceCookieWithCode(
  location: string,
  store: (identifier: string, value: string, expiresAt: Date) => Promise<void>,
  now: Date = new Date(),
): Promise<string | null> {
  let url: URL;
  try {
    url = new URL(location);
  } catch {
    return null;
  }
  if (url.protocol === "http:" || url.protocol === "https:") return null;
  const cookie = url.searchParams.get("cookie");
  if (cookie === null) return null;
  const challenge = url.searchParams.get("cc");

  url.searchParams.delete("cookie");
  url.searchParams.delete("cc");

  // No (valid) challenge: the app is not one of ours, or an old one. No session is handed over.
  if (!isChallenge(challenge)) {
    url.searchParams.set("error", "missing_challenge");
    return url.toString();
  }

  const code = randomBytes(32).toString("base64url");
  await store(
    identifierOf(code),
    JSON.stringify({ cookie, challenge } satisfies Stored),
    new Date(now.getTime() + CODE_TTL_MS),
  );
  url.searchParams.set("code", code);
  return url.toString();
}

// The paths where expo() adds the cookie to the redirect.
const redirectsWithSession = (path: string | undefined) =>
  !!path &&
  (path.startsWith("/callback") || path.startsWith("/magic-link/verify") || path.startsWith("/verify-email"));

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
            const next = await replaceCookieWithCode(location, async (identifier, value, expiresAt) => {
              await ctx.context.internalAdapter.createVerificationValue({ identifier, value, expiresAt });
            });
            if (next !== null) ctx.setHeader("location", next);
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
