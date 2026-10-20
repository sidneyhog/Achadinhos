/**
 * Ordem de envio com sorteio ponderado. Ordenar só pela pontuação mandava sempre as mesmas ofertas
 * (as de maior desconto) para todos os grupos e todas as empresas. Aqui a pontuação vira peso:
 * oferta melhor sai antes com mais frequência, mas a ordem muda a cada rodada e em cada empresa.
 */
export const VARIETY_BASE_WEIGHT = 10;
export const URGENT_BONUS = 15;

/** Sorteio sem reposição proporcional ao peso (corrida exponencial). Exportada para teste. */
export const varietyOrder = <T>(items: T[], weightOf: (item: T) => number, rand: () => number = Math.random): T[] =>
  items
    .map(item => {
      const weight = Math.max(0, weightOf(item)) + VARIETY_BASE_WEIGHT;
      return { item, key: -Math.log(1 - rand()) / weight };
    })
    .sort((a, b) => a.key - b.key)
    .map(entry => entry.item);
