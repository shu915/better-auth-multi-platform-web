import { defineConfig } from "@playwright/test";
import { E2E, databaseUrl } from "./e2e/env.mjs";

// End-to-end: a real browser against a real web app, a real Go API and a real Postgres.
//
// Everything runs on its own ports and its own databases (e2e_web, e2e_api), set explicitly
// below, so it can never reach the databases of your local development setup. Your own `npm run dev`
// can keep running: the end-to-end server writes to .next-e2e instead of .next.
//
// Run it with `npm run test:e2e`: e2e/prepare.mjs makes the databases first. Needs a Postgres
// server and the Go API's source (../api by default; API_DIR to change).

const webOrigin = `http://localhost:${E2E.webPort}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  // No retries: a test that passes only on the second try would hide a real flaw.
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: { baseURL: webOrigin, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  webServer: [
    {
      // The Go API, built from source so the test always runs the current code.
      command: "go run ./cmd/server",
      cwd: E2E.apiDir,
      url: `http://localhost:${E2E.apiPort}/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        PORT: String(E2E.apiPort),
        AUTH_ISSUER: webOrigin,
        AUTH_AUDIENCE: "e2e-api",
        // Set everything the Go API reads, so nothing leaks in from the shell it is started from.
        AUTH_JWKS_URL: `${webOrigin}/api/auth/jwks`,
        APP_ENV: "development",
        CORS_ALLOWED_ORIGINS: webOrigin,
        DATABASE_URL: databaseUrl("e2e_api"),
      },
    },
    {
      command: `npx next dev --port ${E2E.webPort}`,
      url: `${webOrigin}/login`,
      reuseExistingServer: false,
      timeout: 180_000,
      env: {
        NEXT_DIST_DIR: ".next-e2e",
        BETTER_AUTH_URL: webOrigin,
        BETTER_AUTH_SECRET: "e2e-only-secret-e2e-only-secret-e2e-only",
        JWT_AUDIENCE: "e2e-api",
        DATABASE_URL: databaseUrl("e2e_web"),
        DATABASE_URL_UNPOOLED: databaseUrl("e2e_web"),
        API_BASE_URL: `http://localhost:${E2E.apiPort}`,
        EMAIL_TRANSPORT: "file",
        EMAIL_FILE: E2E.mailFile,
        RESEND_API_KEY: "",
        EMAIL_FROM: "",
        // No Google here: the real Google is not part of the end-to-end test.
        GOOGLE_CLIENT_ID: "",
        GOOGLE_CLIENT_SECRET: "",
      },
    },
  ],
});
