import { readSendCadence } from "./sendCadence";

/**
 * Loja habilitada em Lojas publica em todas as conexões da empresa, sem marcar uma a uma.
 * Lista vazia já significa "todas as lojas"; só a lista com lojas escolhidas precisa ganhar a nova.
 */

/** Intervalo inicial quando a conexão ainda não tem nenhum: uma oferta por hora, por loja. */
export const NEW_STORE_DEFAULT_SECONDS = 3600;

const listOf = (raw: unknown): string[] => {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      value = [];
    }
  }
  return Array.isArray(value) ? value.map(item => String(item)) : [];
};

/** Nova lista com a loja, ou null quando nada muda (lista vazia = todas, ou a loja já está nela). Exportada para teste. */
export const listWithStore = (raw: unknown, marketplace: string): string[] | null => {
  const list = listOf(raw);
  if (!list.length || list.includes(marketplace)) return null;
  return [...list, marketplace];
};

/**
 * Intervalo da loja nova na conexão: o mais longo que a conexão já usa (quem configurou 6 h para o ML não quer
 * a loja nova a cada 2 min, o padrão, que lota os grupos e leva a banimento). Null quando a loja já tem intervalo.
 * Exportada para teste.
 */
export const cadenceWithStore = (raw: unknown, marketplace: string): Record<string, number> | null => {
  const cadence = readSendCadence(raw);
  if (cadence[marketplace]) return null;
  const longest = Math.max(0, ...Object.values(cadence));
  return { ...cadence, [marketplace]: longest || NEW_STORE_DEFAULT_SECONDS };
};
