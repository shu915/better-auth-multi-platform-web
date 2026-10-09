# better-auth-multi-platform (web)

A sample of one sign-in that several clients can share. The web app signs people in with
[Better Auth](https://www.better-auth.com), and a separate Go service trusts the tokens it issues.
Later, desktop (Tauri) and mobile (Expo) clients can use the same Go service without changing it.

This repository is the web side (Next.js). The Go API is in
[better-auth-multi-platform-api](https://github.com/shu915/better-auth-multi-platform-api).

## How it fits together

```
Browser ──▶ Next.js (Vercel) ──▶ Go API (Render)
              │  Better Auth        │  verifies the JWT with the public keys
              ▼                     ▼
          Postgres (Neon)      Postgres (Render)
        users, sessions,       profiles (bio)
        signing keys
```

- **Sign in by magic link.** No passwords. The user is created by the first magic link, and that
  user's id is the `sub` of every token.
- **Google is optional and cannot create users.** A signed-in user can link a Google account from
  `/profile`, and unlink it. Linking needs a sign-in from the last 5 minutes, and the root email
  address is notified.
- **The browser never holds a JWT.** The Next.js server issues a short-lived (5 minutes) token for
  each call to the Go API (`src/lib/api-server.ts`). The Go API checks the signature with the
  public keys at `/api/auth/jwks`, plus the issuer and the audience.
- **Account deletion** (`/profile`): revokes other sessions, deletes the user's data in the Go API,
  deletes the user, and emails the root address. It asks for the typed email and a recent sign-in.
- **Endpoints that only our server may call** (`/api/auth/delete-user`, `/update-user`, `/token`,
  and the Google token endpoints) answer `403` over HTTP, so a session cookie alone cannot skip the
  rules that live in the Server Actions.

## Stack

Next.js 16 (App Router) · React 19 · TypeScript · Tailwind CSS v4 · Better Auth · Drizzle ·
Postgres (Neon) · Resend · Vitest · Playwright.

## Run it locally

You need Node.js, a Postgres database for this app (a free [Neon](https://neon.tech) project is
fine), and the Go API running (see the API repository).

```bash
npm ci
cp .env.example .env.local     # then fill it in; see the table below
npm run db:migrate             # creates the tables
npm run dev                    # http://localhost:3000
```

In development emails are printed to the terminal (`EMAIL_TRANSPORT=console`), so the sign-in link
appears in the output of `npm run dev`.

### Environment variables

| Variable | Notes |
|---|---|
| `BETTER_AUTH_SECRET` | Required. Any long random string, for example `openssl rand -base64 32`. |
| `BETTER_AUTH_URL` | Public URL of this app, no trailing slash. Must equal the Go API's `AUTH_ISSUER`. Required in production. |
| `JWT_AUDIENCE` | Must equal the Go API's `AUTH_AUDIENCE`. Defaults to `better-auth-multi-platform-api`. |
| `API_BASE_URL` | Base URL of the Go API. Defaults to `http://localhost:8080` in development; required, and `https`, in production. |
| `DATABASE_URL` | Postgres connection string used at runtime. With Neon, the pooled one. In production it needs `sslmode=require` or stronger. |
| `DATABASE_URL_UNPOOLED` | Used only by `drizzle-kit` (migrations). With Neon, the direct one, without `-pooler`. |
| `DATABASE_POOL_MAX` | Optional. Connections per instance, 1 to 50, default 10. A small number suits serverless. |
| `EMAIL_TRANSPORT` | `console` (development) or `resend`. Production accepts only `resend`. |
| `RESEND_API_KEY`, `EMAIL_FROM` | Needed when `EMAIL_TRANSPORT=resend`. The sender domain must be verified in Resend. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Optional. Set both to turn Google linking on. Redirect URI: `<BETTER_AUTH_URL>/api/auth/callback/google`. |
| `CRON_SECRET` | Production. Protects the daily cleanup endpoint (see below). |

## Commands

| Command | What it does |
|---|---|
| `npm run dev` / `build` / `lint` | Development server, build, lint. |
| `npm test` | Unit and integration tests (Vitest). The tests that need Postgres run when `TEST_DATABASE_URL` is set. They create a throwaway schema, so point it at a scratch database, never at one with real data. |
| `npm run test:e2e` | One end-to-end test through a real browser, this app, the Go API and Postgres: sign in, edit the profile, delete the account. Needs the API repository next to this one (`../api`, or set `API_DIR`) and Docker for Postgres. |
| `npm run db:generate` / `db:migrate` | Create and apply Drizzle migrations. |

## Deploying

This is how the app runs in production: the web on Vercel with Neon, the Go API and its database on
Render, all in the same region to keep database round trips short.

1. Apply the migrations (`npm run db:migrate`) to the production Neon branch, using the unpooled URL.
2. Deploy the Go API first (a deletion in the web app calls it), then this app.
3. Set the environment variables above for Production. Pick `Secret` for the keys and URLs that
   hold passwords.
4. A daily Vercel Cron (`vercel.json`) calls `/api/cron/cleanup`, which removes expired sign-in
   links, expired sessions and old rate limit rows. It does nothing unless the request carries
   `CRON_SECRET`.

Notes on what is enforced in production: HTTPS-only API URL, TLS to the database, no `console`
email transport, a Content-Security-Policy with a per-request nonce (`src/proxy.ts`), and rate
limits on sign-in emails (per IP, and per address, counted in the database).

## Known limits

- The Go API has no rate limit of its own.
- A token stays valid for up to 5 minutes after the account is deleted, so a request in that window
  can recreate a profile row.
- The per-address email limit can be used to keep one person from signing in for a while.
- Pages that do not read the session are rendered once at build time and would get no nonce, so the
  enforced CSP would block them. Render such pages per request (see `src/app/not-found.tsx`).

More detail for contributors, including the decisions behind these, is in `CLAUDE.md` and
`claude-progress.txt`.
