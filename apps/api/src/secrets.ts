import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const AUTO_KEYS = ["JWT_SECRET", "APP_SECRET", "EFI_WEBHOOK_SECRET"] as const;

/**
 * Com AUTO_SECRETS_FILE definido (stack do Portainer), os segredos que faltarem no ambiente são gerados
 * aleatoriamente na primeira subida e gravados nesse arquivo, num volume compartilhado entre API e worker.
 * Nas subidas seguintes o mesmo arquivo é lido, então os valores não mudam (APP_SECRET não pode mudar).
 * Variável definida no ambiente sempre vence o arquivo. Sem AUTO_SECRETS_FILE nada muda.
 */
export const loadAutoSecrets = (processName: string) => {
  const file = process.env.AUTO_SECRETS_FILE;
  if (!file || AUTO_KEYS.every(key => process.env[key])) return;
  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true });
    const fresh = Object.fromEntries(AUTO_KEYS.map(key => [key, randomBytes(32).toString("hex")]));
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(fresh, null, 2), { mode: 0o600 });
    try {
      linkSync(tmp, file); // falha se outro processo criou primeiro; aí vale o arquivo dele
      console.log(`[${processName}] segredos gerados em ${file}`);
    } catch {
      /* API e worker sobem juntos: quem chegou primeiro venceu */
    } finally {
      unlinkSync(tmp);
    }
  }
  const saved = JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
  for (const key of AUTO_KEYS) {
    if (!process.env[key] && saved[key]) process.env[key] = saved[key];
  }
};

const key = () => createHash("sha256").update(process.env.APP_SECRET || "achadinhos-dev-secret").digest();

/**
 * Sem APP_SECRET as credenciais seriam cifradas com a chave fixa acima, que está no código público.
 * Instalações antigas que já cifraram dados com essa chave podem subir com ALLOW_DEFAULT_APP_SECRET=true
 * até migrar (PLANO_CORRECOES.md, A-04).
 */
export const assertAppSecret = (processName: string) => {
  if (process.env.APP_SECRET) return;
  if (process.env.ALLOW_DEFAULT_APP_SECRET === "true") {
    console.warn(`[${processName}] APP_SECRET ausente: usando a chave padrão do código por causa de ALLOW_DEFAULT_APP_SECRET=true.`);
    return;
  }
  console.error(`[${processName}] APP_SECRET não está definido. Defina uma frase longa e aleatória e não troque depois: ela cifra as credenciais das lojas.`);
  process.exit(1);
};

export const encrypt = (plain: string): string => {
  if (!plain) return "";
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}.${tag.toString("base64")}.${data.toString("base64")}`;
};

export const decrypt = (packed: string): string => {
  if (!packed) return "";
  const [ivB64, tagB64, dataB64] = packed.split(".");
  if (!ivB64 || !tagB64 || !dataB64) return "";
  try {
    const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]).toString("utf8");
  } catch {
    return "";
  }
};
