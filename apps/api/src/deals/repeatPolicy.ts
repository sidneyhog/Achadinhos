/** Quanto tempo uma oferta (ou uma variação dela) fica sem voltar ao mesmo grupo ou Status. */
export const REPEAT_HOURS = 72;

/**
 * Variações do mesmo anúncio (cor, voltagem) têm outro código no ML, mas o título começa igual:
 * "Lava E Seca Samsung Wd11m Com Digital Inverter Bra" e "... Ino". Compara os primeiros 40 caracteres.
 */
export const TITLE_KEY_CHARS = 40;

export const titleKey = (title: string) =>
  String(title || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, TITLE_KEY_CHARS)
    .toLowerCase();

/** Mesmo cálculo de `titleKey`, feito pelo Postgres sobre a coluna `title` de posts. */
export const TITLE_KEY_SQL = `lower(left(btrim(regexp_replace(title, '\\s+', ' ', 'g')), ${TITLE_KEY_CHARS}))`;

/** Já saiu no destino nas últimas REPEAT_HOURS? Mesmo produto, mesmo link ou título que começa igual. */
export const REPEAT_SQL = `created_at > now() - interval '${REPEAT_HOURS} hours'`;
