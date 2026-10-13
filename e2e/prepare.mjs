import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import pg from "pg";
import { E2E, E2E_DATABASE, databaseUrl } from "./env.mjs";

// Runs before Playwright (`npm run test:e2e`): Playwright starts the servers before its own
// global setup, and the Go API needs its database at startup. One empty database with the real
// schemas (the web app and the Go API share a database), and an empty mail file. The database is
// dropped and made again each run, so no run depends on the last.

async function recreate(admin, name) {
  await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await admin.query(`CREATE DATABASE "${name}"`);
}

async function apply(name, statements) {
  const client = new pg.Client({ connectionString: databaseUrl(name) });
  await client.connect();
  try {
    for (const statement of statements) await client.query(statement);
  } finally {
    await client.end();
  }
}

// The web app's tables: the SQL files in drizzle/ that the project's own migration applies. They
// go in first: the Go API's profiles table references the web app's user table.
function webStatements() {
  return readdirSync("drizzle")
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((f) => readFileSync(join("drizzle", f), "utf8").split("--> statement-breakpoint"));
}

// The Go API's tables: the "Up" part of each goose migration.
function apiStatements() {
  const dir = join(E2E.apiDir, "migrations");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => readFileSync(join(dir, f), "utf8"))
    .map((sql) => sql.split("-- +goose Up")[1]?.split("-- +goose Down")[0] ?? "")
    .filter((sql) => sql.trim() !== "");
}

// This drops and recreates a database, so it only runs against a server on this machine (or the
// CI service). Point E2E_ALLOW_REMOTE=1 at a remote server only if it is a throwaway one.
const host = new URL(E2E.adminDatabaseUrl).hostname;
if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host) && process.env.E2E_ALLOW_REMOTE !== "1") {
  console.error(`Refusing to recreate the database on ${host}: not a local server.`);
  process.exit(1);
}

const admin = new pg.Client({ connectionString: E2E.adminDatabaseUrl });
await admin.connect();
try {
  await recreate(admin, E2E_DATABASE);
} finally {
  await admin.end();
}
await apply(E2E_DATABASE, webStatements());
await apply(E2E_DATABASE, apiStatements());

mkdirSync(dirname(E2E.mailFile), { recursive: true });
rmSync(E2E.mailFile, { force: true });
writeFileSync(E2E.mailFile, "");
console.log("e2e database and mail file are ready");
