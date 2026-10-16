import axios from "axios";
import fs from "node:fs";
import https from "node:https";
import { loadEfiRuntime } from "./platform";

export const efiConfigured = async () => {
  const cfg = await loadEfiRuntime();
  return Boolean(cfg.clientId && cfg.clientSecret && cfg.pixKey);
};

const agent = (cfg: Awaited<ReturnType<typeof loadEfiRuntime>>) => {
  if (!cfg.certReady) return undefined;
  return new https.Agent({
    pfx: fs.readFileSync(cfg.certPath),
    passphrase: cfg.certPassword || undefined
  });
};

const pixBase = (sandbox: boolean) => (sandbox ? "https://pix-h.api.efipay.com.br" : "https://pix.api.efipay.com.br");
const chargeBase = (sandbox: boolean) => (sandbox ? "https://cobrancas-h.api.efipay.com.br" : "https://cobrancas.api.efipay.com.br");

const token = async () => {
  const cfg = await loadEfiRuntime();
  const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64");
  const hosts = cfg.sandbox
    ? ["https://pix-h.auth.efipay.com.br/oauth/token", "https://pix-h.api.efipay.com.br/oauth/token"]
    : ["https://pix.auth.efipay.com.br/oauth/token", "https://pix.api.efipay.com.br/oauth/token"];
  let last: unknown;
  for (const url of hosts) {
    try {
      const { data } = await axios.post(url, "grant_type=client_credentials", {
        headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
        httpsAgent: agent(cfg),
        timeout: 20000
      });
      return String(data.access_token || "");
    } catch (err) {
      last = err;
    }
  }
  throw last;
};

const chargeToken = async () => {
  const cfg = await loadEfiRuntime();
  const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64");
  const { data } = await axios.post(
    `${chargeBase(cfg.sandbox)}/v1/authorize`,
    { grant_type: "client_credentials" },
    {
      headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/json" },
      httpsAgent: agent(cfg),
      timeout: 20000
    }
  );
  const body = data?.data || data;
  return String(body.access_token || "");
};

export const testEfiConnection = async () => {
  const cfg = await loadEfiRuntime();
  if (!cfg.clientId || !cfg.clientSecret) throw new Error("Informe o Client ID e o Client Secret.");
  const access = await token();
  if (!access) throw new Error("A EFI não devolveu um token.");
  return { ok: true, sandbox: cfg.sandbox, pixKey: Boolean(cfg.pixKey), certReady: cfg.certReady };
};

export const createPix = async (input: { amountCents: number; name: string; txid: string }) => {
  const cfg = await loadEfiRuntime();
  const access = await token();
  const value = (input.amountCents / 100).toFixed(2);
  const { data } = await axios.put(
    `${pixBase(cfg.sandbox)}/v2/cob/${input.txid}`,
    {
      calendario: { expiracao: 3600 },
      valor: { original: value },
      chave: cfg.pixKey,
      solicitacaoPagador: `Achadinhos ${input.name}`.slice(0, 140)
    },
    { headers: { Authorization: `Bearer ${access}` }, httpsAgent: agent(cfg), timeout: 20000 }
  );
  const locId = data?.loc?.id;
  let qrcode = "";
  if (locId) {
    const qr = await axios.get(`${pixBase(cfg.sandbox)}/v2/loc/${locId}/qrcode`, {
      headers: { Authorization: `Bearer ${access}` },
      httpsAgent: agent(cfg),
      timeout: 20000
    });
    qrcode = qr.data?.qrcode || "";
  }
  return { txid: data.txid, qrcode, status: data.status };
};

export const createCard = async (input: {
  amountCents: number;
  name: string;
  email: string;
  document: string;
  paymentToken: string;
}) => {
  const cfg = await loadEfiRuntime();
  const access = await chargeToken();
  const { data } = await axios.post(
    `${chargeBase(cfg.sandbox)}/v1/charge/one-step`,
    {
      items: [{ name: "Assinatura Achadinhos", value: input.amountCents, amount: 1 }],
      payment: {
        credit_card: {
          customer: { name: input.name, email: input.email, cpf: input.document },
          installments: 1,
          payment_token: input.paymentToken
        }
      }
    },
    { headers: { Authorization: `Bearer ${access}` }, httpsAgent: agent(cfg), timeout: 20000 }
  );
  return data?.data || data;
};

export const createBoleto = async (input: {
  amountCents: number;
  name: string;
  email: string;
  document: string;
  expireAt: string;
}) => {
  const cfg = await loadEfiRuntime();
  const access = await chargeToken();
  const { data } = await axios.post(
    `${chargeBase(cfg.sandbox)}/v1/charge/one-step`,
    {
      items: [{ name: "Assinatura Achadinhos", value: input.amountCents, amount: 1 }],
      payment: {
        banking_billet: {
          customer: { name: input.name, email: input.email, cpf: input.document },
          expire_at: input.expireAt
        }
      }
    },
    { headers: { Authorization: `Bearer ${access}` }, httpsAgent: agent(cfg), timeout: 20000 }
  );
  return data?.data || data;
};
