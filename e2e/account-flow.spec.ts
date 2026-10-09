import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { Client } from "pg";
import { E2E, databaseUrl } from "./env.mjs";

// One path through the whole product, the way a person uses it: sign in with the emailed link,
// edit the profile, delete the account. Real browser, real web app, real Go API, real Postgres.
// The magic link is read from the mail file (EMAIL_TRANSPORT=file) instead of an inbox.

type Mail = { to: string; subject: string; text: string };

function mailsTo(address: string): Mail[] {
  return readFileSync(E2E.mailFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Mail)
    .filter((mail) => mail.to === address);
}

async function waitForMail(address: string, subject: string): Promise<Mail> {
  let found: Mail | undefined;
  await expect
    .poll(
      () => {
        found = mailsTo(address).find((mail) => mail.subject === subject);
        return found !== undefined;
      },
      { timeout: 20_000, message: `no "${subject}" email for ${address}` },
    )
    .toBe(true);
  if (!found) throw new Error("unreachable: the poll above passed without a mail");
  return found;
}

async function count(database: string, sql: string, params: unknown[]): Promise<number> {
  const client = new Client({ connectionString: databaseUrl(database) });
  await client.connect();
  try {
    const { rows } = await client.query<{ n: string }>(sql, params);
    return Number(rows[0].n);
  } finally {
    await client.end();
  }
}

async function userIdOf(email: string): Promise<string> {
  const client = new Client({ connectionString: databaseUrl("e2e_web") });
  await client.connect();
  try {
    const { rows } = await client.query<{ id: string }>(`SELECT id FROM "user" WHERE email = $1`, [email]);
    if (rows.length !== 1) throw new Error(`expected one user for ${email}, found ${rows.length}`);
    return rows[0].id;
  } finally {
    await client.end();
  }
}

async function signIn(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Send sign-in link" }).click();
  await expect(page.getByText("Check your email")).toBeVisible();

  const mail = await waitForMail(email, "Sign in");
  const link = mail.text.match(/https?:\/\/\S+/)?.[0];
  if (!link) throw new Error(`no link in the sign-in email: ${mail.text}`);
  await page.goto(link);
  await expect(page.getByText("Signed in as")).toBeVisible();
  await expect(page.getByText(email)).toBeVisible();
}

test("sign in, edit the profile, delete the account", async ({ page }) => {
  const email = `e2e-${Date.now()}@example.com`;
  const bio = `Hello from the end-to-end test ${Date.now()}`;

  // Anything the browser says the Content-Security-Policy would block, on any page of the run.
  // The policy is in report-only mode: nothing is blocked yet, but a violation here means the
  // page would break the day it is enforced. The only thing left out is Next.js's own development
  // overlay (next-devtools), which exists only under `next dev`, never in a production build.
  const violations: string[] = [];
  await page.exposeFunction("reportCspViolation", (text: string) => violations.push(text));
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) => {
      if (event.sourceFile.includes("next-devtools")) return;
      const report: unknown = Reflect.get(window, "reportCspViolation");
      if (typeof report === "function") {
        report(`${event.violatedDirective} | ${event.blockedURI} | ${event.sourceFile}:${event.lineNumber} | ${event.sample.slice(0, 80)}`);
      }
    });
  });

  // A page that needs a session sends a visitor to /login.
  const loginResponse = await page.goto("/profile");
  await expect(page).toHaveURL(/\/login/);

  // The policy is on the page, and Next.js put its nonce on the page's scripts (the browser
  // hides the attribute but keeps the value on the element).
  const policy = loginResponse?.headers()["content-security-policy-report-only"] ?? "";
  const nonce = /'nonce-([^']+)'/.exec(policy)?.[1];
  expect(nonce, "the page has a Content-Security-Policy with a nonce").toBeTruthy();
  expect(await page.evaluate(() => document.querySelector<HTMLScriptElement>("script[nonce]")?.nonce ?? "")).toBe(nonce);

  // Asking for a sign-in link four times for one address: all four get the same answer (so the
  // limit shows nothing about the address), but only three emails are sent.
  const limited = `e2e-limited-${Date.now()}@example.com`;
  const loginOrigin = new URL(page.url()).origin;
  const answers: number[] = [];
  for (let i = 0; i < 4; i++) {
    const res = await page.request.post("/api/auth/sign-in/magic-link", {
      headers: { origin: loginOrigin, "content-type": "application/json" },
      data: { email: limited },
    });
    answers.push(res.status());
  }
  expect(answers).toEqual([200, 200, 200, 200]);
  await expect.poll(() => mailsTo(limited).filter((m) => m.subject === "Sign in").length).toBe(3);
  await page.waitForTimeout(1_000); // a fourth email would have been sent by now
  expect(mailsTo(limited).filter((m) => m.subject === "Sign in")).toHaveLength(3);

  await signIn(page, email);
  const userId = await userIdOf(email);

  // What the browser may and may not ask of Better Auth directly (through the real Next.js
  // route, with the signed-in cookie). The rules for these live in the Server Actions, and the
  // JWT for the Go API must stay on the server. The public keys must stay public.
  const origin = new URL(page.url()).origin;
  const token = await page.request.get("/api/auth/token");
  expect(token.status()).toBe(403);
  expect(await token.text()).toContain("SERVER_ONLY");
  const deleteOverHttp = await page.request.post("/api/auth/delete-user", {
    headers: { origin, "content-type": "application/json" },
    data: {},
  });
  expect(deleteOverHttp.status()).toBe(403);
  expect(await deleteOverHttp.text()).toContain("SERVER_ONLY");
  expect(await count("e2e_web", `SELECT count(*) AS n FROM "user" WHERE email = $1`, [email])).toBe(1);
  const jwks = await page.request.get("/api/auth/jwks");
  expect(jwks.status()).toBe(200);
  expect((await jwks.json()).keys.length).toBeGreaterThan(0);

  // Edit: the name goes to the web app's database, the bio to the Go API.
  await page.goto("/profile/edit");
  await page.getByLabel("Name").fill("E2E User");
  await page.getByLabel("Bio").fill(bio);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page).toHaveURL(/\/profile$/);
  await expect(page.getByText("E2E User")).toBeVisible();
  await expect(page.getByText(bio)).toBeVisible();

  // The Go API really stored it, and the web app really made the user and its session. Counted
  // for this user only, so a leftover from an earlier attempt cannot change the result.
  expect(await count("e2e_web", `SELECT count(*) AS n FROM session WHERE user_id = $1`, [userId])).toBeGreaterThan(0);
  // The Go row belongs to the web app's user id (the JWT's sub), not just to some user.
  expect(await count("e2e_api", "SELECT count(*) AS n FROM profiles WHERE user_id = $1 AND bio = $2", [userId, bio])).toBe(1);
  expect(await count("e2e_web", `SELECT count(*) AS n FROM "user" WHERE email = $1`, [email])).toBe(1);

  // Delete the account: a wrong email is refused, the right one goes through.
  page.on("dialog", (dialog) => void dialog.accept());
  await page.getByLabel(/Type your email address/).fill("someone-else@example.com");
  await page.getByRole("button", { name: "Delete account" }).click();
  await expect(page.getByText("The email address does not match your account.")).toBeVisible();
  expect(await count("e2e_web", `SELECT count(*) AS n FROM "user" WHERE email = $1`, [email])).toBe(1);

  await page.getByLabel(/Type your email address/).fill(email);
  await page.getByRole("button", { name: "Delete account" }).click();
  await expect(page).toHaveURL(/\/login/); // "/" sends a visitor without a session here

  // Everything is gone, on both sides, and the person was told by email.
  expect(await count("e2e_api", "SELECT count(*) AS n FROM profiles WHERE user_id = $1", [userId])).toBe(0);
  expect(await count("e2e_web", `SELECT count(*) AS n FROM "user" WHERE email = $1`, [email])).toBe(0);
  expect(await count("e2e_web", `SELECT count(*) AS n FROM session WHERE user_id = $1`, [userId])).toBe(0);
  await waitForMail(email, "Your account was deleted");

  // The old session no longer opens anything.
  await page.goto("/profile");
  await expect(page).toHaveURL(/\/login/);

  expect(violations, "the policy would block something on these pages").toEqual([]);
});
