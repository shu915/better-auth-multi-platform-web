import { cleanupExpired, createCleanupHandler } from "@/lib/cleanup";

// Called once a day by Vercel Cron (vercel.json). The secret is the CRON_SECRET environment
// variable, which Vercel sends as a Bearer token with its own call.
export const GET = createCleanupHandler({
  secret: () => process.env.CRON_SECRET,
  // Loaded on first use: importing @/lib/db needs DATABASE_URL, which the tests do not set.
  run: async () => cleanupExpired((await import("@/lib/db")).db),
});
