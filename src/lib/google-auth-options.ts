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
// tokens to anyone with the cookie; nothing here uses them. When a desktop or mobile client has to call the Go API directly,
// this is the rule to revisit.
const SERVER_ONLY_PATHS = new Set([
  "/delete-user",
  "/update-user",
  "/token",
  "/get-access-token",
  "/refresh-token",
]);

// Runs before every Better Auth endpoint. Two jobs: refuse the server-only endpoints over HTTP,
// and make linking need a recent sign-in, like unlinking already does. No session at all is left
// to the endpoint's own check, which answers 401.
const guardAccountEndpoints = createAuthMiddleware(async (ctx) => {
  if (SERVER_ONLY_PATHS.has(ctx.path) && ctx.request !== undefined) {
    throw APIError.from("FORBIDDEN", {
      message: "This action is not available over HTTP",
      code: "SERVER_ONLY",
    });
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
