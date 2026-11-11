// Botão "Enviar todos ao Achadinhos" nas listas da Amazon (mais vendidos, novidades, em alta).
// Lê só a página que a pessoa está vendo e só quando ela clica; quem envia ao painel é o background.

const centavosLista = (texto) => {
  const limpo = String(texto || "").replace(/[^\d,]/g, "").replace(",", ".");
  const valor = Math.round(Number(limpo) * 100);
  return Number.isFinite(valor) && valor > 0 ? valor : 0;
};

/** Foto no endereço que o painel aceita (m.media-amazon.com), em tamanho médio. */
const fotoMedia = (src) => {
  const id = String(src || "").match(/\/images\/I\/([A-Za-z0-9+%_-]+)\./);
  return id ? `https://m.media-amazon.com/images/I/${id[1]}._AC_SL500_.jpg` : null;
};

const lerLista = () => {
  const vistos = new Set();
  const produtos = [];
  for (const card of document.querySelectorAll("[data-asin]")) {
    const asin = String(card.dataset.asin || "").toUpperCase();
    if (!/^[A-Z0-9]{10}$/.test(asin) || vistos.has(asin)) continue;
    // Nome: o maior texto dentro dos links do produto.
    const titulo = [...card.querySelectorAll("a[href*='/dp/'] span, a[href*='/dp/'] div")]
      .filter((el) => el.children.length === 0)
      .map((el) => el.textContent.trim())
      .sort((a, b) => b.length - a.length)[0]?.replace(/\s*(…|\.\.\.)$/, "").trim() || "";
    // Preço: o primeiro "R$ 0,00" sozinho dentro do cartão.
    const preco = [...card.querySelectorAll("span")]
      .filter((el) => el.children.length === 0 && /^R\$\s?[\d.]+,\d{2}$/.test(el.textContent.trim()))
      .map((el) => centavosLista(el.textContent))[0] || 0;
    if (titulo.length < 3 || !preco) continue;
    vistos.add(asin);
    produtos.push({ asin, title: titulo, priceCents: preco, originalPriceCents: null, imageUrl: fotoMedia(card.querySelector("img")?.getAttribute("src")) });
  }
  return produtos;
};

const criarBotaoLista = () => {
  if (document.getElementById("achadinhos-enviar-todos")) return;
  const botao = document.createElement("button");
  botao.id = "achadinhos-enviar-todos";
  botao.type = "button";
  const rotulo = () => `Enviar todos ao Achadinhos (${lerLista().length})`;
  botao.textContent = rotulo();
  Object.assign(botao.style, {
    position: "fixed", right: "20px", bottom: "20px", zIndex: "2147483647", padding: "12px 18px",
    border: "0", borderRadius: "999px", background: "#6d28d9", color: "#fff", font: "600 15px system-ui, sans-serif",
    boxShadow: "0 6px 20px rgba(0,0,0,.25)", cursor: "pointer"
  });
  const voltar = () => setTimeout(() => {
    botao.textContent = rotulo();
    botao.style.background = "#6d28d9";
    botao.disabled = false;
  }, 5000);
  botao.addEventListener("click", async () => {
    const produtos = lerLista();
    if (!produtos.length) {
      botao.textContent = "Não achei produtos com preço nesta página";
      botao.style.background = "#dc2626";
      voltar();
      return;
    }
    botao.disabled = true;
    botao.textContent = `Enviando ${produtos.length}…`;
    try {
      const resposta = await chrome.runtime.sendMessage({ tipo: "amazonLista", produtos });
      if (resposta?.ok) {
        botao.textContent = `${resposta.adicionados} na fila ✓ (total ${resposta.fila})`;
        botao.style.background = "#16a34a";
      } else {
        botao.textContent = resposta?.erro || "Não consegui enviar";
        botao.style.background = "#dc2626";
      }
    } catch {
      botao.textContent = "Recarregue a página e tente de novo";
      botao.style.background = "#dc2626";
    }
    voltar();
  });
  document.body.appendChild(botao);
};

// A lista carrega mais produtos ao rolar: o número do botão acompanha.
criarBotaoLista();
setInterval(() => {
  const botao = document.getElementById("achadinhos-enviar-todos");
  if (botao && !botao.disabled && botao.textContent.startsWith("Enviar todos")) botao.textContent = `Enviar todos ao Achadinhos (${lerLista().length})`;
}, 3000);
