import { useEffect, useState } from "react";

export const go = (to: string, replace = false) => {
  const url = new URL(to, window.location.origin);
  const next = `${url.pathname}${url.search}`;
  const current = `${window.location.pathname}${window.location.search}`;
  if (current !== next) {
    if (replace) window.history.replaceState({}, "", next);
    else window.history.pushState({}, "", next);
  }
  window.dispatchEvent(new PopStateEvent("popstate"));
};

export const usePath = () => {
  const [path, setPath] = useState(() => window.location.pathname);
  useEffect(() => {
    const sync = () => setPath(window.location.pathname);
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);
  return path.replace(/\/+$/, "") || "/";
};

export const PANEL_PATH = {
  dash: "/home",
  stores: "/lojas",
  campaigns: "/campanhas",
  offers: "/ofertas",
  posts: "/publicacoes",
  groups: "/conexoes",
  contacts: "/contatos",
  links: "/links",
  analytics: "/analytics",
  auto: "/automacao",
  help: "/material",
  config: "/configuracoes"
} as const;

export const ADMIN_PATH = {
  dash: "/admin",
  companies: "/admin/empresas",
  plans: "/admin/planos",
  subscriptions: "/admin/assinaturas",
  payments: "/admin/pagamentos",
  whatsapp: "/admin/whatsapp",
  stores: "/admin/lojas",
  coupons: "/admin/cupons",
  partners: "/admin/parceiros",
  reports: "/admin/relatorios",
  logs: "/admin/logs",
  audit: "/admin/auditoria",
  quotes: "/admin/depoimentos",
  efi: "/admin/integracoes",
  settings: "/admin/configuracoes",
  profile: "/admin/perfil"
} as const;

export const isPublicPath = (path: string) => path === "/" || path === "/login" || path === "/cadastro";

export const isClientPath = (path: string) => (
  Object.values(PANEL_PATH).includes(path as (typeof PANEL_PATH)[keyof typeof PANEL_PATH])
  || path.startsWith("/configuracoes/")
  || path.startsWith("/conexoes/")
);

export const isAdminPath = (path: string) => path === "/admin" || Object.values(ADMIN_PATH).some((href) => href !== "/admin" && (path === href || path.startsWith(`${href}/`)));
