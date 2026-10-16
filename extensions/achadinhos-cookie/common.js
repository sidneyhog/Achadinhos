// Partes usadas pelo popup e pelo envio automático.
const ALVO = "https://www.mercadolivre.com.br/afiliados/linkbuilder";

/** Validade do nsa_rotok (JWT). O painel usa o mesmo campo para avisar antes de vencer. */
const validade = (valor) => {
  try {
    const parte = decodeURIComponent(valor).split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const exp = Number(JSON.parse(atob(parte)).exp);
    return Number.isFinite(exp) ? new Date(exp * 1000) : null;
  } catch {
    return null;
  }
};

/** Mesmo cabeçalho Cookie que o navegador manda ao gerador de links do ML. */
const lerCookie = async () => {
  const cookies = await chrome.cookies.getAll({ url: ALVO });
  if (!cookies.some((cookie) => cookie.name === "ssid")) return null;
  return {
    texto: cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; "),
    ate: validade(cookies.find((cookie) => cookie.name === "nsa_rotok")?.value || "")
  };
};

/** Código do painel: "https://endereco-do-painel|ach_...". */
const lerCodigo = (codigo) => {
  const [painel, chave] = String(codigo || "").trim().split("|");
  try {
    const url = new URL(painel);
    if (!/^https?:$/.test(url.protocol) || !/^ach_[0-9a-f]{48}$/.test(chave || "")) return null;
    return { painel: url.origin, chave };
  } catch {
    return null;
  }
};

/** Manda o cookie atual ao painel e guarda o resultado para o popup mostrar. */
const enviarCookie = async () => {
  const { codigo } = await chrome.storage.local.get("codigo");
  const destino = lerCodigo(codigo);
  if (!destino) return { ok: false, erro: "Envio automático desligado." };
  // Abre o gerador uma vez para o Mercado Livre renovar a sessão, se ele quiser.
  await fetch(ALVO, { credentials: "include" }).catch(() => undefined);
  const cookie = await lerCookie();
  let resultado;
  if (!cookie) {
    resultado = { ok: false, erro: "Você não está logado no Mercado Livre neste navegador." };
  } else {
    try {
      const resposta = await fetch(`${destino.painel}/api/extension/ml-cookie`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Achadinhos-Key": destino.chave },
        body: JSON.stringify({ cookie: cookie.texto })
      });
      const dados = await resposta.json().catch(() => ({}));
      resultado = resposta.ok
        ? { ok: true, ate: dados.expiresAt || (cookie.ate ? cookie.ate.toISOString() : null) }
        : { ok: false, erro: dados.error || `O painel respondeu ${resposta.status}.` };
    } catch (err) {
      resultado = { ok: false, erro: `Não consegui falar com o painel: ${err?.message || err}` };
    }
  }
  await chrome.storage.local.set({ ultimo: { ...resultado, em: new Date().toISOString() } });
  return resultado;
};
