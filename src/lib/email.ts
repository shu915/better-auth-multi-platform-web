import { Resend } from "resend";

type Email = { to: string; subject: string; html: string; text: string };

// "console" logs the email; "resend" sends it. Unset defaults to "console" outside
// production, and is an error in production so a missing setting can't silently drop mail.
function getTransport(): "console" | "resend" {
  const transport =
    process.env.EMAIL_TRANSPORT ??
    (process.env.NODE_ENV === "production" ? undefined : "console");
  if (transport !== "console" && transport !== "resend") {
    throw new Error('EMAIL_TRANSPORT must be "console" or "resend"');
  }
  return transport;
}

export async function sendEmail({ to, subject, html, text }: Email) {
  if (getTransport() === "console") {
    console.log(`[email] to=${to} subject=${subject}\n${text}`);
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
