import { after } from "next/server";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { jwt, magicLink } from "better-auth/plugins";
import { db } from "@/lib/db";
import { sendEmail } from "@/lib/email";
import * as schema from "@/db/schema";

const baseURL =
  process.env.BETTER_AUTH_URL ??
  (process.env.NODE_ENV === "production" ? undefined : "http://localhost:3000");
if (!baseURL) throw new Error("BETTER_AUTH_URL is required in production");

// Must match the audience the Go API verifies.
const audience = process.env.JWT_AUDIENCE ?? "better-auth-multi-platform-api";

export const auth = betterAuth({
  baseURL,
  database: drizzleAdapter(db, { provider: "pg", schema }),
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
      },
    }),
  ],
});
