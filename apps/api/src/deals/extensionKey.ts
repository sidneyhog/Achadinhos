import crypto from "node:crypto";

/** Chave que a extensão usa para mandar o cookie do Mercado Livre sozinha. Só o hash fica no banco. */
export const newExtensionKey = () => {
  const key = `ach_${crypto.randomBytes(24).toString("hex")}`;
  return { key, hash: hashExtensionKey(key) };
};

export const hashExtensionKey = (key: string) => crypto.createHash("sha256").update(String(key || "").trim()).digest("hex");

export const looksLikeExtensionKey = (key: string) => /^ach_[0-9a-f]{48}$/.test(String(key || "").trim());

/** Cookie com sessão do ML: precisa do ssid e não pode ser um texto qualquer gigante. */
export const isMlSessionCookie = (cookie: string) => {
  const value = String(cookie || "").trim();
  if (!value || value.length > 20_000) return false;
  return /(^|;\s*)ssid=[^;\s]+/.test(value);
};
