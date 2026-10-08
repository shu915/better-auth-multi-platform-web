// A sliding-window limiter for Server Actions, which Better Auth's own rate limiter does not
// cover (calls to auth.api.* from our own server code skip it). It lives in this server
// process's memory: it stops hammering from one browser or script, but each server instance
// counts on its own, so it is a brake, not an exact quota across instances.

export type RateLimitRule = { windowMs: number; max: number };

export type RateLimitResult = { allowed: true } | { allowed: false; retryAfterSeconds: number };

// Upper bound on distinct keys, so a flood of different keys cannot grow the map forever.
const MAX_KEYS = 10_000;

export function createRateLimiter(rule: RateLimitRule, now: () => number = Date.now) {
  const hits = new Map<string, number[]>();

  function sweep(at: number) {
    for (const [key, times] of hits) {
      if (times.every((t) => at - t >= rule.windowMs)) hits.delete(key);
    }
    // Still full of live keys: drop the oldest, which is the first one inserted.
    while (hits.size >= MAX_KEYS) {
      const oldest = hits.keys().next().value;
      if (oldest === undefined) break;
      hits.delete(oldest);
    }
  }

  return {
    /** Counts one attempt for `key` and says whether it may go ahead. */
    check(key: string): RateLimitResult {
      const at = now();
      const recent = (hits.get(key) ?? []).filter((t) => at - t < rule.windowMs);
      if (recent.length >= rule.max) {
        hits.set(key, recent);
        const retryAfterMs = recent[0] + rule.windowMs - at;
        return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
      }
      if (!hits.has(key) && hits.size >= MAX_KEYS) sweep(at);
      recent.push(at);
      hits.set(key, recent);
      return { allowed: true };
    },
    /** Forgets everything. For tests. */
    reset() {
      hits.clear();
    },
    /** How many keys are tracked. For tests. */
    size: () => hits.size,
  };
}

export function tooManyRequestsMessage(retryAfterSeconds: number): string {
  return `Too many requests. Please wait ${retryAfterSeconds} seconds and try again.`;
}
