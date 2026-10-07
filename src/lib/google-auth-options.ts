import type { BetterAuthOptions } from "better-auth";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import type { GoogleCredentials } from "@/lib/google-oauth";

// How recently the user must have signed in to link a sign-in method or unlink one. Both are
// the actions a stolen session would abuse (an attacker linking their own Google account keeps
// access after the stolen session ends), so this is short, not Better Auth's 1 day default.
// It is the session's freshAge, so any other operation that asks for a fresh session (changing
// the email, say) gets this 10 minutes too.
export const FRESH_SESSION_SECONDS = 10 * 60;

export type LinkedNotice = { to: string; provider: string };

// Linking needs a recent sign-in, like unlinking already does. No session at all is left to
// the endpoint's own check, which answers 401.
const requireFreshSessionToLink = createAuthMiddleware(async (ctx) => {
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
    session: { freshAge: FRESH_SESSION_SECONDS },
    hooks: { before: requireFreshSessionToLink },
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
