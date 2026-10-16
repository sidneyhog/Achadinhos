import axios from "axios";

const TRACK_KEY = /^(matt_|meli|tracking_id$|forceInApp$)/i;

export type MlTracking = {
  params: Array<[string, string]>;
  code: string;
};

export type MlTrackingInput = {
  code?: string;
  sample?: string;
  mattTool?: string;
  mattWord?: string;
};

const isHttp = (value: string): boolean => /^https?:\/\//i.test(value);

/** Código numérico antigo vira matt_tool. Código novo (AQRGE8-ZRCR) vira matt_word. */
const applyCode = (url: URL, code: string): void => {
  const trimmed = code.trim();
  if (!trimmed) return;
  if (url.searchParams.has("matt_tool") || url.searchParams.has("matt_word")) return;
  if (/^\d+$/.test(trimmed)) url.searchParams.set("matt_tool", trimmed);
  else url.searchParams.set("matt_word", trimmed);
};

export const resolveMlTracking = async (input: MlTrackingInput): Promise<MlTracking> => {
  const code = String(input.code || "").trim();
  const sample = String(input.sample || "").trim();
  const mattTool = String(input.mattTool || "").replace(/\D/g, "");
  const mattWord = String(input.mattWord || "").trim();
  const params = new Map<string, string>();

  if (isHttp(sample)) {
    const response = await axios.get(sample, {
      maxRedirects: 5,
      timeout: 12000,
      validateStatus: status => status >= 200 && status < 400,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; MultivusAchadinhos/1.0; +https://zapo.multivus.com.br)"
      }
    });
    const finalUrl = String(
      response?.request?.res?.responseUrl ||
        response?.request?.responseURL ||
        sample
    );
    const parsed = new URL(finalUrl);
    parsed.searchParams.forEach((value, key) => {
      if (TRACK_KEY.test(key) && value) params.set(key, value);
    });
  }

  if (mattTool) params.set("matt_tool", mattTool);
  if (mattWord) params.set("matt_word", mattWord);
  if (mattTool || mattWord) params.set("forceInApp", "true");

  if (!code && !params.size) {
    throw new Error("Informe matt_tool e matt_word do Mercado Livre");
  }

  return {
    params: Array.from(params.entries()),
    code: params.has("matt_tool") || params.has("matt_word") ? "" : code
  };
};

export const applyMlTracking = (permalink: string, tracking: MlTracking): string => {
  const url = new URL(permalink);
  tracking.params.forEach(([key, value]) => url.searchParams.set(key, value));
  applyCode(url, tracking.code);
  return url.toString();
};

const CREATE_LINK = "https://www.mercadolivre.com.br/affiliate-program/api/v2/affiliates/createLink";
const LINKBUILDER = "https://www.mercadolivre.com.br/afiliados/linkbuilder";
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

export type MlLinkKind = "meli.la" | "social" | "direto" | "outro";
export type MlVerdict = "COMISSÃO GARANTIDA PELO FORMATO OFICIAL" | "COMISSÃO NÃO COMPROVADA";
export type AffiliateLinkType = "direct" | "social" | "meli_la" | "official" | "unknown";

export type MlLinkReport = {
  kind: MlLinkKind;
  mattTool: string;
  mattWord: string;
  hasRef: boolean;
  forceInApp: boolean;
  verdict: MlVerdict;
  warnings: string[];
};

/** Validade do token nsa_rotok. A sessão de login pode cair antes dessa data. */
export const mercadoLivreCookieExpiry = (cookie: string): Date | null => {
  const token = cookieValue(cookie, "nsa_rotok");
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const padded = part.replace(/-/g, "+").replace(/_/g, "/");
    const json = JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
    const exp = Number(json?.exp);
    if (!Number.isFinite(exp) || exp < 1_000_000_000) return null;
    return new Date(exp * 1000);
  } catch {
    return null;
  }
};

const cookieValue = (cookie: string, name: string): string => {
  const match = String(cookie || "").match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  if (!match) return "";
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
};

const mergeCookies = (base: string, setCookie: unknown): string => {
  const map = new Map<string, string>();
  String(base || "")
    .split(";")
    .forEach(part => {
      const [key, ...rest] = part.trim().split("=");
      if (key) map.set(key, rest.join("="));
    });
  const rows = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  rows.forEach(row => {
    const [key, ...rest] = String(row).split(";")[0].trim().split("=");
    if (key) map.set(key, rest.join("="));
  });
  return [...map.entries()].map(([key, value]) => `${key}=${value}`).join("; ");
};

export const stripMlTracking = (permalink: string): string => {
  const url = new URL(permalink);
  [...url.searchParams.keys()].forEach(key => {
    if (/^(matt_|forceInApp$|ref$)/i.test(key)) url.searchParams.delete(key);
  });
  return url.toString();
};

export const pickOfficialUrl = (payload: unknown): string => {
  const found: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === "string" && /^https?:\/\//i.test(node.trim())) found.push(node.trim());
    else if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === "object") Object.values(node as Record<string, unknown>).forEach(walk);
  };
  walk(payload);
  const short = (item: string): boolean => {
    try {
      const url = new URL(item);
      const host = url.hostname.replace(/^www\./, "");
      return host === "meli.la" || host.endsWith(".meli.la") || /\/sec\//.test(url.pathname);
    } catch {
      return false;
    }
  };
  return (
    found.find(short) ||
    found.find(item => /\/social\//i.test(item) && /[?&]ref=/.test(item)) ||
    found.find(item => /\/social\//i.test(item)) ||
    ""
  );
};

export const reportMlLink = (
  raw: string,
  expected?: { mattTool?: string; mattWord?: string }
): MlLinkReport => {
  const warnings: string[] = [];
  let url: URL | null = null;
  try {
    url = new URL(String(raw || "").trim());
  } catch {
    return {
      kind: "outro",
      mattTool: "",
      mattWord: "",
      hasRef: false,
      forceInApp: false,
      verdict: "COMISSÃO NÃO COMPROVADA",
      warnings: ["O último link não é uma URL válida."]
    };
  }
  const host = url.hostname.replace(/^www\./, "");
  const kind: MlLinkKind =
    host === "meli.la" || host.endsWith(".meli.la") || /\/sec\//.test(url.pathname)
      ? "meli.la"
      : url.pathname.startsWith("/social/")
        ? "social"
        : url.searchParams.has("matt_tool") || url.searchParams.has("matt_word")
          ? "direto"
          : "outro";
  const mattTool = url.searchParams.get("matt_tool") || "";
  const mattWord = url.searchParams.get("matt_word") || "";
  const ref = url.searchParams.get("ref") || "";
  const hasRef = ref.length > 8;
  const forceInApp = url.searchParams.get("forceInApp") === "true";
  if (kind === "direto") {
    warnings.push("Abre o produto direto. Tem matt_tool e matt_word, mas não tem ref nem a página /social/.");
  }
  if (kind === "social" && !hasRef) {
    warnings.push("A página /social/ está sem o ref gerado pelo Mercado Livre.");
  }
  if (kind === "meli.la") {
    warnings.push("Link curto oficial. O ref aparece no destino, depois do redirect.");
  }
  if (kind === "outro") warnings.push("Este endereço não é um link de afiliado reconhecido.");
  if (expected?.mattTool && mattTool && mattTool !== expected.mattTool) {
    warnings.push("O matt_tool do link não é o da conta salva.");
  }
  if (expected?.mattWord && mattWord && mattWord !== expected.mattWord) {
    warnings.push("O matt_word do link não é o da conta salva.");
  }
  const mismatch =
    (!!expected?.mattTool && !!mattTool && mattTool !== expected.mattTool) ||
    (!!expected?.mattWord && !!mattWord && mattWord !== expected.mattWord);
  const official = kind === "meli.la" || (kind === "social" && hasRef);
  return {
    kind,
    mattTool,
    mattWord,
    hasRef,
    forceInApp,
    verdict: official && !mismatch ? "COMISSÃO GARANTIDA PELO FORMATO OFICIAL" : "COMISSÃO NÃO COMPROVADA",
    warnings
  };
};

export const createOfficialMlLink = async (input: {
  cookie: string;
  tag?: string;
  productUrl: string;
}): Promise<string> => {
  const cookie = String(input.cookie || "").trim();
  const tag = String(input.tag || "").trim();
  const productUrl = stripMlTracking(input.productUrl);
  if (!cookie.includes("=")) {
    throw new Error("Cole o Cookie da requisição createLink, já logado no gerador.");
  }
  if (!tag) throw new Error("Informe a etiqueta do Mercado Livre para gerar o link oficial.");
  const page = await axios.get(LINKBUILDER, {
    headers: { Cookie: cookie, "User-Agent": BROWSER_UA, Accept: "text/html" },
    maxRedirects: 0,
    timeout: 20000,
    validateStatus: status => status < 500
  });
  if (page.status >= 300 && page.status < 400) {
    const location = String(page.headers?.location || "");
    if (/login|registration|jms\/mlb\/lgz/i.test(location)) {
      throw new Error("A sessão do Mercado Livre expirou. Cole o Cookie de novo.");
    }
  }
  const nextCookie = mergeCookies(cookie, page.headers?.["set-cookie"]);
  const html = typeof page.data === "string" ? page.data : "";
  const csrf =
    html.match(/csrf-token"\s+content="([^"]+)"/i)?.[1] ||
    html.match(/csrfToken\\?"?\s*[:=]\s*\\?"([A-Za-z0-9_-]{8,})/)?.[1] ||
    cookieValue(nextCookie, "_csrf");
  if (!csrf) throw new Error("Não achei o token da sessão. Abra o gerador logado e copie o Cookie de novo.");
  const response = await axios.post(
    CREATE_LINK,
    { urls: [productUrl], tag },
    {
      headers: {
        Cookie: nextCookie,
        "x-csrf-token": csrf,
        Accept: "application/json, text/plain, */*",
        Origin: "https://www.mercadolivre.com.br",
        Referer: LINKBUILDER,
        "User-Agent": BROWSER_UA,
        "Content-Type": "application/json"
      },
      timeout: 20000,
      validateStatus: () => true
    }
  );
  if (response.status === 401 || response.status === 403) {
    throw new Error("O Mercado Livre recusou a sessão. Atualize o Cookie.");
  }
  const url = pickOfficialUrl(response.data);
  if (!url) throw new Error("O gerador não devolveu meli.la nem /social/.");
  return url;
};

export const affiliateLinkTypeOf = (report: MlLinkReport, fromGenerator = false): AffiliateLinkType => {
  if (report.kind === "meli.la") return "meli_la";
  if (report.kind === "social") return "social";
  if (fromGenerator && report.verdict === "COMISSÃO GARANTIDA PELO FORMATO OFICIAL") return "official";
  if (report.kind === "direto") return "direct";
  return "unknown";
};

export const mlPublishLogs = (report: MlLinkReport, fellBack: boolean): string[] => {
  if (report.verdict === "COMISSÃO GARANTIDA PELO FORMATO OFICIAL") {
    const lines = ["[OK] Link oficial gerado", "[OK] afiliado validado"];
    if (report.kind === "meli.la") lines.splice(1, 0, "[OK] meli.la criado");
    if (report.hasRef || report.kind === "meli.la") lines.push("[OK] ref detectado");
    return lines;
  }
  if (fellBack) {
    return [
      "[ERRO] Sessão Mercado Livre expirada",
      "[INFO] Fallback para link direto",
      "[AVISO] Comissão não comprovada"
    ];
  }
  return ["[AVISO] Comissão não comprovada"];
};
