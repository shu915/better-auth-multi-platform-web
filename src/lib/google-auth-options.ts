import type { BetterAuthOptions } from "better-auth";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import type { GoogleCredentials } from "@/lib/google-oauth";

// How recently the user must have signed in to link a sign-in method or unlink one. Both are
// the actions a stolen session would abuse (an attacker linking their own Google account keeps
// access after the stolen session ends), so this is short, not Better Auth's 1 day default.
// It is the session's freshAge, so any other operation that asks for a fresh session (changing
// the email, say) gets this 5 minutes too.
export const FRESH_SESSION_SECONDS = 5 * 60;

export type LinkedNotice = { to: string; provider: string };

// Deleting the account and changing the profile have rules that live in our Server Actions: the
// typed-email check, the Go API data, the notice email, the field validation. Better Auth also
// serves these two endpoints over HTTP (/api/auth/delete-user and /update-user), where none of
// those rules apply, so a session cookie alone could delete the user and skip them all. Over HTTP
// they are refused. The Server Actions call auth.api.* from our own server code, which has no
// incoming request, and keep working. The browser client never calls these.
// /token is on the list for a different reason: it hands out the JWT for the Go API to anyone with
// the session cookie, but the JWT is meant to stay on our server (callApi issues it per call). A
// stolen session or a script on the page could otherwise take a JWT and call the Go API directly,
// without the fresh-login check that the account actions need. /jwks (the public keys the Go
// API fetches) stays public. /get-access-token and /refresh-token would hand out the stored Google
// tokens to anyone with the cookie; nothing here uses them.
// A native app (Expo) has no server of ours to call the Go API for it, so it gets its own JWT from
// /token, and only that endpoint has an exception: see isBearerOnly.
const SERVER_ONLY_PATHS = new Set([
  "/delete-user",
  "/update-user",
  "/token",
  "/get-access-token",
  "/refresh-token",
]);

// Native apps may call /token over HTTP when the request is authenticated by a bearer token and
// by nothing else: an Authorization: Bearer header and NO Cookie header.
// Both parts matter: the bearer plugin ignores an invalid bearer token and falls back to the
// request's own cookie, so a bearer header alone would prove nothing. With no Cookie header, success
// needs a valid signed session token in the header.
// This relies on the signed token appearing nowhere a page can read (native-clients.ts) and on the
// JWT being issued nowhere else (jwt-plugin.ts). The tests under "endpoints that only our Server
// Actions may call" check each of these.
// Same test as the bearer plugin's own: the scheme "bearer " (any case) and a non-empty token.
function hasBearer(request: Request): boolean {
  const authorization = request.headers.get("authorization") ?? "";
  return authorization.slice(0, 7).toLowerCase() === "bearer " && authorization.slice(7).trim() !== "";
}

export function isBearerOnly(request: Request): boolean {
  return hasBearer(request) && !request.headers.get("cookie");
}

// Where the native app's sign-in proxy may send the browser: Google's authorization endpoint, and
// nowhere else. The proxy (/expo-authorization-proxy, from the expo plugin) checks only that the
// address is https and not our own, so anyone could use our domain to redirect a user to any site.
// Rules (the client_id and redirect_uri are checked below, with the size limits):
//  - the parsed origin is Google's, so "https://accounts.google.com@evil.example" is judged by the
//    host the browser would really go to;
//  - the path is the authorization endpoint, not anything else on accounts.google.com (such as
//    /logout?continue=...);
//  - the text is already in its parsed form (`href`). The plugin puts the text we were given into
//    the Location header, not the parsed one, and a parser that reads "\" or a tab differently from
//    the browser would send the user elsewhere. A backslash, tab, line break or upper-case host
//    changes `href`, so it is refused.
const GOOGLE_AUTHORIZATION_ORIGIN = "https://accounts.google.com";
const GOOGLE_AUTHORIZATION_PATH = "/o/oauth2/v2/auth";

// Google's page can be asked for with anyone's client_id and redirect_uri. Without these two, a link
// on our domain could lead to the consent screen of an attacker's app. Both must be ours: the
// address Better Auth itself builds (`/sign-in/social`) is the only one that passes.
export type ExpectedGoogleRequest = { clientId: string; redirectUri: string };

// A real Google address is a few hundred characters; this only stops absurd input.
const MAX_AUTHORIZATION_URL_LENGTH = 2048;

export function isGoogleAuthorizationUrl(
  value: unknown,
  expected: ExpectedGoogleRequest,
): boolean {
  if (typeof value !== "string" || value.includes("#")) return false;
  if (value.length > MAX_AUTHORIZATION_URL_LENGTH) return false;
  try {
    const url = new URL(value);
    return (
      url.origin === GOOGLE_AUTHORIZATION_ORIGIN &&
      url.pathname === GOOGLE_AUTHORIZATION_PATH &&
      url.href === value &&
      url.searchParams.getAll("client_id").join() === expected.clientId &&
      url.searchParams.getAll("redirect_uri").join() === expected.redirectUri
    );
  } catch {
    return false;
  }
}

// `oauthState` is a value the native app read back from its own storage (a cookie's value) and
// the plugin writes into a cookie. Its format is Better Auth's, so only the size is limited, and
// whatever could break a cookie out of its value (a separator, a quote, white space, a control
// character) is refused.
const MAX_OAUTH_STATE_LENGTH = 512;

export function isSafeOauthState(value: unknown): boolean {
  if (value === undefined) return true;
  if (
    typeof value !== "string" ||
    value === "" ||
    value.length > MAX_OAUTH_STATE_LENGTH
  ) {
    return false;
  }
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x20 || code === 0x7f || ';,"\\'.includes(char)) return false;
  }
  return true;
}

// Runs before every Better Auth endpoint. Three jobs: refuse the server-only endpoints over HTTP,
// keep the native sign-in proxy on Google, and make linking need a recent sign-in, like unlinking
// already does. No session at all is left to the endpoint's own check, which answers 401.
const guardAccountEndpoints = createAuthMiddleware(async (ctx) => {
  if (SERVER_ONLY_PATHS.has(ctx.path) && ctx.request !== undefined) {
    // The one exception: /token for a bearer-only request (a native app). Everything else on the
    // list stays server-only, bearer or not.
    if (ctx.path === "/token" && isBearerOnly(ctx.request)) return;
    throw APIError.from("FORBIDDEN", {
      message: "This action is not available over HTTP",
      code: "SERVER_ONLY",
    });
  }
  // A bearer token is accepted at /token only. This guard runs before the bearer plugin turns the
  // header into a session, so checks made here on the session (the fresh-login check below) would
  // not see it. Refusing the header outside /token keeps those checks meaningful. Native apps send
  // their cookie as a Cookie header.
  if (ctx.request !== undefined && ctx.path !== "/token" && hasBearer(ctx.request)) {
    throw APIError.from("FORBIDDEN", {
      message: "A bearer token is only accepted at /token",
      code: "BEARER_ONLY_FOR_TOKEN",
    });
  }
  if (ctx.path === "/expo-authorization-proxy") {
    // Our own Google app's id (from the options googleAuthOptions sets). With Google off there is
    // nothing to send anyone to, so the proxy is closed.
    const provider = ctx.context.options.socialProviders?.google;
    // (Better Auth also accepts a function here; googleAuthOptions below always sets an object.)
    const clientId = typeof provider === "object" ? provider.clientId : undefined;
    const ours =
      typeof clientId === "string" && clientId !== ""
        ? {
            clientId,
            // The address Better Auth gives Google as the callback (see its google provider).
            redirectUri: `${ctx.context.baseURL}/callback/google`,
          }
        : null;
    if (
      ours === null ||
      !isGoogleAuthorizationUrl(ctx.query?.authorizationURL, ours) ||
      !isSafeOauthState(ctx.query?.oauthState)
    ) {
      throw APIError.from("BAD_REQUEST", {
        message: "Invalid authorizationURL",
        code: "INVALID_AUTHORIZATION_URL",
      });
    }
  }
  if (ctx.path !== "/link-social") return;
  const session = await getSessionFromCtx(ctx);
  if (!session?.session) return;
  const freshAge = ctx.context.sessionConfig.freshAge;
  if (freshAge === 0) return;
  const age = Date.now() - new Date(session.session.createdAt).getTime();
  if (age >= freshAge * 1000) {
    throw APIError.from("FORBIDDEN", {
      message: "Session is not fresh",
      code: "SESSION_NOT_FRESH",
    });
  }
});

// The Better Auth options that make Google an optional extra way to sign in for a user the
// magic link already created. Kept apart from auth.ts so a test can build an auth instance
// with exactly these options and a different database.
//
// `notifyLinked` tells the user's own email address that a sign-in method was linked, so a
// link they did not make gets noticed.
export function googleAuthOptions(
  google: GoogleCredentials | null,
  { notifyLinked }: { notifyLinked: (notice: LinkedNotice) => Promise<void> },
) {
  return {
    // Google can never create a user.
    ...(google && { socialProviders: { google: { ...google, disableSignUp: true } } }),
    account: {
      accountLinking: {
        // A Google login never links itself to a user by matching emails; the user links it
        // explicitly with linkSocial() while signed in.
        disableImplicitLinking: true,
        // The Google account may use a different email than the root user's. Safe here because
        // linking needs the signed-in session. Better Auth warns that this can enable account
        // takeover if a link is ever possible without a session.
        allowDifferentEmails: true,
        // Magic link keeps working without any linked account, so unlinking Google (which can
        // be the only account row) cannot lock the user out. Without this, Better Auth refuses
        // to unlink a user's last account.
        allowUnlinkingAll: true,
      },
    },
    // Account deletion. Better Auth removes the user's sessions and linked accounts (Google)
    // with the user. Without a password or a verification mail, it asks for a fresh session,
    // which is the same freshAge as linking.
    user: { deleteUser: { enabled: true } },
    session: { freshAge: FRESH_SESSION_SECONDS },
    hooks: { before: guardAccountEndpoints },
    databaseHooks: {
      account: {
        create: {
          after: async (account, context) => {
            // A failed notification must not make the link itself look failed.
            try {
              const user = await context?.context.internalAdapter.findUserById(account.userId);
              if (user) await notifyLinked({ to: user.email, provider: account.providerId });
            } catch (err) {
              console.error("[auth] failed to notify about a linked account", err);
            }
          },
        },
      },
    },
  } satisfies Partial<BetterAuthOptions>;
}
