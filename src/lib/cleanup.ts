import { createHash, timingSafeEqual } from "node:crypto";
import { lt } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "@/db/schema";

// Rows that are only kept for a while and that nothing removes by itself:
//  - verification: the sign-in links (and their email address) that were never used. Better Auth
//    only checks the expiry when a link is used, so the rest stay.
//  - session: sessions past their expiry (Better Auth removes one only when that session is used).
//  - rate_limit: one row per client IP and path, kept after its window ended. The longest window
//    is 10 minutes, so a row not touched for a day counts for nothing.
// The signing keys (jwks) are not here: they are shared by every user and must stay.
const RATE_LIMIT_KEEP_MS = 24 * 60 * 60 * 1000;

export type CleanupResult = { verification: number; session: number; rateLimit: number };

export async function cleanupExpired(
  db: NodePgDatabase<typeof schema>,
  now: Date = new Date(),
): Promise<CleanupResult> {
  const verification = await db
    .delete(schema.verification)
    .where(lt(schema.verification.expiresAt, now))
    .returning({ id: schema.verification.id });
  const session = await db
    .delete(schema.session)
    .where(lt(schema.session.expiresAt, now))
    .returning({ id: schema.session.id });
  const rateLimit = await db
    .delete(schema.rateLimit)
    .where(lt(schema.rateLimit.lastRequest, now.getTime() - RATE_LIMIT_KEEP_MS))
    .returning({ id: schema.rateLimit.id });
  return { verification: verification.length, session: session.length, rateLimit: rateLimit.length };
}

function sameSecret(given: string, expected: string): boolean {
  // Hashing first gives both sides the same length, which timingSafeEqual needs.
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * The handler for the scheduled call (Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`).
 * Anyone on the internet can reach the URL, so it does nothing without the secret, and nothing
 * at all when the secret is not set (it must never be open because of a missing setting).
 */
export function createCleanupHandler({
  secret,
  run,
}: {
  secret: () => string | undefined;
  run: () => Promise<CleanupResult>;
}) {
  const json = (body: object, status: number) =>
    Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

  return async function handler(request: Request): Promise<Response> {
    const expected = secret();
    if (!expected) {
      console.error("[cleanup] CRON_SECRET is not set; refusing to run");
      return json({ error: "Not configured" }, 503);
    }
    const header = request.headers.get("authorization") ?? "";
    if (!sameSecret(header, `Bearer ${expected}`)) return json({ error: "Unauthorized" }, 401);

    try {
      const result = await run();
      console.log(`[cleanup] removed ${JSON.stringify(result)}`);
      return json(result, 200);
    } catch (err) {
      console.error("[cleanup] failed", err);
      return json({ error: "Cleanup failed" }, 500);
    }
  };
}
