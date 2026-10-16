import nodemailer from "nodemailer";
import { loadPlatform } from "./platform";
import { decrypt } from "./secrets";

export const smtpReady = async () => {
  const row = await loadPlatform();
  return Boolean(row.smtp_host && row.smtp_from);
};

export const sendMail = async (input: { to: string; subject: string; text: string }) => {
  const row = await loadPlatform();
  if (!row.smtp_host || !row.smtp_from) return { sent: false as const, reason: "SMTP não configurado" };
  const pass = decrypt(row.smtp_pass_enc || "");
  const transport = nodemailer.createTransport({
    host: row.smtp_host,
    port: Number(row.smtp_port) || 587,
    secure: Number(row.smtp_port) === 465,
    auth: row.smtp_user ? { user: row.smtp_user, pass } : undefined
  });
  await transport.sendMail({ from: row.smtp_from, to: input.to, subject: input.subject, text: input.text });
  return { sent: true as const };
};
