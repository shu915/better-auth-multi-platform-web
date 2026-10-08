import { createRateLimiter } from "@/lib/rate-limit";

// One limiter per Server Action, keyed by user id. Failed attempts count too: the point is to
// stop hammering, not to count successes.

/** Saving the profile writes to two databases, so a person typing never needs more than this. */
export const profileUpdateLimiter = createRateLimiter({ windowMs: 60_000, max: 20 });

/** Deleting the account is rare and irreversible, and a wrong email is the usual retry. */
export const accountDeleteLimiter = createRateLimiter({ windowMs: 10 * 60_000, max: 5 });
