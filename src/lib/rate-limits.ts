import { createDatabaseRateLimiter } from "@/lib/database-rate-limit";
import { createRateLimiter, type RateLimiter, type RateLimitRule } from "@/lib/rate-limit";

// The one rate limit of our own: sign-in emails per address. (Everything else that a person can do
// needs a signed-in session, and the sign-in endpoints have Better Auth's own limits.)
//
// In production the counts live in the database (shared by every serverless instance); in
// development and in the tests they live in memory, which needs no database and can be reset.
const memoryLimiters: ReturnType<typeof createRateLimiter>[] = [];

function limiter(name: string, rule: RateLimitRule): RateLimiter {
  if (process.env.NODE_ENV === "production") {
    return createDatabaseRateLimiter({
      name,
      rule,
      // Loaded on first use: importing @/lib/db needs DATABASE_URL, which the tests do not set.
      getDb: async () => (await import("@/lib/db")).db,
    });
  }
  const memory = createRateLimiter(rule);
  memoryLimiters.push(memory);
  return memory;
}

/** Forgets every in-memory count. For tests (the database ones are not touched). */
export function resetMemoryRateLimits() {
  for (const memory of memoryLimiters) memory.reset();
}

/**
 * Sign-in links per address. Better Auth limits by client IP, so an attacker with many IPs could
 * still fill one person's inbox; this counts per recipient. Three in ten minutes is enough for a
 * person who lost the first email.
 */
export const magicLinkRecipientLimiter = limiter("magic-link-recipient", { windowMs: 10 * 60_000, max: 3 });

/**
 * Whether a sign-in link may be sent to this address now. The caller must not tell the visitor
 * the answer: the page says "check your email" either way, so it cannot be used to find out
 * which addresses are being mailed.
 */
export async function allowMagicLinkTo(email: string): Promise<boolean> {
  const result = await magicLinkRecipientLimiter.check(email.trim().toLowerCase());
  return result.allowed;
}
