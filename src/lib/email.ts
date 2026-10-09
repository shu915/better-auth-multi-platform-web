import { appendFile } from "node:fs/promises";
import { Resend } from "resend";

type Email = { to: string; subject: string; html: string; text: string };

// "console" logs the email; "resend" sends it; "file" appends it as one JSON line to EMAIL_FILE,
// which the end-to-end tests read to follow the magic link. Unset defaults to "console" outside
// production, and is an error in production so a missing setting can't silently drop mail.
// "file" and "console" are refused in production: they would write every sign-in link to disk or
// to the host's logs, where anyone who can read them can sign in as someone else.
function getTransport(): "console" | "resend" | "file" {
  const transport =
    process.env.EMAIL_TRANSPORT ??
    (process.env.NODE_ENV === "production" ? undefined : "console");
  if (transport !== "console" && transport !== "resend" && transport !== "file") {
    throw new Error('EMAIL_TRANSPORT must be "console", "resend" or "file"');
  }
  if ((transport === "file" || transport === "console") && process.env.NODE_ENV === "production") {
    throw new Error(`EMAIL_TRANSPORT "${transport}" is for development and tests and is not allowed in production`);
  }
  return transport;
}

export async function sendEmail({ to, subject, html, text }: Email) {
  const transport = getTransport();
  if (transport === "console") {
    console.log(`[email] to=${to} subject=${subject}\n${text}`);
    return;
  }
  if (transport === "file") {
    const file = process.env.EMAIL_FILE;
    if (!file) throw new Error("EMAIL_FILE is required when EMAIL_TRANSPORT=file");
    await appendFile(file, `${JSON.stringify({ to, subject, text })}\n`);
    return;
  }

  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  if (!apiKey || !from) {
    throw new Error("RESEND_API_KEY and EMAIL_FROM are required when EMAIL_TRANSPORT=resend");
  }

  const { error } = await new Resend(apiKey).emails.send({
    from,
    to,
    subject,
    html,
    text,
  });
  if (error) throw new Error(`Failed to send email: ${error.message}`);
}
