import nodemailer from "nodemailer";

let transport: ReturnType<typeof nodemailer.createTransport> | null = null;
let configured = false;

function getTransport(): ReturnType<typeof nodemailer.createTransport> | null {
  if (configured) return transport;
  configured = true;

  const host = process.env.SMTP_HOST;
  if (!host) return null;

  transport = nodemailer.createTransport({
    host,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === "true",
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD }
      : undefined,
  });
  return transport;
}

/**
 * Sends one email, or -- when no SMTP host is configured -- logs what would
 * have been sent instead. Never throws: a notification failure must never be
 * allowed to break whatever background job, worker loop, or scheduler tick
 * triggered it.
 */
export async function sendMail(to: string, subject: string, text: string): Promise<void> {
  const t = getTransport();
  if (!t) {
    console.log(`[email] SMTP not configured; would have sent to ${to}: ${subject}`);
    return;
  }
  try {
    await t.sendMail({ from: process.env.EMAIL_FROM || "yana@localhost", to, subject, text });
  } catch (err) {
    console.error(`[email] failed to send to ${to}:`, err);
  }
}
