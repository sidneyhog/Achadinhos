const status = document.getElementById("status");
const botao = document.getElementById("copiar");
const campo = document.getElementById("codigo");
const ligar = document.getElementById("ligar");
const desligar = document.getElementById("desligar");
const auto = document.getElementById("auto");

const avisar = (alvo, texto, tipo) => {
  alvo.textContent = texto;
  alvo.className = tipo;
};

const data = (valor) => new Date(valor).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });

const mostrarAuto = async () => {
  const { codigo, ultimo } = await chrome.storage.local.get(["codigo", "ultimo"]);
  const ligado = Boolean(lerCodigo(codigo));
  campo.hidden = ligado;
  ligar.hidden = ligado;
  desligar.hidden = !ligado;
  if (!ligado) return avisar(auto, "Cole o código gerado no painel em Automação.", "");
  if (!ultimo) return avisar(auto, "Ligado. O primeiro envio sai em instantes.", "ok");
  avisar(
    auto,
    ultimo.ok
      ? `Ligado. Último envio: ${data(ultimo.em)}.${ultimo.ate ? ` Cookie válido até ${new Date(ultimo.ate).toLocaleDateString("pt-BR")}.` : ""}`
      : `Ligado, mas o último envio (${data(ultimo.em)}) falhou: ${ultimo.erro}`,
    ultimo.ok ? "ok" : "erro"
  );
};

botao.addEventListener("click", async () => {
  botao.disabled = true;
  try {
    const cookie = await lerCookie();
    if (!cookie) {
      avisar(status, "Você não está logado no Mercado Livre neste navegador. Entre na conta e tente de novo.", "erro");
      return;
    }
    await navigator.clipboard.writeText(cookie.texto);
    avisar(
      status,
      cookie.ate ? `Copiado. Válido até ${cookie.ate.toLocaleDateString("pt-BR")}. Cole no painel e salve.` : "Copiado. Cole no painel e salve.",
      "ok"
    );
  } catch (err) {
    avisar(status, `Não consegui copiar: ${err?.message || err}`, "erro");
  } finally {
    botao.disabled = false;
  }
});

ligar.addEventListener("click", async () => {
  if (!lerCodigo(campo.value)) return avisar(auto, "Código inválido. Copie de novo no painel, em Automação.", "erro");
  ligar.disabled = true;
  await chrome.storage.local.set({ codigo: campo.value.trim(), ultimo: null });
  campo.value = "";
  avisar(auto, "Enviando…", "");
  await chrome.runtime.sendMessage({ tipo: "enviar" });
  ligar.disabled = false;
  await mostrarAuto();
});

desligar.addEventListener("click", async () => {
  await chrome.storage.local.remove(["codigo", "ultimo"]);
  await mostrarAuto();
});

void mostrarAuto();
