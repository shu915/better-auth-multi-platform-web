import type { PoolConfig } from "pg";

// How the web app connects to Postgres. Kept apart from db.ts, which opens the pool as a side
// effect of being imported, so the rules can be tested.

const DEFAULT_POOL_MAX = 10;
const MAX_POOL_MAX = 50;

type Env = {
  DATABASE_URL?: string;
  DATABASE_POOL_MAX?: string;
  NODE_ENV?: string;
  NEXT_PHASE?: string;
};

// sslmode values that always encrypt. Omitted, disable, allow and prefer can fall back to plain
// text (pg's own default when sslmode is omitted is no TLS at all).
const TLS_SSLMODES = new Set(["require", "verify-ca", "verify-full"]);

/**
 * Throws unless the URL asks for an encrypted connection. The error never repeats the URL, which
 * holds the password.
 */
export function requireTls(connectionString: string): void {
  let sslmode: string | null;
  try {
    sslmode = new URL(connectionString).searchParams.get("sslmode");
  } catch {
    throw new Error("DATABASE_URL is not a valid URL");
  }
  if (sslmode === null || !TLS_SSLMODES.has(sslmode)) {
    throw new Error("DATABASE_URL must set sslmode=require (or verify-ca / verify-full) in production");
  }
}

function poolMax(raw: string | undefined): number {
  if (raw === undefined || raw === "") return DEFAULT_POOL_MAX;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_POOL_MAX) {
    throw new Error(`DATABASE_POOL_MAX must be a whole number from 1 to ${MAX_POOL_MAX}`);
  }
  return n;
}

/**
 * The pool settings for the environment. In production the connection must be encrypted, like the
 * Go API's. `next build` imports the app with NODE_ENV=production and placeholder settings and
 * never connects, so the check is skipped during the build.
 */
export function poolConfig(env: Env): PoolConfig {
  const connectionString = env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");

  const building = env.NEXT_PHASE === "phase-production-build";
  if (env.NODE_ENV === "production" && !building) requireTls(connectionString);

  return {
    connectionString,
    // Several instances share one database: cap the connections each may take.
    max: poolMax(env.DATABASE_POOL_MAX),
    // A database that does not answer must not hang a page. These are client-side limits (not
    // the server's statement_timeout, which a pooled endpoint such as PgBouncer can refuse as a
    // startup parameter).
    connectionTimeoutMillis: 5_000,
    query_timeout: 10_000,
    idleTimeoutMillis: 30_000,
  };
}
