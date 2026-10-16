// Monta o mesmo cabeçalho Cookie que o navegador manda para o gerador de links do ML.
// Nada sai do navegador: o texto vai só para a área de transferência.
const ALVO = "https://www.mercadolivre.com.br/afiliados/linkbuilder";

const status = document.getElementById("status");
const botao = document.getElementById("copiar");

const avisar = (texto, tipo) => {
  status.textContent = texto;
  status.className = tipo;
};

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

botao.addEventListener("click", async () => {
  botao.disabled = true;
  try {
    const cookies = await chrome.cookies.getAll({ url: ALVO });
    const nomes = new Set(cookies.map((cookie) => cookie.name));
    if (!nomes.has("ssid")) {
      avisar("Você não está logado no Mercado Livre neste navegador. Entre na conta e tente de novo.", "erro");
      return;
    }
    const texto = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
    await navigator.clipboard.writeText(texto);
    const ate = validade(cookies.find((cookie) => cookie.name === "nsa_rotok")?.value || "");
    avisar(
      ate
        ? `Copiado. Válido até ${ate.toLocaleDateString("pt-BR")}. Cole no painel e salve.`
        : "Copiado. Cole no painel e salve.",
      "ok"
    );
  } catch (err) {
    avisar(`Não consegui copiar: ${err?.message || err}`, "erro");
  } finally {
    botao.disabled = false;
  }
});
