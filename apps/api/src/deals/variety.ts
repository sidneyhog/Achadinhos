/**
 * Ordem de envio com sorteio ponderado. Ordenar só pela pontuação mandava sempre as mesmas ofertas
 * (as de maior desconto) para todos os grupos e todas as empresas. Aqui a pontuação vira peso:
 * oferta melhor sai antes com mais frequência, mas a ordem muda a cada rodada e em cada empresa.
 */
export const VARIETY_BASE_WEIGHT = 10;
export const URGENT_BONUS = 15;

const TITLE_STOPWORDS = new Set([
  "kit", "com", "para", "por", "sem", "das", "dos", "uma", "um", "novo", "nova", "original", "oficial", "premium",
  "promocao", "oferta", "lancamento", "combo", "unidade", "unidades", "pecas", "peca", "pack", "jogo", "conjunto"
]);

const fold = (value: string) =>
  value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/**
 * Pistas do "tipo" do produto: a categoria (quando a loja manda) e a primeira palavra que importa no título.
 * "Fone de Ouvido Bluetooth JBL" -> ["word:fone"]; com categoria, também "cat:celulares e telefones". Exportada para teste.
 */
export const productTypeKeys = (offer: { title: string; category?: string }): string[] => {
  const keys: string[] = [];
  const category = fold(String(offer.category || "")).split(">")[0].trim();
  if (category && !["link", "extensao", "na fila"].includes(category)) keys.push(`cat:${category}`);
  const word = fold(String(offer.title || ""))
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .find(part => part.length >= 3 && !TITLE_STOPWORDS.has(part));
  if (word) keys.push(`word:${word.length > 4 ? word.replace(/s$/, "") : word}`);
  return keys;
};

/** Quantas ofertas anteriores do lote não podem ser do mesmo tipo da próxima. */
export const TYPE_GAP = 3;

/**
 * Reordena para não sair produto do mesmo tipo em sequência (três air fryers seguidas davam a sensação de ser a
 * mesma oferta). Tipos publicados há pouco (`recent`) vão para o fim. Mantém a ordem do sorteio quando não há
 * conflito; quando todos conflitam, segue a ordem original. Exportada para teste.
 */
export const spreadByType = <T extends { title: string; category?: string }>(items: T[], recent: string[] = []): T[] => {
  const pending = items.map(item => ({ item, keys: productTypeKeys(item) }));
  const recentSet = new Set(recent);
  const out: Array<{ item: T; keys: string[] }> = [];
  const clashes = (keys: string[], against: Set<string>) => keys.some(key => against.has(key));
  while (pending.length) {
    const last = new Set(out.slice(-TYPE_GAP).flatMap(entry => entry.keys));
    let index = pending.findIndex(entry => !clashes(entry.keys, last) && !clashes(entry.keys, recentSet));
    if (index < 0) index = pending.findIndex(entry => !clashes(entry.keys, last));
    if (index < 0) index = 0;
    out.push(pending.splice(index, 1)[0]);
  }
  return out.map(entry => entry.item);
};

/** Sorteio sem reposição proporcional ao peso (corrida exponencial). Exportada para teste. */
export const varietyOrder = <T>(items: T[], weightOf: (item: T) => number, rand: () => number = Math.random): T[] =>
  items
    .map(item => {
      const weight = Math.max(0, weightOf(item)) + VARIETY_BASE_WEIGHT;
      return { item, key: -Math.log(1 - rand()) / weight };
    })
    .sort((a, b) => a.key - b.key)
    .map(entry => entry.item);
