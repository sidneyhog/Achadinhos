import fs from "node:fs";
import path from "node:path";
import { one, q } from "./db";
import { decrypt } from "./secrets";

export type PlatformRow = {
  efi_client_id: string;
  efi_client_secret_enc: string;
  efi_pix_key: string;
  efi_sandbox: boolean;
  efi_webhook_url: string;
  trial_days_default: number;
  warn_days: string;
  block_after_days: number;
  smtp_host: string;
  smtp_port: number;
  smtp_user: string;
  smtp_pass_enc: string;
  smtp_from: string;
  payment_provider: string;
  pagbank_token_enc: string;
  pagbank_sandbox: boolean;
  public_url: string;
};

export const loadPlatform = async () => {
  await q("INSERT INTO platform_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING");
  const row = await one<PlatformRow>("SELECT efi_client_id, efi_client_secret_enc, efi_pix_key, efi_sandbox, efi_webhook_url, trial_days_default, warn_days, block_after_days, smtp_host, smtp_port, smtp_user, smtp_pass_enc, smtp_from, payment_provider, pagbank_token_enc, pagbank_sandbox, public_url FROM platform_settings WHERE id = 1");
  return row!;
};

export const loadEfiRuntime = async () => {
  const row = await loadPlatform();
  const savedSecret = decrypt(row.efi_client_secret_enc || "");
  const fromDb = Boolean(row.efi_client_id);
  const certPath = process.env.EFI_CERT_PATH || "";
  const abs = certPath ? (path.isAbsolute(certPath) ? certPath : path.resolve(process.cwd(), certPath)) : "";
  return {
    clientId: fromDb ? row.efi_client_id : (process.env.EFI_CLIENT_ID || ""),
    clientSecret: savedSecret || process.env.EFI_CLIENT_SECRET || "",
    pixKey: (fromDb ? row.efi_pix_key : "") || process.env.EFI_PIX_KEY || "",
    sandbox: fromDb ? row.efi_sandbox !== false : process.env.EFI_SANDBOX !== "false",
    webhookUrl: row.efi_webhook_url || "",
    certPath: abs,
    certPassword: process.env.EFI_CERT_PASSWORD || "",
    certReady: Boolean(abs && fs.existsSync(abs)),
    secretSet: Boolean(savedSecret || process.env.EFI_CLIENT_SECRET)
  };
};
