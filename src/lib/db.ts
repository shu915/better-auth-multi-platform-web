import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "@/db/schema";
import { poolConfig } from "@/lib/database-config";

// One pool per process. In development the module is loaded again on every hot reload, and each
// load would open a new pool until the database runs out of connections, so it is kept on
// globalThis.
const poolKey = Symbol.for("better-auth-multi-platform.pg-pool");
const store = globalThis as typeof globalThis & { [poolKey]?: Pool };

function createPool(): Pool {
  const pool = new Pool(poolConfig(process.env));
  // An idle connection that the database drops emits "error"; with no listener that would crash
  // the process. The message can name the host but never holds the password.
  pool.on("error", (err) => console.error("[db] idle connection error:", err.message));
  return pool;
}

const pool = (store[poolKey] ??= createPool());

export const db = drizzle(pool, { schema });
