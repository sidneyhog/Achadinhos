// Botão "Enviar ao Achadinhos" na página do produto da Amazon.
// Lê só o produto que a pessoa está vendo e só quando ela clica; quem envia ao painel é o background.

const asinDaPagina = () => {
  const campo = document.querySelector("input#ASIN, input[name='ASIN']");
  if (campo?.value && /^[A-Z0-9]{10}$/i.test(campo.value)) return campo.value.toUpperCase();
  const daUrl = location.pathname.match(/\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})(?:[/?]|$)/i);
  return daUrl ? daUrl[1].toUpperCase() : "";
};

/** "R$ 1.234,56" -> 123456 */
const centavos = (texto) => {
  const limpo = String(texto || "").replace(/[^\d,]/g, "").replace(",", ".");
  const valor = Math.round(Number(limpo) * 100);
  return Number.isFinite(valor) && valor > 0 ? valor : 0;
};

const textoDe = (seletores) => {
  for (const seletor of seletores) {
    const texto = document.querySelector(seletor)?.textContent?.trim();
    if (texto) return texto;
  }
  return "";
};

const lerProduto = () => {
  const preco = centavos(textoDe([
    "#corePriceDisplay_desktop_feature_div .priceToPay .a-offscreen",
    "#corePrice_feature_div .a-price .a-offscreen",
    "#corePrice_desktop .a-price .a-offscreen",
    "#apex_desktop .a-price .a-offscreen",
    ".priceToPay .a-offscreen"
  ]));
  const antes = centavos(textoDe([
    "#corePriceDisplay_desktop_feature_div .basisPrice .a-offscreen",
    "#corePrice_desktop .a-text-price .a-offscreen",
    "#corePriceDisplay_desktop_feature_div .a-text-price .a-offscreen"
  ]));
  const foto = document.querySelector("#landingImage, #imgBlkFront");
  return {
    asin: asinDaPagina(),
    title: textoDe(["#productTitle", "#title"]),
    priceCents: preco,
    originalPriceCents: antes > preco ? antes : null,
    imageUrl: foto?.getAttribute("data-old-hires") || foto?.getAttribute("src") || null
  };
};

const avisar = (botao, texto, ok) => {
  botao.textContent = texto;
  botao.style.background = ok ? "#16a34a" : "#dc2626";
  setTimeout(() => {
    botao.textContent = "Enviar ao Achadinhos";
    botao.style.background = "#6d28d9";
    botao.disabled = false;
  }, 4000);
};

const criarBotao = () => {
  if (!asinDaPagina() || document.getElementById("achadinhos-enviar")) return;
  const botao = document.createElement("button");
  botao.id = "achadinhos-enviar";
  botao.type = "button";
  botao.textContent = "Enviar ao Achadinhos";
  Object.assign(botao.style, {
    position: "fixed", right: "20px", bottom: "20px", zIndex: "2147483647", padding: "12px 18px",
    border: "0", borderRadius: "999px", background: "#6d28d9", color: "#fff", font: "600 15px system-ui, sans-serif",
    boxShadow: "0 6px 20px rgba(0,0,0,.25)", cursor: "pointer"
  });
  botao.addEventListener("click", async () => {
    const produto = lerProduto();
    if (!produto.asin || !produto.title || !produto.priceCents) {
      avisar(botao, "Não achei o preço desta página", false);
      return;
    }
    botao.disabled = true;
    botao.textContent = "Enviando…";
    try {
      const resposta = await chrome.runtime.sendMessage({ tipo: "amazon", produto });
      if (resposta?.ok) avisar(botao, `Na fila ✓ (${resposta.fila} produto${resposta.fila === 1 ? "" : "s"})`, true);
      else avisar(botao, resposta?.erro || "Não consegui enviar", false);
    } catch (err) {
      avisar(botao, "Recarregue a página e tente de novo", false);
    }
  });
  document.body.appendChild(botao);
};

criarBotao();
