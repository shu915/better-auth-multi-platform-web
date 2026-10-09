import { randomUUID } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import type { RateLimiter, RateLimitResult, RateLimitRule } from "@/lib/rate-limit";

// A rate limiter that counts in the rate_limit table, the one Better Auth keeps for its own
// limits (rateLimit.storage = "database"). On a serverless host every request can run in a
// different process, so only a shared store can count. Same rule as Better Auth's: a window
// starts at the first request, an allowed request moves the clock, a blocked one does not.

/** The part of a Drizzle database this needs, so a test can stand in for it. */
export type SqlExecutor = { execute(query: SQL): Promise<{ rows: Record<string, unknown>[] }> };

// Rows this old are past every window we use (the longest is ten minutes) and are deleted when a
// new window starts, so the table does not grow with every address and user ever seen.
const STALE_AFTER_MS = 60 * 60_000;

export function createDatabaseRateLimiter({
  name,
  rule,
  getDb,
  now = Date.now,
  onError = (err: unknown) => console.error("[rate-limit] counting failed, letting the request through", err),
}: {
  /** Keeps this limiter's keys apart from the others', and from Better Auth's own. */
  name: string;
  rule: RateLimitRule;
  getDb: () => Promise<SqlExecutor>;
  now?: () => number;
  onError?: (err: unknown) => void;
}): RateLimiter {
  return {
    async check(key: string): Promise<RateLimitResult> {
      const rowKey = `action:${name}:${key}`;
      const at = now();
      try {
        const db = await getDb();
        // One statement, so concurrent requests cannot both slip under the limit: the row is
        // changed only if its window is over or it still has room (the WHERE), and a row comes
        // back only if it was changed.
        const counted = await db.execute(sql`
          INSERT INTO rate_limit (id, key, count, last_request)
          VALUES (${randomUUID()}, ${rowKey}, 1, ${at}::bigint)
          ON CONFLICT (key) DO UPDATE SET
            count = CASE WHEN rate_limit.last_request <= ${at}::bigint - ${rule.windowMs}::bigint
                         THEN 1 ELSE rate_limit.count + 1 END,
            last_request = ${at}::bigint
          WHERE rate_limit.last_request <= ${at}::bigint - ${rule.windowMs}::bigint
             OR rate_limit.count < ${rule.max}
          RETURNING count
        `);
        if (counted.rows.length > 0) {
          if (Number(counted.rows[0].count) === 1) {
            await db.execute(
              sql`DELETE FROM rate_limit WHERE last_request < ${at - STALE_AFTER_MS}::bigint`,
            );
          }
          return { allowed: true };
        }
        const { rows } = await db.execute(
          sql`SELECT last_request FROM rate_limit WHERE key = ${rowKey}`,
        );
        const lastRequest = Number(rows[0]?.last_request ?? at);
        const retryAfterMs = lastRequest + rule.windowMs - at;
        return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) };
      } catch (err) {
        // The limit is a brake, not a gate: if the database cannot be reached, the request would
        // fail on its own work anyway, and a counting outage must not lock every user out.
        onError(err);
        return { allowed: true };
      }
    },
  };
}
