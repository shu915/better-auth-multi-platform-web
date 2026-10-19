import { after } from "next/server";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { expo } from "@better-auth/expo";
import { nextCookies } from "better-auth/next-js";
import { magicLink } from "better-auth/plugins";
import { db } from "@/lib/db";
import { sendEmail } from "@/lib/email";
import { googleAuthOptions } from "@/lib/google-auth-options";
import { resolveGoogleCredentials } from "@/lib/google-oauth";
import { jwtPlugin } from "@/lib/jwt-plugin";
import { linkedAccountEmail } from "@/lib/linked-accounts";
import { nativeClientPlugins } from "@/lib/native-clients";
import { allowMagicLinkTo } from "@/lib/rate-limits";
import * as schema from "@/db/schema";

const baseURL =
  process.env.BETTER_AUTH_URL ??
  (process.env.NODE_ENV === "production" ? undefined : "http://localhost:3000");
if (!baseURL) throw new Error("BETTER_AUTH_URL is required in production");

// Must match the audience the Go API verifies.
const audience = process.env.JWT_AUDIENCE ?? "better-auth-multi-platform-api";

// The native app (Expo, repo better-auth-multi-platform-mobile) comes back from the browser with a
// deep link of this scheme (app.json "scheme"), carrying the session. Better Auth only redirects
// to a trusted origin, so the scheme must be listed. In development the expo plugin also trusts
// "exp://" (Expo Go); that is not added here, so it never reaches production.
const nativeAppOrigin = "betterauthmulti://";

// The user is created by the magic link (the root identity). Google is an optional extra way to
// sign in that a signed-in user links from /profile; it can never create a user. It is on only
// when both env vars are set.
const google = resolveGoogleCredentials({
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
});
export const googleEnabled = google !== null;

// The sign-in policy lives in googleAuthOptions so the tests run the same options.
const policy = googleAuthOptions(google, {
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
});

export const auth = betterAuth({
  baseURL,
  trustedOrigins: [nativeAppOrigin],
  database: drizzleAdapter(db, { provider: "pg", schema }),
  ...policy,
  // Count rate limits in the database, not in memory: on a serverless host (Vercel) each request
  // can run in a different process, so memory counts nothing. This needs the rateLimit table in
  // every database this config runs against before it is deployed (the schema generation and
  // migration steps are in CLAUDE.md).
  rateLimit: { storage: "database" },
  plugins: [
    magicLink({
      sendMagicLink: async ({ email, url }) => {
        // Too many links to one address: send nothing, and answer exactly as if one was sent
        // (see allowMagicLinkTo). The address is not logged.
        if (!(await allowMagicLinkTo(email))) {
          console.warn("[email] sign-in link not sent: too many requests for one address");
          return;
        }
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
    jwtPlugin({ issuer: baseURL, audience }),
    // Native apps: the session token as "Authorization: Bearer ..." (signed value only, and the
    // "set-auth-token" response header removed). Only /token accepts it from outside; see
    // native-clients.ts and isBearerOnly in google-auth-options.ts.
    ...nativeClientPlugins(),
    // Native apps: after a magic link (or a callback) redirects to a trusted deep link, it appends
    // the session cookie to that link so the app can store it. Needs the app's scheme in
    // trustedOrigins above.
    expo(),
    // Lets a Server Action (deleteAccount) clear the session cookie. Must stay last.
    nextCookies(),
  ],
});
