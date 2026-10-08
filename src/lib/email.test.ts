import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sendEmail } from "@/lib/email";

const mail = { to: "a@example.com", subject: "Hi", text: "Sign in: http://x/y", html: "<p>Hi</p>" };

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("sendEmail with the file transport (used by the end-to-end tests)", () => {
  it("appends one JSON line per email, with the text of the link", async () => {
    const dir = mkdtempSync(join(tmpdir(), "email-test-"));
    const file = join(dir, "mail.jsonl");
    vi.stubEnv("EMAIL_TRANSPORT", "file");
    vi.stubEnv("EMAIL_FILE", file);
    try {
      await sendEmail(mail);
      await sendEmail({ ...mail, to: "b@example.com" });

      const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      expect(lines).toEqual([
        { to: "a@example.com", subject: "Hi", text: "Sign in: http://x/y" },
        { to: "b@example.com", subject: "Hi", text: "Sign in: http://x/y" },
      ]);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("needs EMAIL_FILE", async () => {
    vi.stubEnv("EMAIL_TRANSPORT", "file");
    vi.stubEnv("EMAIL_FILE", "");
    await expect(sendEmail(mail)).rejects.toThrow(/EMAIL_FILE/);
  });

  it("is refused in production, so sign-in links are never written to disk there", async () => {
    vi.stubEnv("EMAIL_TRANSPORT", "file");
    vi.stubEnv("EMAIL_FILE", "/tmp/never-written.jsonl");
    vi.stubEnv("NODE_ENV", "production");
    await expect(sendEmail(mail)).rejects.toThrow(/not allowed in production/);
  });

  it("still rejects an unknown transport", async () => {
    vi.stubEnv("EMAIL_TRANSPORT", "carrier-pigeon");
    await expect(sendEmail(mail)).rejects.toThrow(/must be/);
  });
});
