import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api, getToken } from "./api";
import type { Session } from "./App";
import { Mark } from "./Mark";
import { StatusTab } from "./StatusTab";
import { BillingView } from "./BillingView";
import { go, PANEL_PATH, usePath } from "./route";

const STORES = [
  { id: "ml", label: "Mercado Livre", logo: "ml.svg" },
  { id: "aliexpress", label: "AliExpress", logo: "aliexpress.svg" },
  { id: "amazon", label: "Amazon", logo: "amazon.svg" },
  { id: "shopee", label: "Shopee", logo: "shopee.svg" },
  { id: "magalu", label: "Magalu", logo: "magalu.svg" },
  { id: "terabyte", label: "Terabyte", logo: "terabyte.svg" },
  { id: "awin", label: "Awin", logo: "awin.svg" },
  { id: "rakuten", label: "Rakuten Advertising", logo: "rakuten.svg" },
  { id: "samsung", label: "Clube Samsung", logo: "samsung.svg" },
  { id: "casasbahia", label: "Casas Bahia", logo: "casasbahia.svg" },
  { id: "natura", label: "Natura", logo: "natura.svg" },
  { id: "paguemenos", label: "Pague Menos", logo: "paguemenos.svg" },
  { id: "epoca", label: "Época Cosméticos", logo: "epoca.svg" },
  { id: "shein", label: "Shein", logo: "shein.svg" }
];

const NAV = [
  ["dash", "Dashboard"],
  ["stores", "Lojas"],
  ["campaigns", "Campanhas"],
  ["offers", "Ofertas"],
  ["posts", "Publicações"],
  ["groups", "Conexões"],
  ["contacts", "Contatos"],
  ["links", "Links afiliados"],
  ["analytics", "Analytics"],
  ["auto", "Automação"],
  ["help", "Material de apoio"],
  ["billing", "Minha assinatura"],
  ["config", "Configurações"]
] as const;

type View = (typeof NAV)[number][0];

const money = (cents: number) => (Number(cents || 0) / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

const moneyToCents = (raw: unknown) => {
  const text = String(raw || "").trim().replace(/\s/g, "").replace(/^R\$/i, "");
  if (!text) return null;
  const normalized = text.includes(",") ? text.replace(/\./g, "").replace(",", ".") : text;
  const value = Number(normalized);
  return Number.isFinite(value) ? Math.round(value * 100) : null;
};

const clockToMinutes = (value: unknown) => {
  if (value == null || value === "") return null;
  const text = String(value);
  if (text.includes(":")) {
    const [hourText, minuteText] = text.split(":");
    const hour = Number(hourText);
    const minute = Number(minuteText);
    if (!Number.isFinite(hour) || !Number.isFinite(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
    return hour * 60 + minute;
  }
  const numeric = Number(text);
  if (!Number.isFinite(numeric)) return null;
  const rounded = Math.round(numeric);
  return rounded >= 0 && rounded <= 23 ? rounded * 60 : Math.min(Math.max(rounded, 0), 24 * 60);
};

const phoneOf = (phone: string) => {
  const digits = String(phone || "").replace(/\D/g, "");
  if (digits.length < 10) return "Sem número";
  if (digits.startsWith("55") && digits.length >= 12) return `+55 ${digits.slice(2, 4)} ${digits.slice(4, 9)}-${digits.slice(9)}`;
  return `+${digits}`;
};

const stamp = (value?: string) => value ? new Date(value).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }) : "ainda não";
const dayOf = (value?: string) => value ? new Date(value).toLocaleDateString("pt-BR") : "—";

type WaPhase = "on" | "qr" | "off" | "bad";

const waPhase = (item: { status?: string; last_error?: string | null }): WaPhase => {
  const status = String(item.status || "");
  if (status === "connected") return "on";
  if (status === "qrcode" || status === "opening") return "qr";
  if (status === "error" || item.last_error) return "bad";
  if (status === "reconnecting") return "qr";
  return "off";
};

const waLabel = (item: { status?: string; last_error?: string | null }, place: "card" | "modal") => {
  const phase = waPhase(item);
  const status = String(item.status || "");
  if (phase === "on") return place === "card" ? "Online agora" : "Conectado";
  if (phase === "qr") {
    if (status === "opening") return "Gerando QR";
    if (status === "reconnecting") return "Reconectando";
    return "Aguardando QR";
  }
  if (phase === "bad") return place === "card" ? "Erro" : "Erro de conexão";
  return "Desconectado";
};

const prettyPhone = (value?: string) => {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.startsWith("55") && (digits.length === 12 || digits.length === 13)) {
    const ddd = digits.slice(2, 4);
    const rest = digits.slice(4);
    const split = rest.length === 9 ? 5 : 4;
    return `+55 ${ddd} ${rest.slice(0, split)}-${rest.slice(split)}`;
  }
  return digits ? `+${digits}` : "—";
};

const personMark = (name?: string) => {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  return (parts[0][0] + (parts[1]?.[0] || "")).toUpperCase();
};

const minutesToClock = (value: unknown) => {
  const total = clockToMinutes(value);
  if (total == null) return "";
  const hour = Math.floor(total / 60) % 24;
  const minute = total % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
};

const ago = (iso?: string | null) => {
  if (!iso) return "ainda não";
  const sec = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (sec < 5) return "agora";
  if (sec < 60) return `há ${sec} s`;
  const min = Math.floor(sec / 60);
  const rest = sec % 60;
  if (min < 60) return rest ? `há ${min} min ${rest} s` : `há ${min} min`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `há ${hours} h`;
  return `há ${Math.round(hours / 24)} d`;
};

const formatClock = (seconds: number) => {
  const left = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(left / 3600);
  const minutes = Math.floor((left % 3600) / 60);
  const secs = left % 60;
  if (hours) return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  return `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
};

const speakWait = (seconds: number) => {
  const left = Math.max(0, Math.floor(Number(seconds) || 0));
  if (left <= 0) return "agora";
  const minutes = Math.floor(left / 60);
  const secs = left % 60;
  if (!minutes) return `${secs} s`;
  return secs ? `${minutes} min ${secs} s` : `${minutes} min`;
};

const Icon = ({ name }: { name: string }) => {
  const common = {
    className: "aff-ico",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true
  };
  if (name === "dash") return <svg {...common}><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></svg>;
  if (name === "stores") return <svg {...common}><path d="M4 9h16l-1 11H5L4 9z" /><path d="M8 9V7a4 4 0 0 1 8 0v2" /></svg>;
  if (name === "campaigns") return <svg {...common}><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3" /><path d="M12 2v2M12 20v2M2 12h2M20 12h2" /></svg>;
  if (name === "offers") return <svg {...common}><path d="M12 3l2.2 4.6L19 8.2l-3.5 3.4.8 4.9L12 14.8 7.7 16.5l.8-4.9L5 8.2l4.8-.6L12 3z" /></svg>;
  if (name === "posts") return <svg {...common}><path d="M4 6h16M4 12h10M4 18h7" /><path d="M16 15l2 2 4-4" /></svg>;
  if (name === "groups") return <svg {...common}><path d="M16 19v-1a3 3 0 0 0-3-3H7a3 3 0 0 0-3 3v1" /><circle cx="10" cy="8" r="3" /><path d="M20 19v-1a3 3 0 0 0-2.2-2.9" /><path d="M16 5.1a3 3 0 0 1 0 5.8" /></svg>;
  if (name === "contacts") return <svg {...common}><circle cx="12" cy="8" r="3" /><path d="M5 19v-1a5 5 0 0 1 5-5h4a5 5 0 0 1 5 5v1" /></svg>;
  if (name === "links") return <svg {...common}><path d="M10 13a5 5 0 0 0 7.1.1l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1" /><path d="M14 11a5 5 0 0 0-7.1-.1l-2 2a5 5 0 0 0 7.1 7.1l1.1-1.1" /></svg>;
  if (name === "analytics") return <svg {...common}><path d="M4 19V5" /><path d="M4 19h16" /><path d="M8 16v-4" /><path d="M12 16V8" /><path d="M16 16v-6" /></svg>;
  if (name === "auto") return <svg {...common}><rect x="3" y="4" width="6" height="5" rx="1" /><rect x="15" y="15" width="6" height="5" rx="1" /><path d="M6 9v3h12V9" /><path d="M18 12v3" /></svg>;
  if (name === "config") return <svg {...common}><circle cx="12" cy="12" r="3" /><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4" /></svg>;
  if (name === "billing") return <svg {...common}><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 10h18M7 15h4" /></svg>;
  if (name === "menu") return <svg {...common}><path d="M4 7h16M4 12h16M4 17h16" /></svg>;
  if (name === "help") return <svg {...common}><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" /></svg>;
  return <svg {...common}><circle cx="12" cy="12" r="8" /></svg>;
};

const GUIDES = [
  ["whatsapp", "WA", "WhatsApp", "Implementado", "Como conectar o WhatsApp", "5 min · Primeiros passos · Iniciante", "Cada conexão mostra os grupos dela. Uma conexão pode ficar só com uma loja."],
  ["telegram", "TG", "Telegram", "Implementação parcial", "Publicar no Telegram", "8 min · Primeiros passos · Iniciante", "Dá para ter vários bots. Cada um fica com a própria loja ou categoria."],
  ["ml", "ML", "Mercado Livre", "Implementado", "Configurar o Mercado Livre", "10 min · Lojas · Intermediário", "Conta e Matt Tool saem de um link seu. Cookie só entra no link oficial."],
  ["shein", "SH", "Shein", "Implementação parcial", "Configurar a Shein", "8 min · Lojas · Avançado", "A Shein identifica a conta no link onelink. O Achadinhos guarda esse código."],
  ["rakuten", "RA", "Rakuten Advertising", "Implementação parcial", "Configurar a Rakuten", "12 min · Lojas · Intermediário", "Client ID, Client Secret e SID liberam a busca de produtos da Rakuten."],
  ["ali", "AE", "AliExpress", "Implementado", "Configurar a AliExpress", "15 min · Lojas · Avançado", "App Key, Secret e Tracking ID. Sem eles a busca de produtos entra no lugar."],
  ["awin", "AW", "Awin", "Implementação parcial", "Configurar a Awin", "10 min · Lojas · Intermediário", "Id do publisher e o token da API. Clube Samsung e Casas Bahia usam a mesma conta."],
  ["shopee", "SP", "Shopee", "Implementação parcial", "Configurar a Shopee", "15 min · Lojas · Avançado", "A publicação automática espera App ID e Secret da API de afiliados."],
  ["amazon", "AM", "Amazon", "Implementação parcial", "Configurar a Amazon", "5 min · Lojas · Iniciante", "A Partner Tag conecta a conta. Sem a API, o robô publica os links que você colar."],
  ["epoca", "EP", "Época Cosméticos", "Implementado", "Configurar a Época", "5 min · Lojas · Iniciante", "A Época está na Lomadee. Basta a chave da API do painel da Lomadee."]
];

/**
 * Como conectar cada loja, em linguagem de cliente. Aparece no topo da janela Configurar de cada loja
 * e no Material de apoio. auto = o robô busca e publica ofertas sozinho; false = só identifica a conta.
 */
const STORE_HELP: Record<string, { auto: boolean; time: string; portal?: [string, string]; steps: string[] }> = {
  ml: {
    auto: true,
    time: "10 min",
    portal: ["Abrir o gerador de links do ML", "https://www.mercadolivre.com.br/afiliados/linkbuilder"],
    steps: [
      "No gerador de links do Mercado Livre, gere um link de afiliado de qualquer produto e copie.",
      "Cole em Colar um link para preencher, aqui embaixo. Conta e Matt Tool se preenchem sozinhos.",
      "Baixe a extensão na página Automação e instale no Chrome ou no Edge.",
      "Logado no Mercado Livre, clique na extensão e em Copiar cookie. Cole em Cookie do gerador.",
      "Deixe Gerar link oficial marcado e clique em Testar link oficial. Deu certo se aparecer um link meli.la.",
      "O cookie vale cerca de 30 dias. O painel avisa 2 dias antes: é só copiar e colar de novo."
    ]
  },
  shopee: {
    auto: true,
    time: "15 min",
    portal: ["Abrir o portal de afiliados da Shopee", "https://affiliate.shopee.com.br"],
    steps: [
      "No portal de afiliados da Shopee, abra a área Open API e peça o acesso. A liberação pode levar alguns dias.",
      "Com o acesso liberado, copie o App ID e o Secret que a Shopee mostra.",
      "Cole os dois aqui, marque Publicar esta loja e salve."
    ]
  },
  aliexpress: {
    auto: true,
    time: "15 min",
    portal: ["Abrir o AliExpress Portals", "https://portals.aliexpress.com"],
    steps: [
      "No AliExpress Portals (programa de afiliados), crie um app de API. Ele mostra App Key e App Secret.",
      "No mesmo portal, copie o seu Tracking ID.",
      "Cole os três aqui, marque Publicar esta loja e salve."
    ]
  },
  amazon: {
    auto: true,
    time: "5 min",
    portal: ["Abrir o Amazon Associados", "https://associados.amazon.com.br"],
    steps: [
      "No Amazon Associados, copie a sua Partner Tag (termina em -20). Também pode colar um link seu com tag=.",
      "Em Links dos produtos, cole um produto por linha: link | nome | preço. Vale o link da página (amazon.com.br/dp/...) ou o link curto da barra SiteStripe (amzn.to/...). O robô põe a sua tag e publica um por vez.",
      "A busca automática depende da Creators API da Amazon, que só é liberada para contas com vendas recentes. Até lá, use os links colados."
    ]
  },
  awin: {
    auto: true,
    time: "10 min",
    portal: ["Abrir o painel da Awin", "https://ui.awin.com"],
    steps: [
      "No painel da Awin, copie o seu Id do publisher (aparece no topo, ao lado do nome da conta).",
      "Em Ferramentas → API Credentials, gere o token da API e copie.",
      "Cole os dois aqui e salve. Clube Samsung, Casas Bahia, Natura e Pague Menos usam esta mesma conta."
    ]
  },
  samsung: {
    auto: true,
    time: "2 min",
    portal: ["Abrir o painel da Awin", "https://ui.awin.com"],
    steps: [
      "Configure a loja Awin primeiro: esta loja usa o mesmo publisher e token.",
      "Na Awin, inscreva-se no programa Clube Samsung e espere a aprovação.",
      "Aprovado, salve aqui. Não precisa colar nada."
    ]
  },
  casasbahia: {
    auto: true,
    time: "2 min",
    portal: ["Abrir o painel da Awin", "https://ui.awin.com"],
    steps: [
      "Configure a loja Awin primeiro: esta loja usa o mesmo publisher e token.",
      "Na Awin, inscreva-se no programa Casas Bahia e espere a aprovação.",
      "Aprovado, salve aqui. Não precisa colar nada."
    ]
  },
  natura: {
    auto: true,
    time: "2 min",
    portal: ["Abrir o painel da Awin", "https://ui.awin.com"],
    steps: [
      "Configure a loja Awin primeiro: esta loja usa o mesmo publisher e token.",
      "Na Awin, inscreva-se no programa Natura e espere a aprovação.",
      "Aprovado, salve aqui. Não precisa colar nada."
    ]
  },
  paguemenos: {
    auto: true,
    time: "2 min",
    portal: ["Abrir o painel da Awin", "https://ui.awin.com"],
    steps: [
      "Configure a loja Awin primeiro: esta loja usa o mesmo publisher e token.",
      "Na Awin, inscreva-se no programa Pague Menos e espere a aprovação.",
      "Aprovado, salve aqui. Não precisa colar nada."
    ]
  },
  rakuten: {
    auto: true,
    time: "12 min",
    portal: ["Abrir o painel da Rakuten", "https://cli.linksynergy.com"],
    steps: [
      "No painel da Rakuten Advertising, abra a área de desenvolvedor (Web Services) e copie Client ID e Client Secret.",
      "Copie também o SID: é o número do seu site, que aparece no menu da conta.",
      "Cole os três aqui, marque Publicar esta loja e salve."
    ]
  },
  epoca: {
    auto: true,
    time: "5 min",
    portal: ["Abrir a Lomadee", "https://www.lomadee.com"],
    steps: [
      "A Época Cosméticos fica na Lomadee. No painel da Lomadee, copie a sua chave da API (x-api-key).",
      "Cole aqui e salve. O robô busca o catálogo e publica com o seu link."
    ]
  },
  shein: {
    auto: false,
    time: "5 min",
    steps: [
      "Gere um link de afiliado da Shein (começa com onelink.shein.com) e cole aqui.",
      "Salve. O card passa de Pendente para Conectada quando a conta é reconhecida.",
      "A Shein não entrega lista de produtos, então o robô não publica Shein sozinho."
    ]
  },
  magalu: {
    auto: false,
    time: "5 min",
    portal: ["Abrir o Parceiro Magalu", "https://www.magazinevoce.com.br"],
    steps: [
      "Copie o nome da sua loja (o final do endereço da sua loja Magalu) e o seu Promoter Id.",
      "Cole os dois aqui e salve.",
      "A Magalu não entrega lista de produtos, então o robô não publica Magalu sozinho."
    ]
  },
  terabyte: {
    auto: false,
    time: "3 min",
    steps: [
      "Copie o seu ID de afiliado da Terabyte e cole aqui.",
      "Salve. Ele entra nos links de produto da Terabyte.",
      "A Terabyte não entrega lista de produtos, então o robô não publica Terabyte sozinho."
    ]
  }
};

/** Caixa "Como conectar" no topo da janela de cada loja. */
function StoreHowTo({ id }: { id: string }) {
  const help = STORE_HELP[id];
  if (!help) return null;
  return (
    <details className="aff-howto" open>
      <summary>
        <strong>Como conectar</strong>
        <span className={`aff-howto__tag${help.auto ? " is-auto" : ""}`}>{help.auto ? "Publica sozinho" : "Só identifica a conta"}</span>
        <span className="aff-howto__time">{help.time}</span>
      </summary>
      <ol>{help.steps.map((step) => <li key={step}>{step}</li>)}</ol>
      {help.portal ? <a href={help.portal[1]} target="_blank" rel="noopener noreferrer">{help.portal[0]} ↗</a> : null}
    </details>
  );
}

/** Passo a passo de cada guia do Material de apoio. As lojas usam o mesmo texto da janela Configurar. */
const GUIDE_STEPS: Record<string, string[]> = {
  whatsapp: [
    "Vá em Conexões e clique em Nova conexão. Escolha WhatsApp e dê um nome (ex.: AchadosSp).",
    "Clique em Conectar WhatsApp. Aparece um QR code.",
    "No celular: WhatsApp → Aparelhos conectados → Conectar aparelho, e aponte para o QR code.",
    "Com a conexão verde, marque os grupos que vão receber as ofertas.",
    "Use um número só para o robô. Se o QR expirar, clique em Gerar novo QR."
  ],
  telegram: [
    "No Telegram, abra o @BotFather, mande /newbot e siga as perguntas. Ele devolve um token (ex.: 123456:ABC...).",
    "Adicione o bot como administrador no grupo ou canal que vai receber as ofertas.",
    "No painel, Conexões → Nova conexão → Telegram. Cole o token do BotFather e crie.",
    "Escolha os chats e as lojas que esse bot publica."
  ],
  ml: STORE_HELP.ml.steps,
  shopee: STORE_HELP.shopee.steps,
  ali: STORE_HELP.aliexpress.steps,
  awin: STORE_HELP.awin.steps,
  rakuten: STORE_HELP.rakuten.steps,
  shein: STORE_HELP.shein.steps,
  amazon: STORE_HELP.amazon.steps,
  epoca: STORE_HELP.epoca.steps
};

const EXTRA_FORMS: Record<string, { hint: string; fields: Array<{ key: string; label: string; placeholder: string; secret?: boolean; locked?: boolean }> }> = {
  magalu: {
    hint: "O nome da loja é o endereço da Magazine Você. O Promoter Id identifica a conta. O programa não entrega uma lista de produtos, então o card pode ficar conectado sem publicação no grupo.",
    fields: [
      { key: "storeName", label: "Nome da loja", placeholder: "minha-loja" },
      { key: "promoterId", label: "Promoter Id", placeholder: "Código do promoter" }
    ]
  },
  terabyte: {
    hint: "ID da loja no programa de afiliados da Terabyte. Ele entra no link de cada produto. A Terabyte não entrega uma lista, então salvar o ID não publica oferta sozinho.",
    fields: [{ key: "storeId", label: "ID da loja", placeholder: "ID do afiliado" }]
  },
  awin: {
    hint: "Id do publisher e o token da API, no painel da Awin. A senha da conta não fica salva aqui.",
    fields: [
      { key: "publisherId", label: "Id do publisher", placeholder: "Id User" },
      { key: "token", label: "Token da API", placeholder: "Token", secret: true }
    ]
  },
  rakuten: {
    hint: "Client ID, Client Secret e SID da Rakuten Advertising. O secret fica oculto no campo. O olho mostra o valor.",
    fields: [
      { key: "clientId", label: "Client ID", placeholder: "Client ID", secret: true },
      { key: "clientSecret", label: "Client Secret", placeholder: "Client Secret", secret: true },
      { key: "sid", label: "SID", placeholder: "SID da conta" }
    ]
  },
  samsung: {
    hint: "Anunciante Awin 58389. Usa o publisher e o token da Awin. Se esta loja tiver um token próprio, cole aqui.",
    fields: [
      { key: "advertiserId", label: "Anunciante", placeholder: "58389", locked: true },
      { key: "token", label: "Token da API", placeholder: "Opcional se a Awin já estiver salva", secret: true }
    ]
  },
  casasbahia: {
    hint: "Anunciante Awin 85979. Usa o publisher e o token da Awin. Se esta loja tiver um token próprio, cole aqui.",
    fields: [
      { key: "advertiserId", label: "Anunciante", placeholder: "85979", locked: true },
      { key: "token", label: "Token da API", placeholder: "Opcional se a Awin já estiver salva", secret: true }
    ]
  },
  natura: {
    hint: "Anunciante Awin 17658. Usa o Id do publisher e o token salvos na Awin. A promoção só entra no grupo se a conta estiver inscrita nesse programa.",
    fields: [
      { key: "advertiserId", label: "Anunciante", placeholder: "17658", locked: true },
      { key: "token", label: "Token da API", placeholder: "Opcional se a Awin já estiver salva", secret: true }
    ]
  },
  paguemenos: {
    hint: "Anunciante Awin 64086. Usa o Id do publisher e o token salvos na Awin. A promoção só entra no grupo se a conta estiver inscrita nesse programa.",
    fields: [
      { key: "advertiserId", label: "Anunciante", placeholder: "64086", locked: true },
      { key: "token", label: "Token da API", placeholder: "Opcional se a Awin já estiver salva", secret: true }
    ]
  },
  epoca: {
    hint: "A Época está na Lomadee. Cole a chave de afiliado (x-api-key) do painel. O robô busca o catálogo e publica o link encurtado da sua conta.",
    fields: [{ key: "apiKey", label: "Chave da API Lomadee", placeholder: "x-api-key", secret: true }]
  },
  shein: {
    hint: "Cole o link onelink.shein.com e clique em Salvar. Se a Shein reconhecer a conta, o card passa de Pendente para Conectada e o campo mostra o código. Isso só guarda a identificação. O robô não publica produto da Shein sozinho.",
    fields: [{ key: "ismgOl", label: "Link de afiliado", placeholder: "https://onelink.shein.com/..." }]
  }
};

function SecretInput({ value, placeholder, name, readOnly, onFocus, onChange, onReveal }: {
  value: string;
  placeholder?: string;
  name?: string;
  readOnly?: boolean;
  onFocus?: () => void;
  onChange: (value: string) => void;
  onReveal?: () => void;
}) {
  const [show, setShow] = useState(false);
  return (
    <span className="aff-secretbox">
      <input name={name} type={show ? "text" : "password"} value={value} autoComplete="new-password" placeholder={placeholder} readOnly={readOnly} onFocus={onFocus} onChange={(event) => onChange(event.target.value)} />
      <button type="button" aria-label={show ? "Esconder" : "Mostrar"} onClick={() => { onReveal?.(); setShow((current) => !current); }}>
        <svg viewBox="0 0 24 24"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" />{show ? <path d="M4 4l16 16" /> : null}</svg>
      </button>
    </span>
  );
}

const sheinAffiliateCode = (value: string) => {
  const text = value.trim();
  const match = text.match(/[?&]ismg_ol=([^&#\s]+)/i);
  if (!match) return text;
  try { return decodeURIComponent(match[1]); } catch { return match[1]; }
};

function StoreDialog({ store, setting, onClose, onSaved, onNotice }: { store: any; setting: any; onClose: () => void; onSaved: () => Promise<void>; onNotice: (title: string, text: string, tone?: "ok" | "bad") => void }) {
  const row = store.row;
  const extra = EXTRA_FORMS[store.id];
  const [enabled, setEnabled] = useState(row?.enabled !== false);
  const [config, setConfig] = useState<Record<string, string>>({ ...(row?.config || {}) });
  const [secrets, setSecrets] = useState<Record<string, string>>({ ...(row?.secrets || {}) });
  const [ml, setMl] = useState({
    word: setting?.ml_matt_word || "",
    tool: setting?.ml_matt_tool || "",
    tag: setting?.ml_tag || "",
    official: Boolean(setting?.ml_official),
    cookie: setting?.mlCookie || "",
    paste: ""
  });
  const [mlField, setMlField] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const cookieUntil = setting?.mlCookieExpiresAt || setting?.ml_cookie_expires_at;

  const saveStore = async (body: { enabled: boolean; config: Record<string, string>; secrets: Record<string, string> }) => {
    await api(`/api/stores/${store.id}`, { method: "PUT", body: JSON.stringify(body) });
  };

  const save = async () => {
    setBusy(true);
    setNote("");
    try {
      if (store.id === "ml") {
        await api("/api/settings", { method: "PUT", body: JSON.stringify({ mlMattWord: ml.word.trim(), mlMattTool: ml.tool.replace(/\D/g, ""), mlTag: ml.tag.trim(), mlOfficial: ml.official, ...(ml.cookie.trim() ? { mlCookie: ml.cookie.trim() } : {}) }) });
        await saveStore({ enabled: true, config: {}, secrets: {} });
      } else if (store.id === "amazon") {
        const raw = config.partnerTag || "";
        const match = raw.match(/[?&]tag=([^&#\s]+)/i);
        const tag = match ? decodeURIComponent(match[1]) : raw.trim();
        await saveStore({ enabled, config: { partnerTag: tag, links: config.links || "" }, secrets: { partnerTag: tag, links: config.links || "", accessKey: secrets.accessKey || "", secretKey: secrets.secretKey || "" } });
      } else if (store.id === "shopee") {
        const appId = (config.appId || "").trim();
        await saveStore({ enabled, config: { appId }, secrets: { appId, secret: secrets.secret || "" } });
      } else if (store.id === "aliexpress") {
        await saveStore({ enabled, config: { appKey: config.appKey || "", trackingId: config.trackingId || "" }, secrets: { appKey: config.appKey || "", trackingId: config.trackingId || "", appSecret: secrets.appSecret || "" } });
      } else if (extra) {
        const nextConfig: Record<string, string> = {};
        const nextSecrets: Record<string, string> = {};
        for (const field of extra.fields) {
          const value = field.locked ? field.placeholder : field.secret ? (secrets[field.key] || "") : (config[field.key] || "");
          if (field.secret) nextSecrets[field.key] = value;
          else nextConfig[field.key] = value;
        }
        await saveStore({ enabled, config: nextConfig, secrets: nextSecrets });
      }
      await onSaved();
      onClose();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Não foi possível salvar";
      setNote(message);
      onNotice("Não salvou", message, "bad");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="aff-modal" role="dialog" aria-modal="true">
      <button type="button" className="aff-modal__backdrop" aria-label="Fechar" onClick={onClose} />
      <div className={`aff-modal__card${store.id === "shopee" || store.id === "aliexpress" ? " is-wide" : ""}`}>
        {store.id === "ml" ? (
          <>
            <h2>Mercado Livre</h2>
            <StoreHowTo id="ml" />
            <label>Conta<input name="ml-conta" value={ml.word} autoComplete="off" placeholder="matt_word da sua conta" readOnly={mlField !== "conta"} onFocus={() => setMlField("conta")} onChange={(event) => setMl({ ...ml, word: event.target.value.trim() })} /></label>
            <label>Matt Tool<input name="ml-matt-tool" value={ml.tool} inputMode="numeric" autoComplete="off" placeholder="número do matt_tool" readOnly={mlField !== "tool"} onFocus={() => setMlField("tool")} onChange={(event) => setMl({ ...ml, tool: event.target.value.replace(/\D/g, "") })} /></label>
            <label>Etiqueta<input name="ml-etiqueta" value={ml.tag} autoComplete="off" placeholder={ml.word || "A mesma da Conta"} readOnly={mlField !== "tag"} onFocus={() => setMlField("tag")} onChange={(event) => setMl({ ...ml, tag: event.target.value.trim() })} /></label>
            <p>Pode deixar a Etiqueta vazia: o robô usa a Conta.</p>
            <label className="is-check"><input type="checkbox" checked={ml.official} onChange={(event) => setMl({ ...ml, official: event.target.checked })} /> Gerar link oficial (meli.la)</label>
            <section className="aff-ext"><div><strong>Extensão para copiar o cookie</strong><p>Instale uma vez no Chrome ou no Edge. O passo a passo está na página Automação.</p></div><a className="is-solid aff-ext__btn" href="/achadinhos-cookie.zip" download>Baixar extensão</a></section>
            <label>Cookie do gerador<SecretInput name="ml-cookie-gerador" value={ml.cookie} placeholder="Cookie da requisição createLink" readOnly={mlField !== "cookie"} onFocus={() => setMlField("cookie")} onReveal={() => setMlField("cookie")} onChange={(value) => setMl({ ...ml, cookie: value })} />{cookieUntil ? <small className="aff-cookie-until">Válido até {new Date(cookieUntil).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}. O aviso aparece 2 dias antes.</small> : null}</label>
            <label>Colar um link para preencher<textarea value={ml.paste} autoComplete="off" placeholder="https://...matt_word=...&matt_tool=..." onChange={(event) => {
              const value = event.target.value;
              setMl((current) => ({ ...current, paste: value }));
              try {
                const url = new URL(value.trim());
                const word = url.searchParams.get("matt_word") || "";
                const tool = url.searchParams.get("matt_tool") || "";
                if (word || tool) setMl((current) => ({ ...current, paste: value, word: word || current.word, tool: tool || current.tool }));
              } catch { /* o texto ainda não é um link */ }
            }} /></label>
            <div className="aff-modal__row">
              <button type="button" disabled={busy} onClick={async () => {
                setBusy(true);
                setNote("");
                try {
                  await api("/api/settings", { method: "PUT", body: JSON.stringify({ mlMattWord: ml.word.trim(), mlMattTool: ml.tool.replace(/\D/g, ""), mlTag: ml.tag.trim(), mlOfficial: true, ...(ml.cookie.trim() ? { mlCookie: ml.cookie.trim() } : {}) }) });
                  const result = await api<{ verdict?: string; url?: string }>("/api/stores/ml/test", { method: "POST", body: "{}" });
                  const message = `${result.verdict || "Link gerado"} ${result.url || ""}`.trim();
                  setNote(message);
                  onNotice("Teste", message);
                } catch (err) {
                  const message = err instanceof Error ? err.message : "O teste não concluiu";
                  setNote(message);
                  onNotice("Não testou", message, "bad");
                } finally {
                  setBusy(false);
                }
              }}>Testar link oficial</button>
            </div>
          </>
        ) : null}
        {store.id === "amazon" ? (
          <>
            <h2>Amazon</h2>
            <StoreHowTo id="amazon" />
            {config.partnerTag ? <div className="aff-valid"><strong>Conta reconhecida</strong><span>Tag {config.partnerTag}</span></div> : null}
            <label>Partner Tag<input value={config.partnerTag || ""} autoComplete="off" placeholder="sua-tag-20 ou um link com tag=" onChange={(event) => {
              const raw = event.target.value.trim();
              const match = raw.match(/[?&]tag=([^&#\s]+)/i);
              setConfig({ ...config, partnerTag: match ? decodeURIComponent(match[1]) : raw });
            }} /></label>
            <label>Links dos produtos<textarea value={config.links || ""} placeholder={"https://www.amazon.com.br/dp/B0XXXX | Nome do produto | 199,90"} onChange={(event) => setConfig({ ...config, links: event.target.value })} /></label>
            <label>Access Key<input value={secrets.accessKey || ""} autoComplete="off" placeholder="Opcional. A Amazon pede 10 vendas em 30 dias" onChange={(event) => setSecrets({ ...secrets, accessKey: event.target.value })} /></label>
            <label>Secret<SecretInput value={secrets.secretKey || ""} placeholder="Secret da API" onChange={(value) => setSecrets({ ...secrets, secretKey: value })} /></label>
          </>
        ) : null}
        {store.id === "shopee" ? (
          <>
            <h2>Shopee</h2>
            <StoreHowTo id="shopee" />
            <label>App ID<input value={config.appId || ""} autoComplete="off" placeholder="App ID da API de afiliados" onChange={(event) => setConfig({ ...config, appId: event.target.value })} /></label>
            <label>Secret<SecretInput value={secrets.secret || ""} placeholder="Secret da API" onChange={(value) => setSecrets({ ...secrets, secret: value })} /></label>
            <p>Não use cookie na Shopee: ela recusa e nada é publicado. Só App ID e Secret funcionam.</p>
          </>
        ) : null}
        {store.id === "aliexpress" ? (
          <>
            <h2>AliExpress</h2>
            <StoreHowTo id="aliexpress" />
            <label>App Key<input value={config.appKey || ""} autoComplete="off" onChange={(event) => setConfig({ ...config, appKey: event.target.value })} /></label>
            <label>Secret<SecretInput value={secrets.appSecret || ""} placeholder="App Secret" onChange={(value) => setSecrets({ ...secrets, appSecret: value })} /></label>
            <label>Tracking ID<input value={config.trackingId || ""} autoComplete="off" onChange={(event) => setConfig({ ...config, trackingId: event.target.value })} /></label>
          </>
        ) : null}
        {store.id !== "ml" && !extra ? <label className="is-check"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /> Publicar esta loja</label> : null}
        {extra ? (
          <>
            <h2>{store.label}</h2>
            <StoreHowTo id={store.id} />
            {extra.fields.map((field) => (
              <label key={field.key}>
                {field.label}
                {field.secret ? (
                  <SecretInput
                    value={secrets[field.key] || ""}
                    placeholder={field.placeholder}
                    onChange={(value) => setSecrets({ ...secrets, [field.key]: value })}
                  />
                ) : (
                  <input
                    value={field.locked ? field.placeholder : (config[field.key] || "")}
                    readOnly={Boolean(field.locked)}
                    autoComplete="off"
                    placeholder={field.placeholder}
                    onChange={(event) => {
                      const value = store.id === "shein" && field.key === "ismgOl" ? sheinAffiliateCode(event.target.value) : event.target.value;
                      setConfig({ ...config, [field.key]: value });
                    }}
                  />
                )}
              </label>
            ))}
            {store.id === "shein" && config.ismgOl && !/^https?:/i.test(config.ismgOl) ? <div className="aff-valid"><strong>Código reconhecido</strong><span>{config.ismgOl}</span></div> : null}
            {store.id !== "ml" ? <label className="is-check"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /> Publicar esta loja</label> : null}
          </>
        ) : null}
        {note ? <p className="aff-config-error">{note}</p> : null}
        <div className="aff-modal__actions">
          <button type="button" onClick={onClose}>Cancelar</button>
          <button type="button" className="is-solid" disabled={busy} onClick={save}>Salvar</button>
        </div>
      </div>
    </div>
  );
}

const downloadReport = async (id: number) => {
  const headers = new Headers();
  const token = getToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(`/api/audience/jobs/${id}/export`, { headers });
  if (!response.ok) throw new Error("Não foi possível exportar o relatório.");
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `fila-${id}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
};

const maskPhone = (phone?: string) => {
  const digits = String(phone || "").replace(/\D/g, "");
  if (digits.length < 8) return "número oculto";
  return `+${digits.slice(0, 2)} ${digits.slice(2, 4)} ••••-${digits.slice(-2)}`;
};

const clockLabel = (value?: string) => value ? new Date(value).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" }) : "";

const remainLabel = (seconds: number) => {
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return "menos de 1 min";
  const hours = Math.floor(total / 3600);
  const minutes = Math.round((total % 3600) / 60);
  if (hours && minutes) return `${hours}h ${minutes}min`;
  if (hours) return `${hours}h`;
  return `${minutes} min`;
};

const outcomeOf = (event: { status?: string; reason?: string }) => {
  if (event.status === "added" && event.reason === "convite enviado") return { tone: "invite", label: "Convite" };
  if (event.status === "added") return { tone: "ok", label: "Adicionado" };
  if (event.reason === "já está no grupo") return { tone: "there", label: "Já estava" };
  if (event.status === "failed") return { tone: "bad", label: "Falhou" };
  return { tone: "there", label: event.reason || "Ignorado" };
};

const activityLine = (event: { status?: string; reason?: string; name?: string; phone?: string }) => {
  const who = event.name && event.name !== "Sem nome" ? event.name : maskPhone(event.phone);
  if (event.status === "added" && event.reason !== "convite enviado") return `${who} adicionado ao grupo.`;
  if (event.reason === "convite enviado") return `Convite enviado para ${who}.`;
  if (event.reason === "já está no grupo") return `${who} já estava no grupo.`;
  return `${who}: ${event.reason || "falhou"}.`;
};

function MoveBoard({ job, events, online, onRefresh, onError }: { job: any; events: any[]; online: boolean; onRefresh: () => Promise<void>; onError: (message: string) => void }) {
  const feed = events.filter((event) => Number(event.job_id) === Number(job.id));
  const total = Number(job.total || 0);
  const processed = Number(job.processed || 0);
  const pending = Number(job.pending || 0);
  const added = Number(job.added || 0);
  const already = Number(job.already || 0);
  const invites = Number(job.invites || 0);
  const failed = Number(job.failed || 0);
  const percent = total ? Math.min(100, Math.round((processed / total) * 100)) : 0;
  const batch = Math.max(1, Number(job.batch_size || 1));
  const interval = Math.max(60, Number(job.interval_seconds || 60));
  const since = job.last_tick_at ? (Date.now() - new Date(job.last_tick_at).getTime()) / 1000 : interval;
  const wait = job.status === "running" ? Math.max(0, interval - since) : 0;
  const batches = Math.ceil(pending / batch);
  const eta = batches <= 0 ? 0 : wait + Math.max(0, batches - 1) * interval;
  const pace = `${batch} ${batch > 1 ? "membros" : "membro"} a cada ${interval >= 3600 ? `${Math.round(interval / 3600)} h` : `${Math.round(interval / 60)} min`}`;
  let streak = 0;
  for (const event of feed) {
    if (event.status !== "failed") break;
    streak += 1;
  }
  const limited = /limit|bloque|pausa|429/i.test(String(job.last_error || ""));
  const attempts = added + invites + failed;
  const success = attempts ? Math.round(((added + invites) / attempts) * 100) : null;
  const live = job.status === "running" || job.status === "paused";
  const done = job.status === "done" || job.status === "canceled";
  const act = async (path: string, doneTitle: string) => {
    try {
      await api(path, { method: "POST" });
      await onRefresh();
    } catch (err) {
      onError(err instanceof Error ? err.message : doneTitle);
    }
  };
  const cards = [
    ["Total", total],
    ["Processados", processed],
    ["Adicionados", added],
    ["Já estavam", already],
    ["Convites", invites],
    ["Falhas", failed]
  ];
  return (
    <section className="aff-move">
      <header className="aff-move__status">
        <div>
          <strong className={job.status === "running" ? "is-on" : job.status === "paused" ? "is-wait" : job.status === "canceled" ? "is-bad" : "is-ok"}>{job.status === "running" ? "Fila executando" : job.status === "paused" ? "Fila pausada" : job.status === "canceled" ? "Operação encerrada" : "Operação concluída"}</strong>
          <p>{job.group_name || "Grupo"}{job.source_group_name ? ` · origem ${job.source_group_name}` : ""}</p>
          {feed[0] ? <em>Última ação: {activityLine(feed[0])}</em> : <em>{pending ? "Ainda não houve inclusão nesta leva." : "Nenhum participante processado."}</em>}
          {live ? <em>{job.status === "running" ? `Próximo envio: ${wait < 5 ? "agora" : `em ${remainLabel(wait)}`}.` : "O envio está pausado."} Velocidade: {pace}.</em> : null}
          {job.last_error ? <em className="is-bad">{job.last_error}</em> : null}
        </div>
        <div className="aff-move__actions">
          {job.status === "running" ? <button type="button" onClick={() => act(`/api/audience/jobs/${job.id}/pause`, "Não pausou")}>Pausar</button> : null}
          {job.status === "paused" ? <button type="button" onClick={() => act(`/api/audience/jobs/${job.id}/resume`, "Não retomou")}>Retomar</button> : null}
          {live ? <button type="button" className="is-danger" onClick={() => act(`/api/audience/jobs/${job.id}/stop`, "Não encerrou")}>Encerrar</button> : null}
        </div>
      </header>
      <div className="aff-people__stats">
        {cards.map(([label, value]) => <article key={label}><span>{label}</span><strong>{Number(value).toLocaleString("pt-BR")}</strong></article>)}
      </div>
      <div className="aff-move__progress">
        <div>
          <span>{processed.toLocaleString("pt-BR")} de {total.toLocaleString("pt-BR")} participantes processados</span>
          <div className="aff-move__bar"><i style={{ width: `${percent}%` }} /></div>
        </div>
        <strong>{percent}%</strong>
        <em>{done ? "Tempo restante encerrado" : `Tempo estimado restante ${remainLabel(eta)}`}</em>
      </div>
      <div className="aff-move__split">
        <article>
          <p>Atividade recente</p>
          {feed.length ? <ul>{feed.slice(0, 50).map((event) => {
            const outcome = outcomeOf(event);
            return <li key={event.id}><time>{clockLabel(event.processed_at)}</time><span className={`aff-badge is-${outcome.tone}`}>{outcome.label}</span><em>{activityLine(event)}</em></li>;
          })}</ul> : <em>Os resultados aparecem aqui conforme a fila anda.</em>}
        </article>
        <article>
          <p>Saúde da operação</p>
          <ul className="aff-move__health">
            <li className={Number(job.interval_seconds) >= 60 ? "is-on" : "is-bad"}>{Number(job.interval_seconds) >= 60 ? "Intervalo dentro do teto" : "Intervalo curto demais"}</li>
            <li className={online ? "is-on" : "is-bad"}>{online ? "Conta conectada" : "Conta desconectada"}</li>
            <li className={limited || streak >= 3 ? "is-bad" : "is-on"}>{limited ? "O WhatsApp está limitando inclusões" : streak >= 3 ? "Muitas falhas seguidas. Vale aumentar o intervalo." : "Sem bloqueio detectado nesta leva"}</li>
            <li className={success != null && success < 50 ? "is-bad" : "is-on"}>{success == null ? "Taxa de sucesso aparece após o primeiro envio" : `Taxa de sucesso ${success}%`}</li>
          </ul>
        </article>
      </div>
      {feed.length ? (
        <div className="aff-tablewrap">
          <table className="aff-table">
            <thead><tr><th>Nome</th><th>Número</th><th>Resultado</th><th>Horário</th></tr></thead>
            <tbody>
              {feed.map((event) => {
                const outcome = outcomeOf(event);
                return <tr key={`row-${event.id}`}><td>{event.name || "Sem nome"}</td><td>{maskPhone(event.phone)}</td><td><span className={`aff-badge is-${outcome.tone}`}>{outcome.label}</span></td><td>{clockLabel(event.processed_at)}</td></tr>;
              })}
            </tbody>
          </table>
        </div>
      ) : null}
      {done ? (
        <footer className="aff-move__done">
          <div>
            <strong>{job.status === "canceled" ? "Operação encerrada" : "Operação concluída"}</strong>
            <p>Encontrados {total.toLocaleString("pt-BR")} · Adicionados {added.toLocaleString("pt-BR")} · Já estavam {already.toLocaleString("pt-BR")} · Convites {invites.toLocaleString("pt-BR")} · Falhas {failed.toLocaleString("pt-BR")}{success != null ? ` · Sucesso ${success}%` : ""}</p>
          </div>
          <button type="button" onClick={() => downloadReport(job.id).catch((err) => onError(err instanceof Error ? err.message : "Não foi possível exportar."))}>Exportar relatório</button>
        </footer>
      ) : null}
    </section>
  );
}

export function Panel({ session, onLogout, onRefresh, onReturn }: { session: Session; onLogout: () => void; onRefresh?: () => Promise<unknown>; onReturn?: () => void }) {
  const path = usePath();
  const view: View = path.startsWith("/configuracoes") ? "config" : (Object.entries(PANEL_PATH).find(([, href]) => href === path || path.startsWith(`${href}/`))?.[0] as View) || "dash";
  const setView = (id: View) => go(id === "config" ? "/configuracoes/envio" : PANEL_PATH[id]);
  const configTab = path.split("/")[2] && ["geral", "envio", "filtros", "horarios", "equipe", "logs"].includes(path.split("/")[2]) ? path.split("/")[2] : "envio";
  const setConfigTab = (id: string) => go(`/configuracoes/${id}`);
  const connMatch = path.match(/^\/conexoes\/(\d+)\/(conexao|lojas|grupos|status)$/);
  const botMatch = path.match(/^\/conexoes\/bot\/(\d+)\/(bot|lojas|chats)$/);
  const openConn = connMatch ? Number(connMatch[1]) : null;
  const connTab = connMatch?.[2] || "conexao";
  const openBot = botMatch ? Number(botMatch[1]) : null;
  const botTab = botMatch?.[2] || "bot";
  const setOpenConn = (id: number | null) => go(id ? `/conexoes/${id}/conexao` : "/conexoes");
  const setConnTab = (tab: string) => { if (openConn) go(`/conexoes/${openConn}/${tab}`); };
  const setOpenBot = (id: number | null) => go(id ? `/conexoes/bot/${id}/chats` : "/conexoes");
  const setBotTab = (tab: string) => { if (openBot) go(`/conexoes/bot/${openBot}/${tab}`); };
  useEffect(() => { if (path === "/configuracoes") go("/configuracoes/envio", true); }, [path]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [dash, setDash] = useState<any>(null);
  const [stores, setStores] = useState<any[]>([]);
  const [campaigns, setCampaigns] = useState<any[]>([]);
  const [offers, setOffers] = useState<any[]>([]);
  const [posts, setPosts] = useState<any[]>([]);
  const [connections, setConnections] = useState<any[]>([]);
  const [bots, setBots] = useState<any[]>([]);
  const [groupBook, setGroupBook] = useState<Record<string, { groups: any[]; message: string; loading: boolean; syncedAt?: number }>>({});
  const [groupQuery, setGroupQuery] = useState<Record<string, string>>({});
  const [createOpen, setCreateOpen] = useState(false);
  const [createKind, setCreateKind] = useState<"whatsapp" | "telegram">("whatsapp");
  const [createName, setCreateName] = useState("");
  const [createToken, setCreateToken] = useState("");
  const [chatDraft, setChatDraft] = useState<Record<string, { chatId: string; title: string }>>({});
  const [contacts, setContacts] = useState<any[]>([]);
  const [setting, setSetting] = useState<any>(null);
  const [note, setNote] = useState("");
  const [storeModal, setStoreModal] = useState<any>(null);
  const [offerStore, setOfferStore] = useState("all");
  const [offerSort, setOfferSort] = useState("recent");
  const [offerView, setOfferView] = useState("cards");
  const [envioNote, setEnvioNote] = useState("");
  const [extCode, setExtCode] = useState("");
  const [envioConn, setEnvioConn] = useState<number | "">("");
  const [configNote, setConfigNote] = useState("");
  const [notices, setNotices] = useState<Array<{ id: number; tone: "ok" | "bad"; title: string; text: string }>>([]);
  const [ask, setAsk] = useState<null | { title: string; text: string; confirm: string; run: () => Promise<void> }>(null);
  const [connName, setConnName] = useState("");
  const waSeen = useRef<Record<number, string>>({});
  const skipDisconnectToast = useRef(false);
  const groupsAsked = useRef<Set<number>>(new Set());
  const qrSeen = useRef<Record<number, { qr: string; at: number }>>({});
  const [filterDraft, setFilterDraft] = useState({ discount: "", max: "" });
  const [guide, setGuide] = useState("");
  const [feed, setFeed] = useState<Array<{ id: number; title: string; body: string; detail?: string }>>([]);
  const [team, setTeam] = useState<{ users: any[]; keys: any[] }>({ users: [], keys: [] });
  const [freshKey, setFreshKey] = useState("");
  const [contactQuery, setContactQuery] = useState("");
  const [contactOpen, setContactOpen] = useState(false);
  const [contactTab, setContactTab] = useState<"extrair" | "base" | "fila" | "historico">("extrair");
  const [contactConn, setContactConn] = useState<number | "all">("all");
  const [picked, setPicked] = useState<string[]>([]);
  const [groupFind, setGroupFind] = useState("");
  const [jobs, setJobs] = useState<any[]>([]);
  const [extracting, setExtracting] = useState(false);
  const [queueGroup, setQueueGroup] = useState("");
  const [queueSource, setQueueSource] = useState("");
  const [queueCount, setQueueCount] = useState("1");
  const [queueEvery, setQueueEvery] = useState("5");
  const [queueUnit, setQueueUnit] = useState<"minutes" | "hours">("minutes");
  const [queueBusy, setQueueBusy] = useState(false);
  const [queueEvents, setQueueEvents] = useState<any[]>([]);
  const [queueGrowth, setQueueGrowth] = useState<Record<string, number>>({});
  const [clock, setClock] = useState(() => Date.now());
  const [queueTurn, setQueueTurn] = useState(0);
  const page = NAV.find((item) => item[0] === view) || NAV[0];
  const connected = connections.some((item) => item.status === "connected");
  const enabled = Boolean(setting?.enabled ?? dash?.setting?.enabled);
  const tenant = session.subscription?.tenant_id;

  const reload = async () => {
    const [board, storeData, campData, offerData, postData, connData, contactData, settingData] = await Promise.all([
      api<any>("/api/dashboard"),
      api<{ stores: any[] }>("/api/stores"),
      api<{ campaigns: any[] }>("/api/campaigns"),
      api<{ offers: any[] }>("/api/offers"),
      api<{ posts: any[] }>("/api/posts"),
      api<{ sessions: any[]; bots: any[] }>("/api/connections"),
      api<{ contacts: any[] }>("/api/contacts"),
      api<{ setting: any }>("/api/settings")
    ]);
    setDash(board);
    setStores(storeData.stores);
    setCampaigns(campData.campaigns);
    setOffers(offerData.offers);
    setPosts(postData.posts);
    setConnections(connData.sessions || []);
    const seen: Record<number, string> = {};
    for (const item of connData.sessions || []) seen[item.id] = String(item.status || "");
    waSeen.current = seen;
    skipDisconnectToast.current = false;
    setBots(connData.bots || []);
    setContacts(contactData.contacts || []);
    setSetting(settingData.setting);
  };

  useEffect(() => { reload().catch((err) => tell("Não carregou", err.message, "bad")); }, []);

  useEffect(() => {
    api<{ notices: Array<{ id: number; title: string; body: string; detail?: string }> }>("/api/notices")
      .then((data) => setFeed(data.notices || []))
      .catch(() => undefined);
  }, [view]);

  useEffect(() => {
    if (view !== "config" || configTab !== "equipe") return;
    api<{ users: any[]; keys: any[] }>("/api/team").then(setTeam).catch((err) => tell("Não carregou", err.message, "bad"));
  }, [view, configTab]);

  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setQueueTurn((value) => value + 1), 4000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (view !== "dash" && view !== "config" && view !== "stores") return;
    const timer = window.setInterval(() => {
      api<{ posts: any[] }>("/api/posts").then((data) => setPosts(data.posts || [])).catch(() => undefined);
    }, 8000);
    return () => window.clearInterval(timer);
  }, [view]);

  useEffect(() => {
    setFilterDraft({
      discount: setting?.min_discount == null || setting.min_discount === "" ? "" : String(setting.min_discount),
      max: setting?.max_price_cents ? (Number(setting.max_price_cents) / 100).toFixed(2).replace(".", ",") : ""
    });
  }, [setting?.min_discount, setting?.max_price_cents]);

  useEffect(() => {
    if (view !== "groups") return;
    const timer = setInterval(() => {
      api<{ sessions: any[]; bots: any[] }>("/api/connections")
        .then((data) => {
          const next = data.sessions || [];
          for (const item of next) {
            const before = waSeen.current[item.id];
            const status = String(item.status || "");
            if (before && before !== status) {
              if (status === "connected") tell("WhatsApp conectado com sucesso.", `${item.name} está online.`);
              else if (before === "connected") {
                if (skipDisconnectToast.current) skipDisconnectToast.current = false;
                else tell("WhatsApp desconectado.", `${item.name} saiu.`, "bad");
              }
            }
          }
          const seen: Record<number, string> = {};
          for (const item of next) seen[item.id] = String(item.status || "");
          waSeen.current = seen;
          setConnections(next);
          setBots(data.bots || []);
        })
        .catch(() => undefined);
    }, 2000);
    return () => clearInterval(timer);
  }, [view]);

  useEffect(() => {
    if (view !== "contacts") return;
    let stop = false;
    const pull = () => api<{ jobs: any[]; events?: any[]; growth?: Array<{ group_jid: string; added: number }> }>("/api/audience/jobs")
      .then((data) => {
        if (stop) return;
        setJobs(data.jobs || []);
        setQueueEvents(data.events || []);
        const growth: Record<string, number> = {};
        for (const row of data.growth || []) growth[row.group_jid] = Number(row.added || 0);
        setQueueGrowth(growth);
      })
      .catch(() => undefined);
    pull();
    const timer = contactTab === "fila" ? window.setInterval(pull, 8000) : 0;
    return () => {
      stop = true;
      if (timer) window.clearInterval(timer);
    };
  }, [view, contactTab]);

  useEffect(() => {
    if (view !== "contacts" || !connections.length) return;
    if (contactConn !== "all" && !connections.some((item) => item.id === contactConn)) setContactConn("all");
    let cancel = false;
    void (async () => {
      for (const item of connections) {
        if (cancel || groupsAsked.current.has(item.id)) continue;
        groupsAsked.current.add(item.id);
        try {
          await loadGroups(item.id);
        } catch (err) {
          groupsAsked.current.delete(item.id);
          if (!cancel) tell("Não listou", err instanceof Error ? err.message : "Não foi possível listar os grupos", "bad");
        }
      }
    })();
    return () => { cancel = true; };
  }, [view, connections, contactConn]);

  const saveConnStores = async (id: number, stores: string[]) => {
    await api(`/api/connections/${id}`, { method: "PATCH", body: JSON.stringify({ stores }) });
    setConnections((rows) => rows.map((item) => item.id === id ? { ...item, stores } : item));
  };

  const patchBot = async (id: number, patch: Record<string, unknown>) => {
    await api(`/api/telegram/${id}`, { method: "PATCH", body: JSON.stringify(patch) });
    await reload();
  };

  const startConnection = async (id: number) => {
    setNote("");
    try {
      await api(`/api/connections/${id}/start`, { method: "POST" });
      waSeen.current = { ...waSeen.current, [id]: "opening" };
      setConnections((rows) => rows.map((item) => item.id === id ? { ...item, status: "opening", qr: "", last_error: null } : item));
    } catch (err) {
      tell("Não gerou", err instanceof Error ? err.message : "Não foi possível gerar o QR", "bad");
    }
  };

  const qrLeft = (item: { id: number; qr?: string; qr_at?: string }) => {
    if (!item.qr) return null;
    const server = item.qr_at ? new Date(item.qr_at).getTime() : 0;
    let born = server && !Number.isNaN(server) ? server : 0;
    if (!born) {
      const known = qrSeen.current[item.id];
      if (!known || known.qr !== item.qr) qrSeen.current[item.id] = { qr: item.qr, at: Date.now() };
      born = qrSeen.current[item.id].at;
    }
    return Math.max(0, 60 - Math.floor((clock - born) / 1000));
  };

  const pulse = (id: string, connId?: number) => {
    const rows = posts.filter((post) => post.marketplace === id && (!connId || Number(post.whatsapp_id) === connId));
    const sent = rows.filter((post) => post.status === "sent");
    return {
      analyzed: offers.filter((item) => item.marketplace === id).length || rows.length,
      published: sent.length,
      clicks: sent.reduce((sum, post) => sum + Number(post.click_count || 0), 0),
      last: sent[0]?.created_at || null
    };
  };

  const visibleOffers = useMemo(() => {
    const source = offers.length ? offers : posts.filter((post) => post.status === "sent");
    const rows = source.filter((item) => {
      if (offerStore !== "all" && item.marketplace !== offerStore) return false;
      return !query.trim() || String(item.title || "").toLowerCase().includes(query.trim().toLowerCase());
    });
    if (offerSort === "discount") rows.sort((a, b) => Number(b.discount_percent || 0) - Number(a.discount_percent || 0));
    else if (offerSort === "score") rows.sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
    else if (offerSort === "clicks") rows.sort((a, b) => Number(b.click_count || 0) - Number(a.click_count || 0));
    return rows;
  }, [offers, posts, offerStore, offerSort, query]);

  const tell = (title: string, text: string, tone: "ok" | "bad" = "ok") => {
    const id = Date.now() + Math.random();
    setNotices((list) => [...list, { id, tone, title, text }]);
    window.setTimeout(() => setNotices((list) => list.filter((item) => item.id !== id)), tone === "ok" ? 4200 : 8000);
  };

  const noted = async (title: string, text: string, job: () => Promise<unknown>) => {
    try {
      await job();
      tell(title, text);
    } catch (err) {
      tell("Não concluiu", err instanceof Error ? err.message : "A ação não concluiu", "bad");
    }
  };

  const saveSetting = async (patch: Record<string, unknown>, done?: string) => {
    try {
      await api("/api/settings", { method: "PUT", body: JSON.stringify(patch) });
      await reload();
      if (done) tell("Salvo", done);
    } catch (err) {
      tell("Não salvou", err instanceof Error ? err.message : "Não foi possível salvar", "bad");
    }
  };

  const loadGroups = async (id: number) => {
    setGroupBook((book) => ({ ...book, [id]: { groups: book[id]?.groups || [], message: book[id]?.message || "", loading: true, syncedAt: book[id]?.syncedAt } }));
    const data = await api<{ groups: any[]; message?: string }>(`/api/connections/${id}/groups`);
    setGroupBook((book) => ({
      ...book,
      [id]: { groups: data.groups || [], message: data.message || "", loading: false, syncedAt: Date.now() }
    }));
  };

  const envioSession = connections.find((item) => item.id === envioConn) || connections.find((item) => item.selected) || connections[0];

  const cadenceOf = (id: string, connId?: number) => {
    const conn = connId ? connections.find((item) => item.id === connId) : connections.find((item) => item.selected) || connections[0];
    const bag = conn?.send_cadence && Object.keys(conn.send_cadence).length ? conn.send_cadence : setting?.send_cadence;
    const saved = Number(bag?.[id]);
    const total = Number.isFinite(saved) && saved > 0 ? saved : 120;
    return { minutes: Math.floor(total / 60), seconds: total % 60, total };
  };

  const waitLabel = (id: string, connId?: number) => {
    const wait = Math.max(15, cadenceOf(id, connId).total);
    const last = pulse(id, connId).last;
    if (!enabled) return "robô pausado";
    if (!last) return "na próxima busca";
    const left = Math.max(0, Math.ceil(wait - (clock - new Date(last).getTime()) / 1000));
    return left ? `em ${speakWait(left)}` : "agora";
  };

  const setCadencePart = (id: string, part: "minutes" | "seconds", raw: string) => {
    if (!envioSession) return;
    const current = cadenceOf(id, envioSession.id);
    const minutes = part === "minutes" ? Math.min(1440, Math.max(0, Number(raw) || 0)) : current.minutes;
    const seconds = part === "seconds" ? Math.min(59, Math.max(0, Number(raw) || 0)) : current.seconds;
    const base = envioSession.send_cadence && Object.keys(envioSession.send_cadence).length ? envioSession.send_cadence : (setting?.send_cadence || {});
    setEnvioNote("");
    setConnections((rows) => rows.map((item) => item.id === envioSession.id ? { ...item, send_cadence: { ...base, [id]: minutes * 60 + seconds } } : item));
  };

  const saveEnvio = async () => {
    if (!envioSession) return;
    const allowed = Array.isArray(envioSession.stores) && envioSession.stores.length ? envioSession.stores : null;
    const shown = STORES.filter((store) => stores.find((item) => item.marketplace === store.id)?.enabled).filter((store) => !allowed || allowed.includes(store.id));
    const cadence = { ...(envioSession.send_cadence && Object.keys(envioSession.send_cadence).length ? envioSession.send_cadence : setting?.send_cadence || {}) };
    const problems: string[] = [];
    for (const store of shown) {
      const total = Number(cadence[store.id] ?? cadenceOf(store.id, envioSession.id).total);
      cadence[store.id] = total;
      if (total < 15) problems.push(`${store.label}: o intervalo mínimo é 15 segundos.`);
    }
    const pauseRaw = envioSession.interval_seconds ?? setting?.interval_seconds;
    const pause = pauseRaw === "" ? NaN : Number(pauseRaw ?? 20);
    if (!Number.isFinite(pause) || pause < 5) problems.push("A espera entre publicações precisa ter pelo menos 5 segundos.");
    const postsRaw = envioSession.posts_per_cycle ?? setting?.posts_per_cycle;
    const posts = postsRaw === "" ? NaN : Number(postsRaw ?? 1);
    if (!Number.isFinite(posts) || posts < 1) problems.push("Ofertas por vez precisa ser pelo menos 1.");
    if (problems.length) {
      setEnvioNote(problems.join(" "));
      return;
    }
    try {
      await api(`/api/connections/${envioSession.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          sendCadence: cadence,
          intervalSeconds: Math.min(180, Math.max(5, pause)),
          postsPerCycle: Math.min(5, Math.max(1, Math.round(posts)))
        })
      });
      await reload();
      setEnvioNote("");
      tell("Salvo", `Os intervalos de ${envioSession.name} foram gravados.`);
    } catch (err) {
      setEnvioNote(err instanceof Error ? err.message : "Não foi possível gravar os intervalos.");
    }
  };

  const pauseSeconds = Math.min(180, Math.max(5, Number(setting?.interval_seconds) || 20));
  const selectedConn = connections.find((item) => item.selected) || connections[0];
  const allowedStores = Array.isArray(selectedConn?.stores) && selectedConn.stores.length ? selectedConn.stores : null;
  const sendQueue = (() => {
    const due: Array<{ store: (typeof STORES)[number]; wait: number; remaining: number; waitingPause: boolean }> = [];
    const waiting: Array<{ store: (typeof STORES)[number]; wait: number; remaining: number; waitingPause: boolean }> = [];
    STORES.filter((store) => stores.find((item) => item.marketplace === store.id)?.enabled)
      .filter((store) => !allowedStores || allowedStores.includes(store.id))
      .forEach((store) => {
        const wait = Math.min(86400, Math.max(15, cadenceOf(store.id).total));
        const last = pulse(store.id).last as string | null;
        const lastMs = last ? new Date(last).getTime() : 0;
        const remaining = lastMs ? Math.max(0, Math.ceil((lastMs + wait * 1000 - clock) / 1000)) : 0;
        const row = { store, wait, remaining, waitingPause: false };
        if (remaining > 0) waiting.push(row);
        else due.push(row);
      });
    due.forEach((row, index) => {
      row.remaining = index * pauseSeconds;
      row.waitingPause = index > 0;
    });
    return [...due, ...waiting].sort((a, b) => a.remaining - b.remaining || a.store.label.localeCompare(b.store.label, "pt"));
  })();
  const nextOffer = sendQueue[0] || null;
  const tickerRow = sendQueue.length ? sendQueue[queueTurn % sendQueue.length] : null;
  const canPublish = connected || bots.some((bot) => bot.enabled);
  const robotStatus = !sendQueue.length
    ? { tone: "empty", label: "Sem lojas conectadas" }
    : !enabled
      ? { tone: "off", label: "Pausado" }
      : !canPublish
        ? { tone: "off", label: "WhatsApp offline" }
        : { tone: "on", label: "Ativo" };
  const nextLabel = !enabled ? "pausada" : !nextOffer ? "sem loja" : nextOffer.remaining <= 0 ? "agora" : `em ${speakWait(nextOffer.remaining)}`;
  const sentTimes = posts.filter((post) => post.status === "sent").map((post) => new Date(post.created_at).getTime()).filter((value) => value).sort((a, b) => a - b);
  const gaps = sentTimes.slice(1).map((value, index) => value - sentTimes[index]);
  const avgGap = gaps.length ? Math.round(gaps.reduce((sum, value) => sum + value, 0) / gaps.length / 1000) : null;

  return (
    <div className={`aff-app${menuOpen ? " is-nav" : ""}`}>
      <button type="button" className="aff-nav-backdrop" aria-label="Fechar menu" onClick={() => setMenuOpen(false)} />
      <aside className="aff-side">
        <div className="aff-brand">
          <Mark />
          <div className="aff-brand__name">
            <b>Achadinhos</b>
            <span>Automação de afiliados</span>
          </div>
          <button type="button" className="aff-fold" aria-label="Recolher menu" onClick={() => setMenuOpen(false)}><Icon name="menu" /></button>
        </div>
        <nav>
          {NAV.map(([id, label]) => (
            <button key={id} type="button" className={view === id ? "is-on" : ""} onClick={() => { setView(id); setMenuOpen(false); }}>
              <Icon name={id === "groups" ? "groups" : id === "config" ? "config" : id} />
              <span>{label}</span>
            </button>
          ))}
        </nav>
        <div className="aff-side__foot">
          <span className={connected ? "is-on" : ""}>{connected ? "WhatsApp conectado" : "WhatsApp offline"}</span>
          <button type="button" className="aff-back" onClick={onLogout}><Icon name="links" /><span>Sair da conta</span></button>
        </div>
      </aside>
      <div className="aff-main">
        <header className="aff-top">
          <button type="button" className="aff-menu" aria-label="Abrir menu" onClick={() => setMenuOpen(true)}><Icon name="menu" /></button>
          <div className="aff-top__title">
            <strong>{page[1]}</strong>
            <span>Achadinhos / {page[1]}</span>
          </div>
          <input className="aff-finder" value={query} onChange={(event) => setQuery(event.target.value)} onFocus={() => setView("offers")} placeholder="Buscar oferta" />
          <label className="aff-top__conn">
            <span>Conexão</span>
              <select value={connections.find((item) => item.selected)?.id || connections[0]?.id || ""} onChange={(event) => {
              if (!event.target.value) return;
              void noted("Padrão", "A conexão do topo foi atualizada.", async () => {
                await api(`/api/connections/${event.target.value}/select`, { method: "POST" });
                await reload();
              });
            }}>
              <option value="">Escolher</option>
              {connections.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
          <div className={`aff-status${enabled && connected ? " is-on" : ""}`}>
            <i />
            <div>
              <strong>{enabled ? "Robô ativo" : "Robô pausado"}</strong>
              <span>Última {ago(setting?.last_run_at)} · Próxima {nextLabel}</span>
            </div>
          </div>
          <div className="aff-top__actions">
            {onReturn ? <button type="button" onClick={onReturn}>Voltar ao super admin</button> : null}
            <button type="button" disabled={!enabled} onClick={async () => { try { const result = await api<{ sent: number; queued?: boolean }>("/api/deals/run", { method: "POST" }); tell("Busca", result.queued ? "Rodada pedida ao robô. As publicações aparecem em instantes." : `${result.sent} envio(s).`); await reload(); } catch (err) { tell("Não buscou", err instanceof Error ? err.message : "A busca não concluiu", "bad"); } }}>Buscar agora</button>
            <button type="button" className={enabled ? "" : "is-solid"} onClick={() => saveSetting({ enabled: !enabled }, enabled ? "O robô foi pausado." : "O robô foi ativado.")}>{enabled ? "Pausar" : "Ativar"}</button>
            <button type="button" aria-label="Configurações" onClick={() => setView("config")}><Icon name="config" /></button>
          </div>
        </header>
        <div className="aff-body">
          {(() => {
            // Aviso de pagamento: vence em até 3 dias, já venceu ou está suspensa. Leva para "Minha assinatura".
            const sub = session.subscription;
            if (!sub || view === "billing" || session.user.role === "member") return null;
            const ends = sub.status === "trialing" ? sub.trial_ends_at : sub.current_period_end;
            const left = ends ? Math.ceil((new Date(ends).getTime() - Date.now()) / 86400000) : null;
            const suspended = sub.company_status === "suspended";
            if (!suspended && (left == null || left > 3)) return null;
            const text = suspended ? "Sua conta está suspensa e o robô parou." : left! <= 0 ? (sub.status === "trialing" ? "Seu teste grátis terminou." : "Sua assinatura venceu.") : `${sub.status === "trialing" ? "Seu teste grátis" : "Sua assinatura"} vence em ${left} dia${left === 1 ? "" : "s"}.`;
            return <div className="aff-banner"><strong>{text}</strong> Pague com Pix e a liberação é na hora.<button type="button" onClick={() => setView("billing")}>Pagar agora</button></div>;
          })()}
          {session.user.role === "member" ? <div className="aff-banner">Sua conta é só de leitura. Quem altera a operação é o dono ou um gerente.</div> : null}
          {feed.map((item) => (
            <div key={item.id} className="aff-banner">
              <strong>{item.title}.</strong> {item.body}
              {item.detail ? <span>{item.detail}</span> : null}
              <button type="button" onClick={() => api(`/api/notices/${item.id}/read`, { method: "POST" }).then(() => setFeed((rows) => rows.filter((row) => row.id !== item.id))).catch(() => undefined)}>Entendi</button>
            </div>
          ))}
          {note ? <div className="aff-banner">{note}</div> : null}
          {setting?.last_error ? <div className="aff-banner">{setting.last_error}</div> : null}

          {view === "dash" && (
            <>
              <section className="aff-statuscard">
                <div>
                  <em className={enabled ? "is-on" : ""}>{enabled ? "Robô ativo" : "Robô pausado"}</em>
                  <h2>Operação de hoje</h2>
                  <p>Analisando {offers.length} · Aprovados {dash?.today?.posts || 0} · Descartados 0</p>
                  {tenant ? <a href={`/vitrine/${tenant}`} target="_blank" rel="noreferrer">Abrir site de ofertas</a> : null}
                </div>
                <ul>
                  <li><span>Última execução</span><b>{ago(setting?.last_run_at)}</b></li>
                  <li><span>Próxima execução</span><b>{nextLabel}</b></li>
                  <li><span>Tempo médio</span><b>{avgGap != null ? speakWait(avgGap) : "—"}</b></li>
                  <li><span>Taxa de aprovação</span><b>{offers.length ? "100%" : "—"}</b></li>
                </ul>
              </section>
              <section className="aff-queue" aria-live="polite">
                <article className="aff-queue__hero">
                  <header><span>Próxima oferta</span><em className={`is-${robotStatus.tone}`}>{robotStatus.label}</em></header>
                  {nextOffer ? (
                    <>
                      <div className="aff-queue__store">
                        <img src={`/deals-logos/${nextOffer.store.logo}`} alt="" />
                        <strong>{nextOffer.store.label}</strong>
                      </div>
                      <b className="aff-queue__time">{nextOffer.remaining <= 0 ? "Agora" : formatClock(nextOffer.remaining)}</b>
                      <p>
                        {robotStatus.tone !== "on"
                          ? robotStatus.label
                          : nextOffer.remaining <= 0
                            ? "Publicando agora"
                            : nextOffer.waitingPause
                              ? "Aguardando a pausa entre publicações"
                              : "Publicação em"}
                      </p>
                      <small>Intervalo {speakWait(nextOffer.wait)}</small>
                    </>
                  ) : <p>Nenhuma loja conectada para publicar.</p>}
                  {tickerRow ? (
                    <p className="aff-queue__ticker">
                      {tickerRow.waitingPause
                        ? `${tickerRow.store.label} aguarda a pausa · ${speakWait(tickerRow.remaining)}`
                        : `${tickerRow.store.label} envia ${tickerRow.remaining <= 0 ? "agora" : `em ${speakWait(tickerRow.remaining)}`}`}
                    </p>
                  ) : null}
                </article>
                <article className="aff-queue__side">
                  <header><strong>Fila atual</strong><span>Hoje {dash?.today?.posts || 0} publicações · {dash?.today?.clicks || 0} cliques</span></header>
                  <ol>
                    {sendQueue.map((row, index) => (
                      <li key={row.store.id} className={index === 0 ? "is-next" : ""}><span>{index + 1}</span><b>{row.store.label}</b><em>{row.remaining <= 0 ? "agora" : formatClock(row.remaining)}</em></li>
                    ))}
                  </ol>
                  {!sendQueue.length ? <p>Conecte uma loja para montar a fila.</p> : null}
                </article>
              </section>
              <section className="aff-metrics">
                {[
                  ["Encontradas hoje", offers.length, "produtos analisados"],
                  ["Aprovadas hoje", dash?.today?.posts || 0, "nesta conta"],
                  ["Publicadas", posts.filter((post) => post.status === "sent").length, "nesta tela"],
                  ["Cliques", posts.reduce((sum, post) => sum + Number(post.click_count || 0), 0), "no período"]
                ].map(([label, value, hint]) => (
                  <article key={String(label)}><span>{label}</span><strong>{value}</strong><small>{hint}</small></article>
                ))}
              </section>
              <section className="aff-highlights">
                <article><span>Melhor loja</span><strong>{STORES.find((item) => item.id === dash?.bestStore?.marketplace)?.label || "—"}</strong><small>{dash?.bestStore?.total || 0} publicações</small></article>
                <article><span>Melhor campanha</span><strong>{dash?.bestCampaign?.query || "—"}</strong><small>{dash?.bestCampaign?.marketplace || ""}</small></article>
                <article><span>Melhor grupo</span><strong>{dash?.bestGroup?.group_name || "—"}</strong><small>{dash?.bestGroup?.total || 0} cliques</small></article>
              </section>
            </>
          )}

          {view === "stores" && (
            <section className="aff-block">
              <header><div><h2>Lojas</h2><p>Clique em Configurar na loja que você quer usar. A janela mostra o passo a passo e o link do painel de afiliado da loja. A comissão continua no painel de cada loja.</p></div></header>
              <section className="aff-ext">
                <div><strong>Mercado Livre: extensão para copiar o cookie</strong><p>Só o Mercado Livre usa cookie. As outras lojas usam as chaves do painel de afiliado de cada uma: clique em Configurar para ver o passo a passo.</p></div>
                <button type="button" className="is-solid" onClick={() => setView("auto")}>Abrir o guia</button>
              </section>
              <input className="aff-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Pesquisar loja" />
              <div className="aff-shops">
                {STORES.filter((store) => store.label.toLowerCase().includes(query.toLowerCase())).map((store) => {
                  const row = stores.find((item) => item.marketplace === store.id);
                  const stats = pulse(store.id);
                  const ready = store.id === "ml"
                    ? Boolean(setting?.ml_matt_word || setting?.ml_tag)
                    : Boolean(row?.enabled && (row?.hasSecrets || Object.keys(row?.config || {}).some((key) => row.config[key])));
                  return (
                    <article key={store.id} className="aff-shop">
                      <div className="aff-shop__mark"><img src={`/deals-logos/${store.logo}`} alt="" /></div>
                      <header><strong>{store.label}</strong><em className={ready ? "is-on" : ""}>{ready ? "Conectada" : "Pendente"}</em></header>
                      <ul>
                        <li><span>Analisados</span><b>{stats.analyzed}</b></li>
                        <li><span>Publicados</span><b>{stats.published}</b></li>
                        <li><span>Cliques</span><b>{stats.clicks}</b></li>
                        <li><span>Último envio</span><b>{stats.last ? ago(stats.last) : "—"}</b></li>
                      </ul>
                      <p>Última sincronização {stats.last ? ago(stats.last) : "ainda não"}</p>
                      <button type="button" className="is-solid" onClick={() => setStoreModal({ ...store, row })}>Configurar</button>
                    </article>
                  );
                })}
              </div>
            </section>
          )}

          {view === "campaigns" && (
            <section className="aff-block">
              <header><h2>Campanhas</h2></header>
              <form className="aff-form" onSubmit={async (event) => {
                event.preventDefault();
                const form = new FormData(event.currentTarget);
                try {
                  await api("/api/campaigns", { method: "POST", body: JSON.stringify({ marketplace: form.get("store"), query: form.get("query"), minDiscount: Number(form.get("discount") || 0) || null, maxPriceCents: moneyToCents(form.get("max")) }) });
                  event.currentTarget.reset();
                  await reload();
                  tell("Criada", "A campanha entrou na lista.");
                } catch (err) {
                  tell("Não criou", err instanceof Error ? err.message : "Não foi possível criar a campanha", "bad");
                }
              }}>
                <label>Palavra-chave<input name="query" placeholder="fone bluetooth" required /></label>
                <label>Loja<select name="store">{STORES.map((store) => <option key={store.id} value={store.id}>{store.label}</option>)}</select></label>
                <label>Desconto mínimo (%)<input name="discount" /></label>
                <label>Preço máximo (R$)<input name="max" /></label>
                <button className="is-solid" type="submit">Criar campanha</button>
              </form>
              <div className="aff-suggest">
                {["SSD NVMe", "RTX 4060", "iPhone", "Air Fryer", "Monitor gamer"].map((item) => (
                  <button key={item} type="button" onClick={() => noted("Criada", `Campanha “${item}” criada.`, async () => { await api("/api/campaigns", { method: "POST", body: JSON.stringify({ marketplace: "ml", query: item }) }); await reload(); })}>{item}</button>
                ))}
              </div>
              <p className="aff-note">{setting?.random_catalog !== false ? "O robô está no modo aleatório: ignora estas palavras e pega produtos de várias categorias do catálogo." : "Estas palavras entram porque o modo aleatório está desligado."}</p>
              <div className="aff-kanban">
                {[["Ativas", campaigns.filter((item) => item.enabled)], ["Pausadas", []], ["Arquivadas", []]].map(([title, rows]) => (
                  <div key={String(title)}>
                    <header><span>{String(title)}</span><b>{(rows as any[]).length}</b></header>
                    {(rows as any[]).length ? (rows as any[]).map((row) => (
                      <article key={row.id}>
                        <strong>{row.query}</strong>
                        <span>{STORES.find((store) => store.id === row.marketplace)?.label}</span>
                        <ul><li>Desconto {row.min_discount || "—"}%</li><li>Teto {row.max_price_cents ? money(row.max_price_cents) : "—"}</li></ul>
                        <button type="button" onClick={() => setAsk({ title: "Remover campanha", text: `Remover “${row.query}”?`, confirm: "Remover", run: async () => { await api(`/api/campaigns/${row.id}`, { method: "DELETE" }); await reload(); tell("Removida", "A campanha saiu da lista."); } })}>Remover</button>
                      </article>
                    )) : <p className="aff-empty">Nenhuma campanha aqui.</p>}
                  </div>
                ))}
              </div>
            </section>
          )}

          {view === "offers" && (
            <section className="aff-block">
              <header>
                <h2>Ofertas</h2>
                <div className="aff-filters">
                  <button type="button" className={offerStore === "all" ? "is-on" : ""} onClick={() => setOfferStore("all")}>Todas</button>
                  {STORES.map((store) => <button key={store.id} type="button" className={offerStore === store.id ? "is-on" : ""} onClick={() => setOfferStore(store.id)}>{store.label}</button>)}
                </div>
              </header>
              <div className="aff-toolbar">
                <div className="aff-filters">
                  {[["recent", "Recentes"], ["discount", "Maior desconto"], ["score", "Maior score"], ["clicks", "Mais cliques"]].map(([id, label]) => (
                    <button key={id} type="button" className={offerSort === id ? "is-on" : ""} onClick={() => setOfferSort(id)}>{label}</button>
                  ))}
                </div>
                <div className="aff-views">
                  {["cards", "compact", "list", "table"].map((id) => <button key={id} type="button" className={offerView === id ? "is-on" : ""} onClick={() => setOfferView(id)}>{id === "cards" ? "Cards" : id === "compact" ? "Compacto" : id === "list" ? "Lista" : "Tabela"}</button>)}
                </div>
              </div>
              {offerView === "table" ? (
                <div className="aff-tablewrap"><table className="aff-table"><thead><tr><th>Título</th><th>Loja</th><th>Preço</th><th>Desconto</th><th>Score</th></tr></thead><tbody>
                  {visibleOffers.map((item) => <tr key={item.id}><td>{item.title}</td><td>{item.marketplace}</td><td>{money(item.price_cents)}</td><td>{item.discount_percent || "—"}</td><td>{item.score || "—"}</td></tr>)}
                </tbody></table></div>
              ) : (
                <div className={`aff-grid is-${offerView === "cards" ? "cards" : offerView}`}>
                  {visibleOffers.map((item) => (
                    <article key={item.id} className="aff-product">
                      <div className="aff-product__visual">
                        {item.discount_percent ? <em>{item.discount_percent}%</em> : null}
                        {item.image_url ? <img src={item.image_url} alt="" /> : <img src={`/deals-logos/${STORES.find((store) => store.id === item.marketplace)?.logo || "ml.svg"}`} alt="" />}
                      </div>
                      <div className="aff-product__body">
                        <strong>{item.title}</strong>
                        <p className="aff-price">{item.original_price_cents ? <s>{money(item.original_price_cents)}</s> : null}<b>{money(item.price_cents)}</b></p>
                        <div className="aff-score"><span>Score {item.score || 0}</span><i><b style={{ width: `${Math.min(100, Number(item.score || 0))}%` }} /></i></div>
                        <div className="aff-badges"><em>Oferta quente</em></div>
                        <footer><span>{STORES.find((store) => store.id === item.marketplace)?.label}</span><a href={item.url} target="_blank" rel="noreferrer">Link</a></footer>
                      </div>
                    </article>
                  ))}
                </div>
              )}
              {!visibleOffers.length && <div className="aff-empty"><strong>Nenhuma oferta desta vitrine ainda</strong><p>Quando o robô publicar, o card entra aqui com preço, desconto e score.</p></div>}
            </section>
          )}

          {view === "groups" && (
            <section className="aff-connboard">
              <div className="aff-connboard__head">
                <div><h2>Conexões ({connections.length + bots.length})</h2><p>Cada card é um WhatsApp ou um bot. A configuração fica nas abas.</p></div>
                <button type="button" className="is-solid" onClick={() => { setCreateKind("whatsapp"); setCreateName(""); setCreateToken(""); setCreateOpen(true); }}>Nova conexão</button>
              </div>
              <div className="aff-connstats">
                <article><span>Total</span><strong>{connections.length}</strong></article>
                <article><span>Conectadas</span><strong>{connections.filter((item) => item.status === "connected").length}</strong></article>
                <article><span>Aguardando QR</span><strong>{connections.filter((item) => item.status === "qrcode" || item.status === "opening").length}</strong></article>
                <article><span>Desconectadas</span><strong>{connections.filter((item) => item.status !== "connected" && item.status !== "qrcode" && item.status !== "opening").length}</strong></article>
              </div>
              <div className="aff-conngrid">
                {connections.map((item) => {
                  const phase = waPhase(item);
                  const online = phase === "on";
                  return (
                    <article key={item.id} className="aff-wacard">
                      <header>
                        <div className="aff-wacard__who">
                          <img src="/brands/whatsapp.svg" alt="" />
                          <div>
                            <strong>{item.name}</strong>
                            <span>{phoneOf(item.phone)}</span>
                          </div>
                        </div>
                        <em className={`aff-wacard__status is-${phase}`}><i />{waLabel(item, "card")}</em>
                      </header>
                      <p className="aff-wacard__meta">Atualizado {stamp(item.connected_at || item.created_at)}{item.selected ? " · Padrão" : ""}</p>
                      <div className="aff-wacard__actions">
                        <button type="button" onClick={() => { setConnName(item.name || ""); go(`/conexoes/${item.id}/conexao`); }}>Abrir</button>
                        {online ? (
                          <button type="button" onClick={() => { skipDisconnectToast.current = true; noted("WhatsApp desconectado.", "O WhatsApp foi desligado.", async () => { await api(`/api/connections/${item.id}/stop`, { method: "POST" }); await reload(); }); }}>Desconectar</button>
                        ) : phase === "qr" ? (
                          <button type="button" disabled={item.status === "opening"} onClick={() => { setConnName(item.name || ""); go(`/conexoes/${item.id}/conexao`); startConnection(item.id); }}>Gerar novo QR</button>
                        ) : (
                          <button type="button" className="is-solid" onClick={() => { setConnName(item.name || ""); go(`/conexoes/${item.id}/conexao`); startConnection(item.id); }}>{phase === "bad" ? "Tentar novamente" : "Conectar"}</button>
                        )}
                        <button type="button" onClick={() => { setConnName(item.name || ""); go(`/conexoes/${item.id}/grupos`); loadGroups(item.id).catch((err) => tell("Não listou", err instanceof Error ? err.message : "Não foi possível listar os grupos", "bad")); }}>Editar</button>
                        <button type="button" className="is-danger" onClick={() => setAsk({
                          title: "Excluir conexão",
                          text: `${item.name} deixa de enviar ofertas. Essa ação não volta.`,
                          confirm: "Excluir",
                          run: async () => {
                            await api(`/api/connections/${item.id}`, { method: "DELETE" });
                            if (openConn === item.id) setOpenConn(null);
                            await reload();
                            tell("Excluída", "A conexão foi removida.");
                          }
                        })}>Excluir</button>
                      </div>
                    </article>
                  );
                })}
                {bots.map((bot) => (
                  <article key={`bot-${bot.id}`} className="aff-wacard">
                    <header>
                      <div className="aff-wacard__who">
                        <img src="/brands/telegram.svg" alt="" />
                        <div>
                          <strong>{bot.name || "Bot"}</strong>
                          <span>{bot.hasToken ? "Token salvo" : "Sem token"}</span>
                        </div>
                      </div>
                      <em className={`aff-wacard__status${bot.enabled !== false ? " is-on" : ""}`}>{bot.enabled !== false ? "Ativo" : "Pausado"}</em>
                    </header>
                    <p className="aff-wacard__meta">{Array.isArray(bot.chats) ? bot.chats.length : 0} chats</p>
                    <div className="aff-wacard__actions">
                      <button type="button" onClick={() => { setConnName(bot.name || ""); go(`/conexoes/bot/${bot.id}/chats`); }}>Abrir</button>
                      <button type="button" onClick={() => noted("Editado", bot.enabled !== false ? "O bot foi pausado." : "O bot foi ativado.", () => patchBot(bot.id, { enabled: bot.enabled === false }))}>{bot.enabled !== false ? "Pausar" : "Ativar"}</button>
                      <button type="button" className="is-danger" onClick={() => setAsk({
                        title: "Excluir bot",
                        text: `${bot.name || "Bot"} e os chats dele saem da lista.`,
                        confirm: "Excluir",
                        run: async () => {
                          await api(`/api/telegram/${bot.id}`, { method: "DELETE" });
                          if (openBot === bot.id) setOpenBot(null);
                          await reload();
                          tell("Excluído", "O bot foi removido.");
                        }
                      })}>Excluir</button>
                    </div>
                  </article>
                ))}
              </div>
              {!connections.length && !bots.length ? <div className="aff-empty"><strong>Nenhuma conexão</strong><p>Crie um WhatsApp ou um bot do Telegram.</p></div> : null}
              {createOpen ? (
                <div className="aff-modal" role="dialog" aria-modal="true">
                  <button type="button" className="aff-modal__backdrop" aria-label="Fechar" onClick={() => setCreateOpen(false)} />
                  <div className="aff-modal__card">
                    <h2>Nova conexão</h2>
                    <p>Escolha o canal e o nome. Cada conexão pode se chamar diferente, por exemplo AchadosSp no WhatsApp e AchadoSp no Telegram.</p>
                    <div className="aff-kind">
                      <button type="button" className={createKind === "whatsapp" ? "is-on" : ""} onClick={() => setCreateKind("whatsapp")}><img src="/brands/whatsapp.svg" alt="" />WhatsApp</button>
                      <button type="button" className={createKind === "telegram" ? "is-on" : ""} onClick={() => setCreateKind("telegram")}><img src="/brands/telegram.svg" alt="" />Telegram</button>
                    </div>
                    <label>Nome<input value={createName} placeholder={createKind === "whatsapp" ? "ex. AchadosSp" : "ex. AchadoSp"} onChange={(event) => setCreateName(event.target.value)} /></label>
                    {createKind === "telegram" ? <label>Token do @BotFather<input value={createToken} autoComplete="off" placeholder="123456:ABC..." onChange={(event) => setCreateToken(event.target.value)} /></label> : <p>Depois de criar, a janela abre desconectada. O QR só aparece quando você conectar.</p>}
                    <div className="aff-modal__actions">
                      <button type="button" onClick={() => setCreateOpen(false)}>Cancelar</button>
                      <button type="button" className="is-solid" onClick={async () => {
                        const name = createName.trim() || (createKind === "whatsapp" ? "WhatsApp" : "Telegram");
                        try {
                          if (createKind === "whatsapp") {
                            const created = await api<{ session: { id: number } }>("/api/connections", { method: "POST", body: JSON.stringify({ name }) });
                            await reload();
                            setCreateOpen(false);
                            setConnName(name);
                            go(`/conexoes/${created.session.id}/conexao`);
                            tell("Criada", `${name} entrou na lista.`);
                          } else {
                            const token = createToken.trim();
                            if (!/^\d{6,}:[A-Za-z0-9_-]{20,}$/.test(token)) {
                              tell("Token inválido", "Cole o token completo do BotFather.", "bad");
                              return;
                            }
                            const created = await api<{ bot: { id: number } }>("/api/telegram", { method: "POST", body: JSON.stringify({ name, token, stores: [], chats: [] }) });
                            setCreateToken("");
                            await reload();
                            setCreateOpen(false);
                            go(`/conexoes/bot/${created.bot.id}/chats`);
                            tell("Criado", `${name} entrou na lista.`);
                          }
                        } catch (err) {
                          tell("Não criou", err instanceof Error ? err.message : "Não foi possível criar a conexão", "bad");
                        }
                      }}>Criar</button>
                    </div>
                  </div>
                </div>
              ) : null}
              {connections.filter((item) => item.id === openConn).map((item) => {
                const phase = waPhase(item);
                const online = phase === "on";
                const chosen = Array.isArray(item.stores) && item.stores.length ? item.stores : STORES.map((store) => store.id);
                const book = groupBook[item.id];
                const listed = book?.groups || [];
                const query = (groupQuery[item.id] || "").trim().toLowerCase();
                const visible = listed.filter((group) => !query || String(group.name || "").toLowerCase().includes(query));
                const groupPulse = (jid: string) => {
                  const rows = posts.filter((post) => post.group_jid === jid && post.status === "sent" && Number(post.whatsapp_id) === item.id).sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
                  return { sent: rows.length, clicks: rows.reduce((sum, post) => sum + Number(post.click_count || 0), 0), last: rows[0]?.created_at || null };
                };
                return (
                  <div key={item.id} className="aff-modal" role="dialog" aria-modal="true">
                    <button type="button" className="aff-modal__backdrop" aria-label="Fechar" onClick={() => setOpenConn(null)} />
                    <div className={`aff-modal__card is-conn${connTab === "conexao" ? " is-status" : ""}`}>
                      <div className="aff-wahead">
                        <img src="/brands/whatsapp.svg" alt="" />
                        <div>
                          <h2>{item.name}</h2>
                          <p>{phoneOf(item.phone)}</p>
                        </div>
                        <em className={`aff-wabadge is-${phase}`}><i />{waLabel(item, "modal")}</em>
                        <button type="button" onClick={() => setOpenConn(null)}>Fechar</button>
                      </div>
                      <div className="aff-connmodal">
                        <div className="aff-tabs">
                          {[["conexao", "Geral"], ["lojas", "Lojas"], ["grupos", "Grupos"], ["status", item.status_enabled ? "Status ●" : "Status"]].map(([id, label]) => (
                            <button key={id} type="button" className={connTab === id ? "is-on" : ""} onClick={() => { setConnTab(id); if (id === "grupos") loadGroups(item.id).catch((err) => tell("Não listou", err instanceof Error ? err.message : "Não foi possível listar os grupos", "bad")); }}>{label}</button>
                          ))}
                        </div>
                        {connTab === "conexao" ? (
                          <div className="aff-wacenter">
                            {phase === "on" ? (
                              <div className="aff-wastate is-on">
                                <strong>WhatsApp conectado e funcionando normalmente.</strong>
                                <span>A sessão está saudável. As ofertas seguem por esta conexão.</span>
                              </div>
                            ) : null}
                            {phase === "qr" ? (
                              <div className="aff-wastate is-qr">
                                <strong>{item.status === "opening" ? "Gerando o QR Code" : item.status === "reconnecting" ? "Reconectando" : "Aguardando leitura do QR Code"}</strong>
                                <span>{item.status === "qrcode" ? "Abra o WhatsApp no celular e escaneie o código abaixo." : "A sessão está sendo preparada. O código aparece em alguns segundos."}</span>
                              </div>
                            ) : null}
                            {phase === "off" ? (
                              <div className="aff-wastate is-off">
                                <strong>WhatsApp desconectado</strong>
                                <span>Nenhum dispositivo conectado nesta sessão.</span>
                              </div>
                            ) : null}
                            {phase === "bad" ? (
                              <div className="aff-wastate is-off">
                                <strong>Falha ao conectar com o WhatsApp.</strong>
                                <span>Último erro: {item.last_error || "A sessão não concluiu a conexão."}</span>
                              </div>
                            ) : null}
                            {phase === "on" ? (
                              <div className="aff-wafacts">
                                <article><span>Número</span><strong>{phoneOf(item.phone)}</strong></article>
                                <article><span>Status</span><strong>Conectado</strong></article>
                                <article><span>Sessão</span><strong>Ativa</strong></article>
                                <article><span>Criado em</span><strong>{dayOf(item.created_at)}</strong></article>
                                <article><span>Última conexão</span><strong>{item.connected_at ? stamp(item.connected_at) : "Agora"}</strong></article>
                                <article><span>Publicações ativas</span><strong>{Number(item.active_groups || 0).toLocaleString("pt-BR")}</strong></article>
                              </div>
                            ) : null}
                            {phase === "qr" ? (
                              <div className="aff-waqr">
                                {item.qr ? <img alt="QR Code do WhatsApp" width={240} height={240} src={item.qr} /> : <p>Gerando o QR code…</p>}
                                {item.qr ? <p>{(qrLeft(item) || 0) > 0 ? `QR expira em ${qrLeft(item)} segundos` : "QR expirado. Gere um novo código."}</p> : null}
                              </div>
                            ) : null}
                            <label className="aff-waname">Nome<input value={connName} onChange={(event) => setConnName(event.target.value)} /></label>
                            <div className="aff-switchrow">
                              <div><strong>Status do WhatsApp: {item.status_enabled ? "ligado" : "desligado"}</strong><p>Lojas, intervalo, ofertas por vez e limite por dia ficam na aba Status.</p></div>
                              <button type="button" onClick={() => setConnTab("status")}>Abrir Status</button>
                            </div>
                            <div className="aff-wafoot">
                              <button type="button" onClick={async () => {
                                try {
                                  await api(`/api/connections/${item.id}`, { method: "PATCH", body: JSON.stringify({ name: connName.trim() || item.name }) });
                                  await reload();
                                  tell("Editado", "O nome da conexão foi atualizado.");
                                } catch (err) {
                                  tell("Não salvou", err instanceof Error ? err.message : "Não foi possível atualizar o nome", "bad");
                                }
                              }}>Salvar nome</button>
                              {phase === "on" ? (
                                <>
                                  <button type="button" onClick={() => { skipDisconnectToast.current = true; noted("WhatsApp desconectado.", "O WhatsApp foi desligado.", async () => { await api(`/api/connections/${item.id}/stop`, { method: "POST" }); await reload(); }); }}>Desconectar</button>
                                  <button type="button" onClick={() => { skipDisconnectToast.current = true; noted("Reconectando", "A sessão está sendo refeita.", async () => { await api(`/api/connections/${item.id}/stop`, { method: "POST" }); await api(`/api/connections/${item.id}/start`, { method: "POST" }); await reload(); }); }}>Reconectar</button>
                                  <button type="button" className="is-solid" onClick={() => noted("Padrão", "Esta conexão passa a ser a usada no topo.", async () => { await api(`/api/connections/${item.id}/select`, { method: "POST" }); await reload(); })}>{item.selected ? "Já é a padrão" : "Definir como padrão"}</button>
                                </>
                              ) : null}
                              {phase === "qr" ? (
                                <button type="button" className="is-solid" disabled={item.status === "opening"} onClick={() => startConnection(item.id)}>Gerar novo QR</button>
                              ) : null}
                              {phase === "off" ? (
                                <button type="button" className="is-solid" onClick={() => startConnection(item.id)}>Conectar WhatsApp</button>
                              ) : null}
                              {phase === "bad" ? (
                                <button type="button" className="is-solid" onClick={() => startConnection(item.id)}>Tentar novamente</button>
                              ) : null}
                            </div>
                          </div>
                        ) : null}
                        {connTab === "lojas" ? (
                          <div>
                            <p>Esta conexão publica nas lojas marcadas. Marque ao menos uma.</p>
                            <div className="aff-filters">
                              {STORES.map((store) => {
                                const on = chosen.includes(store.id);
                                return (
                                  <button key={store.id} type="button" className={on ? "is-on" : ""} onClick={async () => {
                                    const next = on ? chosen.filter((id: string) => id !== store.id) : [...chosen, store.id];
                                    if (!next.length) return;
                                    try {
                                      await saveConnStores(item.id, next.length === STORES.length ? [] : next);
                                      tell("Salvo", "As lojas desta conexão foram atualizadas.");
                                    } catch (err) {
                                      tell("Não salvou", err instanceof Error ? err.message : "Não foi possível atualizar as lojas", "bad");
                                    }
                                  }}>{store.label}</button>
                                );
                              })}
                            </div>
                          </div>
                        ) : null}
                        {connTab === "grupos" ? (
                          <div>
                            <p>Ative só os grupos desta conexão. O mesmo grupo pode aparecer em outra conta, mas ela só publica se você ativar o grupo nela também.</p>
                            <label className="aff-conn__search">
                              <span>Buscar grupo</span>
                              <input value={groupQuery[item.id] || ""} placeholder="comu, ofertas, sanju" onChange={(event) => setGroupQuery({ ...groupQuery, [item.id]: event.target.value })} />
                            </label>
                            <div className="aff-conn__actions">
                              <button type="button" onClick={() => noted("Atualizado", "A lista de grupos foi atualizada.", () => loadGroups(item.id))}>{book?.loading ? "Buscando grupos…" : "Atualizar grupos"}</button>
                            </div>
                            {book?.message ? <p className="aff-note">{book.message}</p> : null}
                            <p className="aff-note">{query ? `${visible.length} de ${listed.length} grupos` : `${listed.length} grupos`}</p>
                            <div className="aff-groups">
                              {visible.map((group) => {
                                const stats = groupPulse(group.group_jid);
                                return (
                                  <article key={group.group_jid} className={`aff-group${group.enabled ? " is-on" : ""}`}>
                                    <header>
                                      <strong>{group.name || "Grupo"}</strong>
                                      <em>{group.enabled ? "Ativo" : "Pausado"}</em>
                                    </header>
                                    <p>{group.member_count ? `${Number(group.member_count).toLocaleString("pt-BR")} participantes` : "Grupo desta conexão"}</p>
                                    <ul>
                                      <li><span>Envios</span><b>{stats.sent}</b></li>
                                      <li><span>Cliques</span><b>{stats.clicks}</b></li>
                                      <li><span>Último</span><b>{stats.last ? ago(stats.last) : "—"}</b></li>
                                    </ul>
                                    <div className="aff-conn__actions">
                                      <button type="button" onClick={async () => {
                                        try {
                                          if (!group.id) {
                                            await api("/api/groups", { method: "POST", body: JSON.stringify({ groupJid: group.group_jid, name: group.name || group.group_jid, whatsappId: item.id }) });
                                          } else {
                                            await api(`/api/groups/${group.id}`, { method: "PATCH", body: JSON.stringify({ enabled: !group.enabled }) });
                                          }
                                          await loadGroups(item.id);
                                          tell(group.enabled ? "Pausado" : "Ativado", group.enabled ? "Este grupo deixou de receber ofertas." : "Este grupo passa a receber ofertas.");
                                        } catch (err) {
                                          tell("Não salvou", err instanceof Error ? err.message : "Não foi possível salvar o grupo", "bad");
                                        }
                                      }}>{group.enabled ? "Desativar" : "Ativar"}</button>
                                      <button type="button" disabled={!online} onClick={async () => {
                                        try {
                                          const result = await api<{ created: number }>("/api/contacts/extract", { method: "POST", body: JSON.stringify({ whatsappId: item.id, groupJids: [group.group_jid] }) });
                                          await reload();
                                          tell("Contatos", `${result.created} número(s) novo(s) foram para Contatos.`);
                                        } catch (err) {
                                          tell("Não trouxe", err instanceof Error ? err.message : "Não foi possível ler os participantes", "bad");
                                        }
                                      }}>Trazer contatos</button>
                                    </div>
                                  </article>
                                );
                              })}
                            </div>
                            {!listed.length && !book?.loading ? <p className="aff-note">{online ? "Nenhum grupo encontrado nesta conta ainda." : "Gere o QR, leia no WhatsApp e volte nesta aba."}</p> : null}
                            {listed.length && !visible.length ? <p className="aff-note">Nenhum grupo com “{query}”.</p> : null}
                          </div>
                        ) : null}
                        {connTab === "status" ? (
                          <StatusTab
                            key={item.id}
                            conn={item}
                            stores={STORES.filter((store) => stores.find((row) => row.marketplace === store.id)?.enabled)}
                            posts={posts}
                            activeGroups={Number(item.active_groups || 0)}
                            ago={ago}
                            speakWait={speakWait}
                            onSaved={reload}
                            tell={tell}
                          />
                        ) : null}
                      </div>
                    </div>
                  </div>
                );
              })}
              {bots.filter((bot) => bot.id === openBot).map((bot) => {
                const draft = chatDraft[bot.id] || { chatId: "", title: "" };
                const botStores = Array.isArray(bot.stores) && bot.stores.length ? bot.stores : STORES.map((store) => store.id);
                const chats = Array.isArray(bot.chats) ? bot.chats : [];
                return (
                  <div key={bot.id} className="aff-modal" role="dialog" aria-modal="true">
                    <button type="button" className="aff-modal__backdrop" aria-label="Fechar" onClick={() => setOpenBot(null)} />
                    <div className="aff-modal__card is-conn">
                      <div className="aff-conndesk__head">
                        <div><h2>{bot.name || "Bot"}</h2><p>{bot.enabled !== false ? "Ativo" : "Pausado"}</p></div>
                        <button type="button" onClick={() => setOpenBot(null)}>Fechar</button>
                      </div>
                      <div className="aff-connmodal">
                        <div className="aff-tabs">
                          {[["bot", "Geral"], ["lojas", "Lojas"], ["chats", "Chats"]].map(([id, label]) => (
                            <button key={id} type="button" className={botTab === id ? "is-on" : ""} onClick={() => setBotTab(id)}>{label}</button>
                          ))}
                        </div>
                        {botTab === "bot" ? (
                          <div className="aff-form">
                            <label>Nome<input value={connName || bot.name || ""} onChange={(event) => setConnName(event.target.value)} /></label>
                            <div className="aff-conn__actions">
                              <button type="button" className="is-solid" onClick={() => noted("Editado", "O nome do bot foi atualizado.", () => patchBot(bot.id, { name: (connName || bot.name || "Telegram").trim() }))}>Salvar nome</button>
                              <button type="button" onClick={() => noted("Editado", bot.enabled !== false ? "O bot foi pausado." : "O bot foi ativado.", () => patchBot(bot.id, { enabled: bot.enabled === false }))}>{bot.enabled !== false ? "Pausar" : "Ativar"}</button>
                            </div>
                            <p>O token fica salvo. Para trocar, exclua o bot e crie de novo em Nova conexão.</p>
                          </div>
                        ) : null}
                        {botTab === "lojas" ? (
                          <div>
                            <p>Este bot publica nas lojas marcadas.</p>
                            <div className="aff-filters">
                              {STORES.map((store) => {
                                const on = botStores.includes(store.id);
                                return (
                                  <button key={store.id} type="button" className={on ? "is-on" : ""} onClick={async () => {
                                    const next = on ? botStores.filter((id: string) => id !== store.id) : [...botStores, store.id];
                                    if (!next.length) return;
                                    await noted("Salvo", "As lojas do bot foram atualizadas.", () => patchBot(bot.id, { stores: next.length === STORES.length ? [] : next }));
                                  }}>{store.label}</button>
                                );
                              })}
                            </div>
                          </div>
                        ) : null}
                        {botTab === "chats" ? (
                          <div>
                            <div className="aff-conn__add">
                              <input value={draft.chatId} placeholder="ID do chat, ex. -1001234567890" onChange={(event) => setChatDraft({ ...chatDraft, [bot.id]: { ...draft, chatId: event.target.value } })} />
                              <input value={draft.title} placeholder="Nome do grupo ou canal" onChange={(event) => setChatDraft({ ...chatDraft, [bot.id]: { ...draft, title: event.target.value } })} />
                              <button type="button" onClick={async () => {
                                const chatId = draft.chatId.trim();
                                if (!/^-?\d{4,}$/.test(chatId) && !/^@[A-Za-z][\w]{3,}$/.test(chatId)) {
                                  tell("Chat inválido", "O chat precisa ser um ID numérico ou um @canal.", "bad");
                                  return;
                                }
                                if (chats.some((chat: { chatId: string }) => chat.chatId === chatId)) return;
                                await noted("Criado", "O chat foi adicionado.", () => patchBot(bot.id, { chats: [...chats, { chatId, title: draft.title.trim() || chatId, enabled: true, stores: [], categories: "" }] }));
                                setChatDraft({ ...chatDraft, [bot.id]: { chatId: "", title: "" } });
                              }}>Adicionar chat</button>
                            </div>
                            <div className="aff-groups">
                              {chats.map((chat: { chatId: string; title?: string; enabled?: boolean }) => (
                                <article key={chat.chatId} className={`aff-group${chat.enabled !== false ? " is-on" : ""}`}>
                                  <header><strong>{chat.title || chat.chatId}</strong><em>{chat.enabled !== false ? "Ativo" : "Pausado"}</em></header>
                                  <p>{chat.chatId}</p>
                                  <div className="aff-conn__actions">
                                    <button type="button" onClick={() => noted("Editado", chat.enabled !== false ? "O chat foi pausado." : "O chat foi ativado.", () => patchBot(bot.id, { chats: chats.map((row: { chatId: string }) => row.chatId === chat.chatId ? { ...row, enabled: chat.enabled === false } : row) }))}>{chat.enabled !== false ? "Desativar" : "Ativar"}</button>
                                    <button type="button" onClick={() => noted("Removido", "O chat saiu do bot.", () => patchBot(bot.id, { chats: chats.filter((row: { chatId: string }) => row.chatId !== chat.chatId) }))}>Remover</button>
                                  </div>
                                </article>
                              ))}
                            </div>
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </div>
                );
              })}
            </section>
          )}

          {view === "contacts" && (() => {
            const query = contactQuery.trim().toLowerCase();
            const rows = contacts.filter((row) => {
              if (!query) return true;
              const name = String(row.name || "");
              const phone = String(row.phone || "");
              return name.toLowerCase().includes(query) || phone.includes(query.replace(/\D/g, "")) || phone.includes(query);
            });
            const origin = (source?: string) => source === "grupo" ? "Grupo" : source === "manual" ? "Manual" : source === "import" || source === "arquivo" ? "Importado" : "Contato";
            const sessionRow = connections.find((item) => item.id === contactConn);
            const catalog = connections.flatMap((item) => (groupBook[item.id]?.groups || []).map((group) => ({
              ...group,
              connectionId: item.id as number,
              connectionName: String(item.name || "WhatsApp"),
              online: item.status === "connected",
              syncedAt: groupBook[item.id]?.syncedAt || 0,
              key: `${item.id}|${group.group_jid}`
            })));
            const listed = contactConn === "all" ? catalog : catalog.filter((group) => group.connectionId === contactConn);
            const needle = groupFind.trim().toLowerCase();
            const visibleGroups = listed.filter((group) => !needle || String(group.name || "").toLowerCase().includes(needle) || String(group.connectionName || "").toLowerCase().includes(needle));
            const visibleKeys = visibleGroups.map((group) => group.key);
            const allVisible = visibleKeys.length > 0 && visibleKeys.every((key) => picked.includes(key));
            const groupsLoading = connections.some((item) => groupBook[item.id]?.loading);
            const ready = contactConn === "all" ? connections.some((item) => item.status === "connected") : sessionRow?.status === "connected";
            const offerGroups = catalog.filter((group) => group.admin || group.enabled);
            const sourcePick = catalog.find((group) => group.key === queueSource);
            const destPick = catalog.find((group) => group.key === queueGroup);
            const extracted = contacts.filter((row) => row.source === "grupo").length;
            const added = jobs.reduce((sum, job) => sum + Number(job.added || 0), 0);
            const invites = jobs.reduce((sum, job) => sum + Number(job.invites || 0), 0);
            const failed = jobs.reduce((sum, job) => sum + Number(job.failed || 0), 0);
            const liveJobs = jobs.filter((job) => job.status === "running" || job.status === "paused");
            const pastJobs = jobs.filter((job) => job.status !== "running" && job.status !== "paused");
            const refreshJobs = async () => {
              const data = await api<{ jobs: any[]; events?: any[]; growth?: Array<{ group_jid: string; added: number }> }>("/api/audience/jobs");
              setJobs(data.jobs || []);
              setQueueEvents(data.events || []);
              const growth: Record<string, number> = {};
              for (const row of data.growth || []) growth[row.group_jid] = Number(row.added || 0);
              setQueueGrowth(growth);
            };
            const ago = (at?: number) => {
              if (!at) return "ainda não";
              const min = Math.max(0, Math.round((Date.now() - at) / 60000));
              if (min < 1) return "agora";
              if (min < 60) return `há ${min} minuto${min > 1 ? "s" : ""}`;
              const hours = Math.round(min / 60);
              return `há ${hours} hora${hours > 1 ? "s" : ""}`;
            };
            const pullNumbers = async () => {
              const batches = new Map<number, string[]>();
              for (const key of picked) {
                const [rawId, jid] = String(key).split("|");
                const owner = connections.find((item) => item.id === Number(rawId));
                if (!jid?.endsWith("@g.us") || !owner) continue;
                if (owner.status !== "connected") {
                  tell("WhatsApp desconectado.", `Conecte ${owner.name} antes de ler os grupos.`, "bad");
                  return;
                }
                batches.set(owner.id, [...(batches.get(owner.id) || []), jid]);
              }
              if (!batches.size) {
                tell("Nenhum grupo", "Marque ao menos um grupo.", "bad");
                return;
              }
              setExtracting(true);
              let created = 0;
              try {
                for (const [whatsappId, jids] of batches) {
                  for (let index = 0; index < jids.length; index += 4) {
                    const result = await api<{ created: number }>("/api/contacts/extract", { method: "POST", body: JSON.stringify({ whatsappId, groupJids: jids.slice(index, index + 4) }) });
                    created += Number(result.created || 0);
                  }
                }
                await reload();
                tell("Contatos", `${created} número(s) novo(s) foram para a Base.`);
                setContactTab("base");
              } catch (err) {
                tell("Não extraiu", err instanceof Error ? err.message : "Não foi possível ler os grupos", "bad");
              } finally {
                setExtracting(false);
              }
            };
            return (
              <section className="aff-block aff-people">
                <header className="aff-people__hero">
                  <div>
                    <p>Um número, um contato</p>
                    <h2>Contatos</h2>
                  </div>
                  <span className={ready ? "is-on" : ""}>{ready ? "Conexão pronta" : "Sem conexão"}</span>
                </header>
                <div className="aff-people__stats">
                  <article><span>Contatos</span><strong>{contacts.length}</strong></article>
                  <article><span>Grupos</span><strong>{listed.length}</strong></article>
                  <article><span>Extraídos</span><strong>{extracted}</strong></article>
                  <article><span>Adicionados</span><strong>{added}</strong></article>
                  <article><span>Convites</span><strong>{invites}</strong></article>
                  <article><span>Falhas</span><strong>{failed}</strong></article>
                </div>
                <div className="aff-people__tabs">
                  {([["extrair", "Extrair"], ["base", "Base"], ["fila", "Fila"], ["historico", "Histórico"]] as const).map(([id, label]) => (
                    <button key={id} type="button" className={contactTab === id ? "is-on" : ""} onClick={() => setContactTab(id)}>{label}</button>
                  ))}
                </div>
                {contactTab === "extrair" ? (
                  <div className="aff-people__panel">
                    <div className="aff-people__toolbar">
                      <input value={groupFind} placeholder="Buscar grupo" onChange={(event) => setGroupFind(event.target.value)} />
                      <select value={contactConn} onChange={(event) => { const value = event.target.value; setContactConn(value === "all" ? "all" : Number(value)); setPicked([]); }}>
                        <option value="all">Todas as conexões</option>
                        {connections.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                      </select>
                      <button type="button" disabled={!connections.length || groupsLoading} onClick={() => {
                        const ids = contactConn === "all" ? connections.map((item) => item.id) : [Number(contactConn)];
                        Promise.all(ids.map((id) => loadGroups(id))).catch((err) => tell("Não listou", err instanceof Error ? err.message : "Não foi possível listar os grupos", "bad"));
                      }}>{groupsLoading ? "Buscando grupos…" : "Atualizar grupos"}</button>
                      <button type="button" disabled={!visibleKeys.length} onClick={() => setPicked(allVisible ? picked.filter((key) => !visibleKeys.includes(key)) : [...new Set([...picked, ...visibleKeys])])}>{allVisible ? "Limpar visíveis" : "Marcar visíveis"}</button>
                      <button type="button" className="is-solid" disabled={extracting || !picked.length} onClick={pullNumbers}>{extracting ? "Lendo grupos…" : "Extrair"}</button>
                    </div>
                    {contactConn !== "all" && groupBook[contactConn]?.message ? <p className="aff-people__hint">{groupBook[contactConn]?.message}</p> : <p className="aff-people__hint">Aparecem os grupos de todas as conexões de WhatsApp. O selo Administrador marca onde dá para incluir pessoas. Extrair copia os telefones para a Base.</p>}
                    {visibleGroups.length ? (
                      <div className="aff-people__groups">
                        {visibleGroups.map((group) => {
                          const on = picked.includes(group.key);
                          return (
                            <label key={group.key} className={on ? "is-on" : ""}>
                              <input type="checkbox" checked={on} onChange={() => setPicked(on ? picked.filter((key) => key !== group.key) : [...picked, group.key])} />
                              <strong>{group.name || "Grupo"}</strong>
                              <span>{group.connectionName} · {Number(group.member_count || 0).toLocaleString("pt-BR")} pessoas{group.admin ? " · Administrador" : ""}</span>
                            </label>
                          );
                        })}
                      </div>
                    ) : <div className="aff-people__empty"><strong>{groupsLoading ? "Buscando os grupos das conexões" : "Nenhum grupo nesta busca"}</strong><p>{groupsLoading ? "A lista chega de cada WhatsApp conectado." : "Atualize os grupos ou troque o texto da busca."}</p></div>}
                  </div>
                ) : null}
                {contactTab === "base" ? (
                  <div className="aff-people__panel">
                    <div className="aff-people__toolbar">
                      <input value={contactQuery} placeholder="Buscar nome ou número" onChange={(event) => setContactQuery(event.target.value)} />
                      <label className="aff-people__file">Importar
                        <input type="file" accept=".csv,.txt,.xlsx,.xls" onChange={async (event) => {
                          const file = event.target.files?.[0];
                          event.target.value = "";
                          if (!file) return;
                          const body = new FormData();
                          body.append("file", file);
                          try {
                            const result = await api<{ created: number }>("/api/contacts/import", { method: "POST", body });
                            await reload();
                            tell("Importado", `${result.created} número(s) novo(s) entraram na lista.`);
                          } catch (err) {
                            tell("Não importou", err instanceof Error ? err.message : "Não foi possível ler o arquivo", "bad");
                          }
                        }} />
                      </label>
                      <button type="button" className="is-solid" onClick={() => setContactOpen(true)}>Adicionar</button>
                    </div>
                {rows.length ? (
                  <div className="aff-tablewrap">
                    <table className="aff-table aff-people__table">
                      <thead><tr><th>Nome</th><th>Número</th><th>Origem</th><th>Etiquetas</th><th></th></tr></thead>
                      <tbody>
                        {rows.map((row) => {
                          const name = String(row.name || (row.names || []).filter(Boolean)[0] || "");
                          return (
                            <tr key={row.id}>
                              <td>
                                <div className="aff-person">
                                  <span>{personMark(name)}</span>
                                  <div><strong>{name || "Sem nome"}</strong>{row.blocked ? <small>Bloqueado</small> : null}</div>
                                </div>
                              </td>
                              <td>{prettyPhone(row.phone)}</td>
                              <td className="is-quiet">{origin(row.source)}</td>
                              <td><div className="aff-pills">{(row.tags || []).length ? (row.tags || []).map((tag: string) => <em key={tag}>{tag}</em>) : <em>Sem etiqueta</em>}</div></td>
                              <td>
                                <button type="button" className="is-danger" onClick={() => setAsk({
                                  title: "Excluir contato",
                                  text: `Remover ${prettyPhone(row.phone)} da lista?`,
                                  confirm: "Excluir",
                                  run: async () => {
                                    await api(`/api/contacts/${row.id}`, { method: "DELETE" });
                                    await reload();
                                    tell("Excluído", "O contato saiu da lista.");
                                  }
                                })}>Excluir</button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                ) : <div className="aff-people__empty"><strong>{contacts.length ? "Nenhum contato com essa busca" : "Nenhum contato ainda"}</strong><p>Extraia os números dos grupos ou adicione um aqui.</p></div>}
                  </div>
                ) : null}
                {contactTab === "fila" || contactTab === "historico" ? (
                  <div className="aff-people__panel">
                    {contactTab === "fila" ? (
                      <>
                      <div className="aff-move__pair">
                        <article>
                          <p>Grupo origem</p>
                          <strong>{sourcePick?.name || "Escolha um grupo"}</strong>
                          {sourcePick ? (
                            <ul>
                              <li>Participantes encontrados <b>{Number(sourcePick.member_count || 0).toLocaleString("pt-BR")}</b></li>
                              <li>Administradores <b>{Number(sourcePick.admins || 0).toLocaleString("pt-BR")}</b></li>
                              <li>Última sincronização <b>{ago(sourcePick.syncedAt)}</b></li>
                              <li>{sourcePick.connectionName}</li>
                            </ul>
                          ) : <em>Selecione o grupo para ver quantas pessoas ele tem.</em>}
                        </article>
                        <article>
                          <p>Grupo destino</p>
                          <strong>{destPick?.name || "Escolha o grupo das ofertas"}</strong>
                          {destPick ? (
                            <ul>
                              <li>Participantes atuais <b>{Number(destPick.member_count || 0).toLocaleString("pt-BR")}</b></li>
                              <li>Crescimento hoje <b>+{Number(queueGrowth[destPick.group_jid] || 0).toLocaleString("pt-BR")}</b></li>
                              <li>{destPick.connectionName}</li>
                            </ul>
                          ) : <em>Este é o grupo que recebe as pessoas.</em>}
                        </article>
                      </div>
                      <form className="aff-people__toolbar" onSubmit={async (event) => {
                        event.preventDefault();
                        const dest = catalog.find((group) => group.key === queueGroup);
                        const source = catalog.find((group) => group.key === queueSource);
                        if (!dest?.group_jid?.endsWith("@g.us")) {
                          tell("Escolha o grupo das ofertas", "Selecione o grupo que vai receber as pessoas.", "bad");
                          return;
                        }
                        if (!dest.online) {
                          tell("WhatsApp desconectado.", `Conecte ${dest.connectionName} antes de montar a fila.`, "bad");
                          return;
                        }
                        if (source && !source.online) {
                          tell("WhatsApp desconectado.", `Conecte ${source.connectionName} para ler os contatos desse grupo.`, "bad");
                          return;
                        }
                        if (source && source.group_jid === dest.group_jid) {
                          tell("Grupos iguais", "Escolha um grupo de origem diferente do grupo das ofertas.", "bad");
                          return;
                        }
                        const count = Math.min(3, Math.max(1, Number(queueCount) || 1));
                        const every = Math.max(1, Number(queueEvery) || 1);
                        const intervalSeconds = Math.min(24 * 60 * 60, Math.max(60, (queueUnit === "hours" ? every * 60 : every) * 60));
                        const perHour = Math.min(30, Math.max(1, Math.floor(3600 / intervalSeconds) * count));
                        const perDay = Math.min(150, Math.max(1, Math.floor(86400 / intervalSeconds) * count));
                        setQueueBusy(true);
                        try {
                          const result = await api<{ queued: number }>("/api/audience/queue", {
                            method: "POST",
                            body: JSON.stringify({
                              whatsappId: dest.connectionId,
                              groupJid: dest.group_jid,
                              sourceWhatsappId: source?.connectionId,
                              sourceGroupJid: source?.group_jid,
                              sourceName: source?.name || "",
                              sourceMembers: Number(source?.member_count || 0),
                              sourceAdmins: Number(source?.admins || 0),
                              mode: "add",
                              intervalSeconds,
                              batchSize: count,
                              perHour,
                              perDay
                            })
                          });
                          await refreshJobs();
                          await reload();
                          tell("Fila ligada", `${result.queued} número(s) entram aos poucos: ${count} a cada ${every} ${queueUnit === "hours" ? "hora(s)" : "minuto(s)"}.`);
                        } catch (err) {
                          tell("Não começou", err instanceof Error ? err.message : "Não foi possível criar a fila", "bad");
                        } finally {
                          setQueueBusy(false);
                        }
                      }}>
                        <label className="aff-people__field">Contatos do grupo
                          <select value={queueSource} onChange={(event) => setQueueSource(event.target.value)}>
                            <option value="">Toda a Base</option>
                            {catalog.map((group) => <option key={`src-${group.key}`} value={group.key}>{group.name} · {group.connectionName}</option>)}
                          </select>
                        </label>
                        <label className="aff-people__field">Grupo das ofertas
                          <select value={queueGroup} onChange={(event) => setQueueGroup(event.target.value)}>
                            <option value="">Escolha o grupo</option>
                            {offerGroups.map((group) => <option key={`dst-${group.key}`} value={group.key}>{group.name} · {group.connectionName}{group.enabled ? " · ofertas" : ""}{group.admin ? " · administrador" : ""}</option>)}
                          </select>
                        </label>
                        <label className="aff-people__field">Quantidade
                          <input inputMode="numeric" value={queueCount} onChange={(event) => setQueueCount(event.target.value.replace(/[^\d]/g, "").slice(0, 1))} placeholder="1" />
                        </label>
                        <label className="aff-people__field">A cada
                          <input inputMode="numeric" value={queueEvery} onChange={(event) => setQueueEvery(event.target.value.replace(/[^\d]/g, "").slice(0, 4))} placeholder="5" />
                        </label>
                        <label className="aff-people__field">Intervalo
                          <select value={queueUnit} onChange={(event) => setQueueUnit(event.target.value === "hours" ? "hours" : "minutes")}>
                            <option value="minutes">minutos</option>
                            <option value="hours">horas</option>
                          </select>
                        </label>
                        <button type="submit" className="is-solid" disabled={queueBusy || liveJobs.length > 0}>{queueBusy ? "Lendo o grupo…" : "Iniciar extração"}</button>
                        <p className="aff-people__hint">Escolha o grupo de onde saem os contatos e o grupo de ofertas que recebe. Os dois podem ser de conexões diferentes. O teto é 3 por vez, 30 por hora e 150 por dia, com pelo menos 1 minuto entre as levas. Isso reduz o risco de bloqueio, sem impedir o WhatsApp de limitar a conta.</p>
                      </form>
                      </>
                    ) : null}
                    {contactTab === "historico" ? (
                      pastJobs.length ? pastJobs.map((job) => (
                        <article key={job.id} className="aff-people__job">
                          <div>
                            <strong>{job.group_name || "Grupo"}</strong>
                            <em>{job.status === "done" ? "Concluída" : job.status === "canceled" ? "Encerrada" : job.status} · {Number(job.added || 0)} adicionados · {Number(job.already || 0)} já estavam · {Number(job.failed || 0)} falhas</em>
                          </div>
                          <button type="button" onClick={() => downloadReport(job.id).catch((err) => tell("Não exportou", err instanceof Error ? err.message : "Não foi possível exportar o relatório.", "bad"))}>Exportar relatório</button>
                        </article>
                      )) : <div className="aff-people__empty"><strong>Nenhum histórico</strong><p>As operações concluídas aparecem aqui.</p></div>
                    ) : liveJobs[0] || pastJobs[0] ? (
                      <MoveBoard job={liveJobs[0] || pastJobs[0]} events={queueEvents} online={connections.some((item) => item.id === (liveJobs[0] || pastJobs[0])?.whatsapp_id && item.status === "connected")} onRefresh={refreshJobs} onError={(message) => tell("Fila", message, "bad")} />
                    ) : <div className="aff-people__empty"><strong>Nenhuma operação ainda</strong><p>Escolha o grupo de origem para ver o tamanho dele e inicie a extração.</p></div>}
                  </div>
                ) : null}
                {contactOpen ? (
                  <div className="aff-modal" role="dialog" aria-modal="true">
                    <button type="button" className="aff-modal__backdrop" aria-label="Fechar" onClick={() => setContactOpen(false)} />
                    <form className="aff-modal__card" onSubmit={async (event) => {
                      event.preventDefault();
                      const form = new FormData(event.currentTarget);
                      try {
                        await api("/api/contacts/manual", { method: "POST", body: JSON.stringify({ name: form.get("name"), phone: form.get("phone"), tags: ["Manual"] }) });
                        setContactOpen(false);
                        await reload();
                        tell("Salvo", "O número foi guardado.");
                      } catch (err) {
                        tell("Não salvou", err instanceof Error ? err.message : "Não foi possível guardar o número", "bad");
                      }
                    }}>
                      <h2>Adicionar contato</h2>
                      <label>Nome<input name="name" placeholder="Nome de quem recebe" /></label>
                      <label>Telefone<input name="phone" required placeholder="11999998888" /></label>
                      <div className="aff-modal__actions">
                        <button type="button" onClick={() => setContactOpen(false)}>Cancelar</button>
                        <button className="is-solid" type="submit">Salvar</button>
                      </div>
                    </form>
                  </div>
                ) : null}
              </section>
            );
          })()}

          {view === "links" && (
            <section className="aff-block">
              <header><h2>Links afiliados</h2></header>
              <div className="aff-links">
                {posts.filter((post) => post.status === "sent").map((post) => (
                  <article key={post.id}><strong>{post.title}</strong><a href={post.url} target="_blank" rel="noreferrer">{post.url}</a><span>{post.click_count || 0} cliques</span></article>
                ))}
              </div>
            </section>
          )}

          {view === "analytics" && (
            <section className="aff-block">
              <header><h2>Analytics</h2></header>
              <section className="aff-metrics">
                <article><span>Envios</span><strong>{posts.filter((post) => post.status === "sent").length}</strong></article>
                <article><span>Cliques</span><strong>{posts.reduce((sum, post) => sum + Number(post.click_count || 0), 0)}</strong></article>
              </section>
            </section>
          )}

          {view === "auto" && (
            <section className="aff-block aff-guidepage">
              <header className="aff-guidepage__head"><div><h2>Automação</h2><p>Baixe a extensão, instale no Chrome ou no Edge e copie o cookie da loja.</p></div><a className="is-solid" href="/achadinhos-cookie.zip" download>Baixar extensão</a></header>
              <div className="aff-guidepage__grid">
                {[["Baixar", "Clique em Baixar extensão e descompacte o arquivo. Sai a pasta achadinhos-cookie."], ["Chrome ou Edge", "Abra chrome://extensions (ou edge://extensions), ligue o Modo do desenvolvedor, clique em Carregar sem compactação e escolha a pasta."], ["Copiar cookie", "Entre na sua conta do Mercado Livre, clique no ícone da extensão e em Copiar cookie."], ["Salvar", "Em Lojas → Mercado Livre, cole no campo Cookie do gerador e salve. Vale por cerca de 30 dias."]].map(([title, text], index) => (
                  <article key={title}><b>{index + 1}</b><div><strong>{title}</strong><span>{text}</span></div></article>
                ))}
              </div>
              <section className="aff-ext">
                <div>
                  <strong>Envio automático do cookie</strong>
                  <p>Gere o código, cole na extensão em Envio automático e clique em Ligar. A extensão manda o cookie sozinha duas vezes por dia e sempre que o Mercado Livre renova a sessão, enquanto o navegador estiver aberto e logado.</p>
                  <p>{setting?.ml_cookie_synced_at ? `Último envio automático: ${new Date(setting.ml_cookie_synced_at).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}.` : setting?.extKeySet ? "Código gerado. Nenhum envio automático chegou ainda." : "Envio automático ainda não ligado."}</p>
                  {extCode ? <p><code style={{ wordBreak: "break-all" }}>{extCode}</code><br />O código aparece só agora. Gerar outro desliga o anterior.</p> : null}
                </div>
                <button type="button" className="is-solid aff-ext__btn" onClick={async () => {
                  try {
                    const data = await api<{ key: string }>("/api/extension-key", { method: "POST" });
                    const code = `${window.location.origin}|${data.key}`;
                    setExtCode(code);
                    await navigator.clipboard.writeText(code).catch(() => undefined);
                    await reload();
                    tell("Código gerado", "Copiado. Cole na extensão, em Envio automático.");
                  } catch (err) {
                    tell("Não gerou", err instanceof Error ? err.message : "Não foi possível gerar o código", "bad");
                  }
                }}>{setting?.extKeySet ? "Gerar novo código" : "Gerar código"}</button>
              </section>
            </section>
          )}

          {view === "billing" && <BillingView onPaid={async () => { await onRefresh?.(); }} tell={tell} />}

          {view === "help" && (
            <div className="aff-guide-wrap">
              <section className="aff-block aff-guide">
                <header className="aff-guide__head"><h2>Material de apoio</h2><p>Guias para conectar cada loja e publicar no grupo.</p></header>
                <div className="aff-guide__grid">
                  {GUIDES.filter((item) => !guide || item[0] === guide).map((item) => (
                    <article key={item[0]} className="aff-guide-card">
                      <header>
                        <span className="aff-guide-card__logo"><span className="aff-guide__mark">{item[1]}</span></span>
                        <div className="aff-guide-card__id"><strong>{item[2]}</strong><span className={`aff-pill ${item[3] === "Implementado" ? "is-ok" : "is-partial"}`}>{item[3]}</span></div>
                      </header>
                      <h3>{item[4]}</h3>
                      <ul><li>{item[5]}</li></ul>
                      <p>{item[6]}</p>
                      {guide === item[0] && GUIDE_STEPS[item[0]] ? (
                        <ol className="aff-steps">{GUIDE_STEPS[item[0]].map((step) => <li key={step}>{step}</li>)}</ol>
                      ) : null}
                      <div className="aff-guide-card__actions">
                        <button type="button" className="is-solid" onClick={() => setGuide(guide === item[0] ? "" : item[0])}>{guide === item[0] ? "Fechar guia" : "Abrir guia"}</button>
                        <button type="button" onClick={() => setView("stores")}>Ver documentação</button>
                      </div>
                    </article>
                  ))}
                </div>
              </section>
            </div>
          )}

          {view === "config" && (
            <section className="aff-block aff-pane aff-config">
              <div className="aff-tabs">
                {[["geral", "Geral"], ["envio", "Envio"], ["filtros", "Filtros"], ["horarios", "Horários"], ["equipe", "Equipe"], ["logs", "Logs"]].map(([id, label]) => (
                  <button key={id} type="button" className={configTab === id ? "is-on" : ""} onClick={() => { setConfigTab(id); setConfigNote(""); }}>{label}</button>
                ))}
              </div>
              {configTab === "geral" && (
                <div className="aff-prefs">
                  <div className="aff-switchrow"><div><strong>Mercado Livre aleatório</strong><p>Ignora as palavras das campanhas e busca ofertas gerais do catálogo.</p></div><button type="button" className={`aff-switch${setting?.random_catalog !== false ? " is-on" : ""}`} onClick={() => saveSetting({ randomCatalog: setting?.random_catalog === false }, "O modo do Mercado Livre foi atualizado.")}><i /></button></div>
                  <div className="aff-switchrow"><div><strong>Publicar em todos os grupos</strong><p>Envia para todos os grupos desta conexão. Desligado, só os grupos marcados recebem.</p></div><button type="button" className={`aff-switch${setting?.send_all_groups ? " is-on" : ""}`} onClick={() => saveSetting({ sendAllGroups: !setting?.send_all_groups }, "O envio para os grupos foi atualizado.")}><i /></button></div>
                </div>
              )}
              {configTab === "envio" && (
                <div className="aff-cadence">
                  <label className="aff-people__field">Conexão
                    <select value={envioSession?.id || ""} onChange={(event) => setEnvioConn(Number(event.target.value))}>
                      {connections.map((item) => (
                        <option key={item.id} value={item.id}>{item.name}{item.selected ? " · padrão" : ""} · {item.active_groups || 0} grupo(s) ativo(s)</option>
                      ))}
                    </select>
                  </label>
                  <p>Cada conexão espera o próprio tempo e só publica nos grupos ativados nela. O mínimo é 15 segundos. O último envio conta só as publicações desta conexão.</p>
                  {envioSession && !envioSession.active_groups ? <p className="aff-config-error">{envioSession.name} não tem grupo ativado, então não envia oferta.</p> : null}
                  {STORES.filter((store) => stores.find((item) => item.marketplace === store.id)?.enabled).filter((store) => {
                    const allowed = Array.isArray(envioSession?.stores) && envioSession.stores.length ? envioSession.stores : null;
                    return !allowed || allowed.includes(store.id);
                  }).map((store) => {
                    const parts = cadenceOf(store.id, envioSession?.id);
                    const last = pulse(store.id, envioSession?.id).last;
                    return (
                      <article key={store.id} className="aff-sendcard">
                        <img src={`/deals-logos/${store.logo}`} alt="" />
                        <div><strong>{store.label}</strong><p>Último envio: {last ? ago(last) : "ainda não"}</p><p>Próxima publicação: {waitLabel(store.id, envioSession?.id)}</p></div>
                        <div className="aff-sendcard__time">
                          <span>Intervalo</span>
                          <label>minutos<input type="number" min="0" max="1440" value={parts.minutes} onChange={(event) => setCadencePart(store.id, "minutes", event.target.value)} /></label>
                          <label>segundos<input type="number" min="0" max="59" value={parts.seconds} onChange={(event) => setCadencePart(store.id, "seconds", event.target.value)} /></label>
                          <small className={parts.total < 15 ? "is-bad" : ""}>Mínimo de 15 segundos.</small>
                        </div>
                      </article>
                    );
                  })}
                  <article className="aff-pref">
                    <label>Aguardar entre publicações<input type="number" min="5" max="180" value={envioSession?.interval_seconds ?? setting?.interval_seconds ?? ""} onChange={(event) => { setEnvioNote(""); const raw = event.target.value; setConnections((rows) => rows.map((item) => item.id === envioSession?.id ? { ...item, interval_seconds: raw === "" ? "" : Number(raw) } : item)); }} /></label>
                    <small>Quando duas lojas ficarem prontas ao mesmo tempo, o sistema espera esse tempo antes de enviar a próxima oferta.</small>
                  </article>
                  <article className="aff-pref">
                    <label>Ofertas por vez<input type="number" min="1" max="5" value={envioSession?.posts_per_cycle ?? setting?.posts_per_cycle ?? ""} onChange={(event) => { setEnvioNote(""); const raw = event.target.value; setConnections((rows) => rows.map((item) => item.id === envioSession?.id ? { ...item, posts_per_cycle: raw === "" ? "" : Number(raw) } : item)); }} /></label>
                    <small>Em cada loja, o robô publica até essa quantidade e depois espera o intervalo dela.</small>
                  </article>
                  {envioNote ? <p className="aff-config-error">{envioNote}</p> : null}
                  <button type="button" className="is-solid" onClick={saveEnvio}>Salvar alterações</button>
                </div>
              )}
              {configTab === "filtros" && (
                <form className="aff-filtergrid" onSubmit={async (event) => {
                  event.preventDefault();
                  setConfigNote("");
                  await saveSetting({
                    minDiscount: Number(filterDraft.discount || 0) || null,
                    maxPriceCents: moneyToCents(filterDraft.max)
                  }, "Os filtros foram gravados.");
                }}>
                  <article><label>Desconto mínimo<input name="discount" inputMode="decimal" value={filterDraft.discount} onChange={(event) => { setConfigNote(""); setFilterDraft({ ...filterDraft, discount: event.target.value.replace(/[^\d]/g, "") }); }} /></label></article>
                  <article><label>Preço máximo<input name="max" inputMode="decimal" value={filterDraft.max} placeholder="199,90" onChange={(event) => { setConfigNote(""); setFilterDraft({ ...filterDraft, max: event.target.value }); }} /></label></article>
                  {configNote ? <p className={configNote.endsWith("salvos.") ? "" : "aff-config-error"}>{configNote}</p> : null}
                  <button className="is-solid" type="submit">Salvar filtros</button>
                </form>
              )}
              {configTab === "horarios" && (
                <form className="aff-hours" onSubmit={async (event) => {
                  event.preventDefault();
                  setConfigNote("");
                  await saveSetting({
                    allowedDays: setting?.allowed_days || "",
                    hourStart: setting?.hour_start ?? null,
                    hourEnd: setting?.hour_end ?? null
                  }, "Os horários foram gravados.");
                }}>
                  <header><div><strong>Horário de Brasília</strong><p>Vazio publica o dia inteiro.</p></div></header>
                  <label>Dias<input name="days" placeholder="1,2,3,4,5" value={setting?.allowed_days || ""} onChange={(event) => { setConfigNote(""); setSetting({ ...setting, allowed_days: event.target.value }); }} /></label>
                  <div className="aff-clocks">
                    <label>Início<input name="start" type="time" value={minutesToClock(setting?.hour_start)} onChange={(event) => { setConfigNote(""); setSetting({ ...setting, hour_start: clockToMinutes(event.target.value) }); }} /></label>
                    <label>Fim<input name="end" type="time" value={minutesToClock(setting?.hour_end)} onChange={(event) => { setConfigNote(""); setSetting({ ...setting, hour_end: clockToMinutes(event.target.value) }); }} /></label>
                  </div>
                  {configNote ? <p className={configNote.endsWith("salvos.") ? "" : "aff-config-error"}>{configNote}</p> : null}
                  <button className="is-solid" type="submit">Salvar horários</button>
                </form>
              )}
              {configTab === "equipe" && (
                <div className="aff-prefs">
                  {session.user.role === "owner" ? (
                    <form className="sa-form" onSubmit={async (event) => {
                      event.preventDefault();
                      const form = new FormData(event.currentTarget);
                      await noted("Criado", "O usuário entrou na equipe.", async () => {
                        await api("/api/team", { method: "POST", body: JSON.stringify({ name: form.get("name"), email: form.get("email"), password: form.get("password"), role: form.get("role"), phone: form.get("phone") }) });
                        setTeam(await api("/api/team"));
                        event.currentTarget.reset();
                      });
                    }}>
                      <label>Nome<input name="name" required /></label>
                      <label>E-mail<input name="email" type="email" required /></label>
                      <label>Telefone<input name="phone" /></label>
                      <label>Senha<input name="password" type="password" minLength={6} required /></label>
                      <label>Papel<select name="role"><option value="member">Leitura</option><option value="manager">Gerente</option></select></label>
                      <button className="is-solid" type="submit">Adicionar</button>
                    </form>
                  ) : null}
                  <div className="sa-tablewrap">
                    <table className="sa-table">
                      <thead><tr><th>Nome</th><th>E-mail</th><th>Papel</th><th></th></tr></thead>
                      <tbody>
                        {team.users.map((user) => (
                          <tr key={user.id}>
                            <td>{user.name}</td>
                            <td>{user.email}</td>
                            <td>{user.role === "owner" ? "Dono" : user.role === "manager" ? "Gerente" : "Leitura"}</td>
                            <td>{session.user.role === "owner" && user.role !== "owner" ? <button type="button" onClick={() => noted("Removido", `${user.name} saiu da equipe.`, async () => { await api(`/api/team/${user.id}`, { method: "DELETE" }); setTeam(await api("/api/team")); })}>Remover</button> : "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div>
                    <strong>API do plano</strong>
                    {session.subscription?.features?.api ? <p className="sa-note">A chave aparece uma vez. Ela lê as ofertas desta empresa em /api/v1/offers.</p> : <p className="sa-note">Este plano não libera a API. O super admin marca isso no plano.</p>}
                    {freshKey ? <p><code>{freshKey}</code></p> : null}
                    {session.user.role === "owner" && session.subscription?.features?.api ? <button type="button" className="is-solid" onClick={() => noted("Criada", "Copie a chave agora. Ela não aparece de novo.", async () => { const data = await api<{ token: string }>("/api/keys", { method: "POST", body: JSON.stringify({ name: "Principal" }) }); setFreshKey(data.token); setTeam(await api("/api/team")); })}>Gerar chave</button> : null}
                    <ul>{team.keys.map((key) => <li key={key.id}>{key.name} · {key.token_prefix}… {key.last_used_at ? `usada ${new Date(key.last_used_at).toLocaleString("pt-BR")}` : "ainda não usada"}</li>)}</ul>
                  </div>
                </div>
              )}
              {configTab === "logs" && <pre className="aff-log">{setting?.last_error || "Nenhum erro na última rodada."}</pre>}
            </section>
          )}
        </div>
      </div>
      {createPortal(
        <div className="aff-toasts">
          {notices.map((item) => (
            <article key={item.id} className={`aff-toast${item.tone === "bad" ? " is-bad" : ""}`} role="status">
              <span className="aff-toast__mark" aria-hidden="true">{item.tone === "bad" ? <svg viewBox="0 0 24 24"><path d="M12 8v5" /><path d="M12 16h.01" /></svg> : <svg viewBox="0 0 24 24"><path d="M5 12.5l4.2 4.2L19 7.5" /></svg>}</span>
              <div><strong>{item.title}</strong><p>{item.text}</p></div>
              <button type="button" aria-label="Fechar aviso" onClick={() => setNotices((list) => list.filter((row) => row.id !== item.id))}>×</button>
            </article>
          ))}
        </div>,
        document.body
      )}
      {ask ? (
        <div className="aff-modal" role="dialog" aria-modal="true">
          <button type="button" className="aff-modal__backdrop" aria-label="Fechar" onClick={() => setAsk(null)} />
          <div className="aff-modal__card">
            <h2>{ask.title}</h2>
            <p>{ask.text}</p>
            <div className="aff-modal__actions">
              <button type="button" onClick={() => setAsk(null)}>Cancelar</button>
              <button type="button" className="is-solid" onClick={async () => {
                const job = ask;
                setAsk(null);
                try { await job.run(); } catch (err) { tell("Não concluiu", err instanceof Error ? err.message : "A ação não concluiu", "bad"); }
              }}>{ask.confirm}</button>
            </div>
          </div>
        </div>
      ) : null}
      {storeModal ? <StoreDialog store={storeModal} setting={setting} onClose={() => setStoreModal(null)} onNotice={tell} onSaved={async () => { await reload(); tell("Salvo", "A configuração da loja foi gravada."); }} /> : null}
    </div>
  );
}
