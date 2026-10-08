import { resolve } from "node:path";

// Shared by playwright.config.ts, the tests and prepare.mjs. Plain JavaScript so that prepare.mjs
// can run with Node alone, before Playwright starts.

export const E2E = {
  webPort: 3100,
  apiPort: 8180,
  // A server on which the e2e_* databases may be created and dropped.
  adminDatabaseUrl:
    process.env.E2E_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/postgres",
  apiDir: resolve(process.env.API_DIR ?? "../api"),
  mailFile: resolve("e2e/.tmp/mail.jsonl"),
};

/** The URL of database `name` on the same server as the admin URL. */
export function databaseUrl(name) {
  const url = new URL(E2E.adminDatabaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}
