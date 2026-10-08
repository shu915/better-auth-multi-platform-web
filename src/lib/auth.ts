import { after } from "next/server";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { jwt, magicLink } from "better-auth/plugins";
import { db } from "@/lib/db";
import { sendEmail } from "@/lib/email";
import { googleAuthOptions } from "@/lib/google-auth-options";
import { resolveGoogleCredentials } from "@/lib/google-oauth";
import { linkedAccountEmail } from "@/lib/linked-accounts";
import * as schema from "@/db/schema";

const baseURL =
  process.env.BETTER_AUTH_URL ??
  (process.env.NODE_ENV === "production" ? undefined : "http://localhost:3000");
if (!baseURL) throw new Error("BETTER_AUTH_URL is required in production");

// Must match the audience the Go API verifies.
const audience = process.env.JWT_AUDIENCE ?? "better-auth-multi-platform-api";

// The user is created by the magic link (the root identity). Google is an optional extra way to
// sign in that a signed-in user links from /profile; it can never create a user. It is on only
// when both env vars are set.
const google = resolveGoogleCredentials({
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
});
export const googleEnabled = google !== null;

export const auth = betterAuth({
  baseURL,
  database: drizzleAdapter(db, { provider: "pg", schema }),
  // The sign-in policy lives in googleAuthOptions so the tests run the same options.
  ...googleAuthOptions(google, {
    notifyLinked: async ({ to, provider }) => {
      const { subject, text, html } = linkedAccountEmail(provider, new Date());
      // Not awaited, like the magic link: the link itself must not wait for (or fail on) mail.
      after(async () => {
        try {
          await sendEmail({ to, subject, text, html });
        } catch (err) {
          console.error("[email] failed to send the linked-account notice", err);
        }
      });
    },
  }),
  plugins: [
    magicLink({
      sendMagicLink: async ({ email, url }) => {
        // Not awaited: send failures and latency must not differ between
        // registered and unregistered emails (account enumeration).
        after(async () => {
          try {
            await sendEmail({
              to: email,
              subject: "Sign in",
              text: `Sign in: ${url}`,
              html: `<p><a href="${url}">Sign in</a></p>`,
            });
          } catch (err) {
            console.error("[email] failed to send magic link", err);
          }
        });
      },
    }),
    jwt({
      jwt: {
        issuer: baseURL,
        audience,
        expirationTime: "5m",
        // By default the whole user record is embedded; keep only the standard
        // claims (iat, iss, aud, exp) plus `sub` (the user id, set by Better Auth).
        definePayload: () => ({}),
      },
    }),
    // Lets a Server Action (deleteAccount) clear the session cookie. Must stay last.
    nextCookies(),
  ],
});
