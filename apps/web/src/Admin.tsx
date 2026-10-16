import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { api } from "./api";
import type { Session } from "./App";
import { Mark } from "./Mark";
import { ADMIN_PATH, go, usePath } from "./route";
import "./admin.css";

const NAV = [
  ["dash", "Dashboard"],
  ["companies", "Empresas"],
  ["plans", "Planos"],
  ["subscriptions", "Assinaturas"],
  ["payments", "Pagamentos"],
  ["whatsapp", "WhatsApp"],
  ["stores", "Lojas"],
  ["coupons", "Cupons"],
  ["reports", "Relatórios"],
  ["logs", "Logs"],
  ["audit", "Auditoria"],
  ["quotes", "Depoimentos"],
  ["efi", "Integrações"],
  ["settings", "Configurações"],
  ["profile", "Perfil"]
] as const;

const SUBTITLE: Record<(typeof NAV)[number][0], string> = {
  dash: "Visão geral da operação.",
  companies: "Gerencie clientes e assinaturas.",
  plans: "Preços, limites e o que aparece na landing.",
  subscriptions: "Ciclo, valor e validade de cada cliente.",
  payments: "Faturas, métodos e o que ainda está em aberto.",
  whatsapp: "Conexões, QR e falhas em tempo real.",
  stores: "Credenciais de afiliado por marketplace.",
  coupons: "Descontos aplicados no checkout.",
  reports: "Crescimento, cancelamento e cliques.",
  logs: "Erros do robô e eventos de pagamento.",
  audit: "Quem fez o quê, em qual empresa.",
  quotes: "O que aparece na página inicial.",
  efi: "Cobrança PIX, cartão e boleto.",
  settings: "Teste, suspensão e e-mail de aviso.",
  profile: "Seus dados de acesso."
};

const FILTERS = [
  ["all", "Todos"],
  ["trial", "Trial"],
  ["active", "Ativas"],
  ["suspended", "Suspensas"],
  ["blocked", "Bloqueadas"],
  ["canceled", "Canceladas"]
] as const;

const STORES: Record<string, string> = {
  ml: "Mercado Livre", shopee: "Shopee", amazon: "Amazon", aliexpress: "AliExpress", awin: "Awin", rakuten: "Rakuten",
  epoca: "Época", magalu: "Magalu", shein: "Shein", terabyte: "Terabyte", samsung: "Samsung", casasbahia: "Casas Bahia",
  natura: "Natura", paguemenos: "Pague Menos"
};

const UFS = ["AC", "AL", "AM", "AP", "BA", "CE", "DF", "ES", "GO", "MA", "MG", "MS", "MT", "PA", "PB", "PE", "PI", "PR", "RJ", "RN", "RO", "RR", "RS", "SC", "SE", "SP", "TO"];

type View = (typeof NAV)[number][0];
type Filter = (typeof FILTERS)[number][0];
type Range = "7" | "30" | "90" | "12";

const labelOf = (value?: string | null) => ({
  trialing: "Teste", active: "Ativa", past_due: "Vencida", canceled: "Cancelada", suspended: "Suspensa", blocked: "Bloqueada",
  pending: "Pendente", paid: "Paga", monthly: "Mensal", quarterly: "Trimestral", semiannual: "Semestral", yearly: "Anual",
  pix: "PIX", card: "Cartão", boleto: "Boleto", open: "Aberto", sent: "Enviado", failed: "Falhou", read: "Lido", panel: "Painel", email: "E-mail",
  connected: "Conectado", qrcode: "QR pendente", opening: "Conectando", close: "Desconectado", disconnected: "Desconectado"
} as Record<string, string>)[String(value || "")] || (value || "—");

const money = (cents: number) => (Number(cents || 0) / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const num = (value: number) => Number(value || 0).toLocaleString("pt-BR");
const when = (iso?: string | null) => iso ? new Date(iso).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }) : "—";
const day = (iso?: string | null) => iso ? new Date(iso).toLocaleDateString("pt-BR") : "—";
const cap = (value: number | null | undefined, suffix: string) => value == null ? `${suffix} ilimitado` : `${value} ${suffix}`;
const reaisToCents = (raw: string) => {
  const text = raw.trim().replace(/\s/g, "");
  if (!text) return null;
  const value = Number(text.includes(",") ? text.replace(/\./g, "").replace(",", ".") : text);
  return Number.isFinite(value) ? Math.round(value * 100) : null;
};
const initials = (name?: string | null) => {
  const parts = String(name || "?").trim().split(/\s+/).slice(0, 2);
  return parts.map((part) => part[0]?.toUpperCase() || "").join("") || "?";
};
const toneOf = (status?: string | null) => {
  if (status === "paid" || status === "active" || status === "connected" || status === "sent" || status === "read") return "ok";
  if (status === "trialing" || status === "qrcode" || status === "pending" || status === "open" || status === "opening") return "trial";
  if (status === "suspended" || status === "past_due") return "wait";
  if (status === "blocked" || status === "failed" || status === "close" || status === "disconnected") return "bad";
  return "off";
};

const blankPlan = {
  id: 0, name: "", slug: "", description: "", benefits: "", monthly: "", quarterly: "", semiannual: "", yearly: "", trial: "7",
  connections: "", groups: "", stores: "", posts: "", postsMonth: "", users: "", sort: "0", api: false, priority: false, active: true
};

const ICONS: Record<View, string> = {
  dash: "M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-5v-6H10v6H5a1 1 0 0 1-1-1z",
  companies: "M4 20V6a1 1 0 0 1 1-1h6v15M11 20V9h8a1 1 0 0 1 1 1v10M4 20h16M7 9h2M7 13h2M14 13h2M14 17h2",
  plans: "M4 8h16v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1zM8 8V6a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2",
  subscriptions: "M3 8h18v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1zM3 11h18M7 15h4",
  payments: "M12 3v18M16 7H9.5a2.5 2.5 0 0 0 0 5H14a2.5 2.5 0 0 1 0 5H7",
  whatsapp: "M8 4h8a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM10 18h4",
  stores: "M4 9h16l-1 11H5L4 9zM8 9V7a4 4 0 0 1 8 0v2",
  coupons: "M4 8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-2a2 2 0 0 0 0-4zM12 8v8",
  reports: "M4 19V5M4 19h16M8 16v-5M12 16V8M16 16v-3",
  logs: "M7 4h7l5 5v11a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zM14 4v5h5M8 13h8M8 17h5",
  audit: "M8 11V8a4 4 0 0 1 8 0v3M6 11h12v9H6z",
  quotes: "M12 3l2.2 4.6L19 8.2l-3.5 3.4.8 4.9L12 14.8 7.7 16.5l.8-4.9L5 8.2l4.8-.6z",
  efi: "M8 8V6a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M5 8h14v11a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1zM12 12v4",
  settings: "M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM12 3v2M12 19v2M4.9 6.1l1.4 1.4M17.7 16.5l1.4 1.4M3 12h2M19 12h2M4.9 17.9l1.4-1.4M17.7 7.5l1.4-1.4",
  profile: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM5 20a7 7 0 0 1 14 0"
};

export function Admin({ session, onLogout, onEnter, onRefresh }: { session: Session; onLogout: () => void; onEnter: (token: string) => Promise<void>; onRefresh: () => Promise<void> }) {
  const path = usePath();
  const view: View = (Object.entries(ADMIN_PATH).sort((a, b) => b[1].length - a[1].length).find(([, href]) => path === href || path.startsWith(`${href}/`))?.[0] as View) || "dash";
  const setView = (id: View) => go(ADMIN_PATH[id]);
  const filter = (FILTERS.some(([key]) => key !== "all" && path === `/admin/empresas/${key}`) ? path.split("/")[3] : "all") as Filter;
  const setFilter = (key: Filter) => go(key === "all" ? "/admin/empresas" : `/admin/empresas/${key}`);
  const [menuOpen, setMenuOpen] = useState(false);
  const [dark, setDark] = useState(() => localStorage.getItem("achadinhos-admin-theme") === "dark");
  const [board, setBoard] = useState<any>(null);
  const [query, setQuery] = useState("");
  const [planFilter, setPlanFilter] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [city, setCity] = useState("");
  const [uf, setUf] = useState("");
  const [page, setPage] = useState(0);
  const [notices, setNotices] = useState<Array<{ id: number; tone: "ok" | "bad"; title: string; text: string }>>([]);
  const [ask, setAsk] = useState<null | { title: string; text: string; confirm: string; run: () => Promise<unknown> }>(null);
  const [detail, setDetail] = useState<any>(null);
  const [planOpen, setPlanOpen] = useState<typeof blankPlan | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [qr, setQr] = useState<{ name: string; image: string; status: string } | null>(null);
  const [efi, setEfi] = useState({ clientId: "", clientSecret: "", pixKey: "", webhookUrl: "", sandbox: true });
  const [rules, setRules] = useState({ trialDays: "7", blockAfterDays: "3", warn: ["7", "3", "1"] });
  const [finder, setFinder] = useState("");
  const [finderOn, setFinderOn] = useState(false);
  const [range, setRange] = useState<Range>("12");
  const [payStatus, setPayStatus] = useState("");
  const [payMethod, setPayMethod] = useState("");
  const [payPeriod, setPayPeriod] = useState("");
  const [logQuery, setLogQuery] = useState("");
  const [logKind, setLogKind] = useState("");
  const [openLog, setOpenLog] = useState<number | null>(null);
  const [auditQuery, setAuditQuery] = useState("");
  const [efiResult, setEfiResult] = useState<null | "ok" | "bad">(null);
  const finderRef = useRef<HTMLInputElement>(null);

  const tell = (title: string, text: string, tone: "ok" | "bad" = "ok") => {
    const id = Date.now() + Math.random();
    setNotices((list) => [...list, { id, tone, title, text }]);
    window.setTimeout(() => setNotices((list) => list.filter((item) => item.id !== id)), tone === "ok" ? 4200 : 8000);
  };

  const load = async () => {
    const data = await api<any>("/api/admin/console");
    setBoard(data);
    setEfi({
      clientId: data.platform.clientId || "",
      clientSecret: "",
      pixKey: data.platform.pixKey || "",
      webhookUrl: data.platform.webhookUrl || "",
      sandbox: data.platform.sandbox !== false
    });
    setRules({
      trialDays: String(data.platform.trialDays ?? 7),
      blockAfterDays: String(data.platform.blockAfterDays ?? 3),
      warn: String(data.platform.warnDays || "7,3,1").split(",").filter(Boolean)
    });
    setDetail((prev: any) => prev ? (data.companies || []).find((company: any) => company.id === prev.id) || null : prev);
    return data;
  };

  useEffect(() => { load().catch((err) => tell("Não carregou", err.message, "bad")); }, []);
  useEffect(() => { localStorage.setItem("achadinhos-admin-theme", dark ? "dark" : "light"); }, [dark]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const tag = (event.target as HTMLElement | null)?.tagName;
      if (event.key === "/" && tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT") {
        event.preventDefault();
        finderRef.current?.focus();
      }
      if (event.key === "Escape") {
        setDetail(null);
        setPlanOpen(null);
        setCreateOpen(false);
        setQr(null);
        setAsk(null);
        setMenuOpen(false);
        setFinderOn(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const run = async (title: string, text: string, job: () => Promise<unknown>) => {
    try {
      await job();
      await load();
      tell(title, text);
      return true;
    } catch (err) {
      tell("Não concluiu", err instanceof Error ? err.message : "A ação não concluiu", "bad");
      return false;
    }
  };

  const searched = useMemo(() => (board?.companies || []).filter((company: any) => {
    if (planFilter && company.plan_slug !== planFilter) return false;
    const created = new Date(company.created_at);
    if (from && created < new Date(`${from}T00:00:00`)) return false;
    if (to && created > new Date(`${to}T23:59:59`)) return false;
    if (uf && company.state !== uf) return false;
    if (city.trim() && !String(company.city || "").toLowerCase().includes(city.trim().toLowerCase())) return false;
    const hay = `${company.name} ${company.owner_name || ""} ${company.owner_email || ""}`.toLowerCase();
    return !query.trim() || hay.includes(query.trim().toLowerCase());
  }), [board, planFilter, from, to, query, city, uf]);

  const companies = useMemo(() => searched.filter((company: any) => {
    if (filter === "trial" && !(company.sub_status === "trialing" && company.status === "active")) return false;
    if (filter === "active" && !(company.status === "active" && company.sub_status === "active")) return false;
    if (filter === "suspended" && !(company.status === "suspended" && company.sub_status !== "canceled")) return false;
    if (filter === "blocked" && company.status !== "blocked") return false;
    if (filter === "canceled" && company.sub_status !== "canceled") return false;
    return true;
  }), [searched, filter]);

  const pageSize = 8;
  const pages = Math.max(1, Math.ceil(companies.length / pageSize));
  const visible = companies.slice(page * pageSize, page * pageSize + pageSize);
  useEffect(() => { setPage(0); }, [filter, planFilter, from, to, query, city, uf]);

  const openPlan = (plan?: any) => {
    if (!plan) return setPlanOpen({ ...blankPlan });
    const features = plan.features || {};
    setPlanOpen({
      id: plan.id,
      name: plan.name || "",
      slug: plan.slug || "",
      description: plan.description || "",
      benefits: plan.benefits || "",
      monthly: plan.monthly_cents ? String(plan.monthly_cents / 100) : "",
      quarterly: plan.quarterly_cents ? String(plan.quarterly_cents / 100) : "",
      semiannual: plan.semiannual_cents ? String(plan.semiannual_cents / 100) : "",
      yearly: plan.yearly_cents ? String(plan.yearly_cents / 100) : "",
      trial: String(plan.trial_days ?? 7),
      connections: plan.max_connections ?? "",
      groups: plan.max_groups ?? "",
      stores: plan.max_stores ?? "",
      posts: plan.max_posts_per_day ?? "",
      postsMonth: plan.max_posts_per_month ?? "",
      users: plan.max_users ?? "",
      sort: String(plan.sort_order || 0),
      api: Boolean(features.api),
      priority: Boolean(features.prioritySupport),
      active: plan.active !== false
    });
  };

  const savePlan = async () => {
    if (!planOpen) return;
    const empty = (value: string) => value === "" ? null : Number(value);
    const body = {
      name: planOpen.name,
      slug: planOpen.slug,
      description: planOpen.description,
      benefits: planOpen.benefits,
      monthlyCents: reaisToCents(planOpen.monthly) || 0,
      quarterlyCents: reaisToCents(planOpen.quarterly),
      semiannualCents: reaisToCents(planOpen.semiannual),
      yearlyCents: reaisToCents(planOpen.yearly) || 0,
      trialDays: Number(planOpen.trial || 7),
      maxConnections: empty(String(planOpen.connections)),
      maxGroups: empty(String(planOpen.groups)),
      maxStores: null,
      maxPostsPerDay: null,
      maxPostsPerMonth: null,
      maxUsers: empty(String(planOpen.users)),
      sortOrder: 0,
      api: planOpen.api,
      prioritySupport: planOpen.priority,
      active: planOpen.active
    };
    const ok = await run(planOpen.id ? "Salvo" : "Criado", planOpen.id ? "O plano foi atualizado." : "O plano foi criado.", () =>
      api(planOpen.id ? `/api/admin/plans/${planOpen.id}` : "/api/admin/plans", { method: planOpen.id ? "PATCH" : "POST", body: JSON.stringify(body) })
    );
    if (ok) setPlanOpen(null);
  };

  const act = (company: any, action: string) => {
    const id = company.id;
    if (action === "view") return setDetail(company);
    if (action === "enter") {
      api<{ token: string }>(`/api/admin/companies/${id}/enter`, { method: "POST" })
        .then((data) => onEnter(data.token))
        .catch((err) => tell("Não concluiu", err instanceof Error ? err.message : "A ação não concluiu", "bad"));
      return;
    }
    const jobs: Record<string, { title: string; text: string; confirm: string; done: string; run: () => Promise<unknown> }> = {
      renew: { title: "Renovar", text: `Renovar ${company.name} por 30 dias? Isso não gera cobrança na EFI.`, confirm: "Renovar", done: `${company.name} foi renovada por 30 dias.`, run: () => api(`/api/admin/companies/${id}/renew`, { method: "POST", body: JSON.stringify({ days: 30 }) }) },
      suspend: { title: "Suspender", text: `Suspender ${company.name}? O robô para de publicar.`, confirm: "Suspender", done: `${company.name} foi suspensa.`, run: () => api(`/api/admin/companies/${id}`, { method: "PATCH", body: JSON.stringify({ status: "suspended" }) }) },
      block: { title: "Bloquear", text: `Bloquear ${company.name}? O login dessa empresa passa a ser recusado.`, confirm: "Bloquear", done: `${company.name} foi bloqueada.`, run: () => api(`/api/admin/companies/${id}`, { method: "PATCH", body: JSON.stringify({ status: "blocked" }) }) },
      cancel: { title: "Cancelar", text: `Cancelar a assinatura de ${company.name}? A empresa fica suspensa.`, confirm: "Cancelar assinatura", done: `A assinatura de ${company.name} foi cancelada.`, run: () => api(`/api/admin/companies/${id}/cancel`, { method: "POST" }) },
      delete: { title: "Excluir empresa", text: `Excluir ${company.name}? Os dados dessa empresa saem juntos.`, confirm: "Excluir", done: `${company.name} foi excluída.`, run: () => api(`/api/admin/companies/${id}`, { method: "DELETE" }) }
    };
    const job = jobs[action];
    if (!job) return;
    setAsk({ title: job.title, text: job.text, confirm: job.confirm, run: async () => { await run("Feito", job.done, job.run); } });
  };

  const metrics = board?.metrics || {};
  const months = board?.months || [];
  const prevRevenue = months.length > 1 ? Number(months[months.length - 2].revenue) || 0 : 0;
  const monthRevenue = Number(metrics.revenue_month) || 0;
  const revenueDelta = prevRevenue > 0 ? Math.round(((monthRevenue - prevRevenue) / prevRevenue) * 100) : null;
  const newClients = months.length ? Number(months[months.length - 1].clients) || 0 : 0;
  const paid = Number(metrics.paid_companies || 0);
  const total = Number(metrics.companies || 0);
  const conversion = total ? Math.round((paid / total) * 100) : 0;
  const dueSoon = (board?.due || []).filter((item: any) => new Date(item.ends_at).getTime() - Date.now() <= 3 * 86400000);
  const waRows = board?.whatsapp || [];
  const waOff = waRows.filter((row: any) => row.status !== "connected" && row.status !== "qrcode");
  const invoices = board?.invoices || [];
  const pendingInvoices = invoices.filter((row: any) => row.status !== "paid");
  const companyCount = (board?.companies || []).length;
  const pendingCount = pendingInvoices.length;
  const logCount = (board?.logs || []).length;
  const found = (board?.companies || []).filter((company: any) => {
    const hay = `${company.name} ${company.owner_name || ""} ${company.owner_email || ""}`.toLowerCase();
    return finder.trim() && hay.includes(finder.trim().toLowerCase());
  }).slice(0, 6);
  const counts: Partial<Record<View, number>> = { companies: companyCount, payments: pendingCount, logs: logCount };

  const mrr = useMemo(() => {
    const names = new Set(searched.filter((company: any) => company.sub_status === "active").map((company: any) => company.name));
    return (board?.subscriptions || []).reduce((sum: number, row: any) => {
      if (row.status !== "active" || !names.has(row.company) || row.amount_cents == null) return sum;
      const split = row.cycle === "yearly" ? 12 : row.cycle === "semiannual" ? 6 : row.cycle === "quarterly" ? 3 : 1;
      return sum + row.amount_cents / split;
    }, 0);
  }, [board, searched]);

  const trialCount = searched.filter((company: any) => company.sub_status === "trialing" && company.status === "active").length;
  const payingCount = searched.filter((company: any) => company.status === "active" && company.sub_status === "active").length;
  const suspendedCount = searched.filter((company: any) => company.status === "suspended" && company.sub_status !== "canceled").length;

  const payRows = invoices.filter((row: any) => {
    if (payStatus && row.status !== payStatus) return false;
    if (payMethod && row.method !== payMethod) return false;
    const stamp = new Date(row.created_at);
    const now = new Date();
    if (payPeriod === "today" && stamp.toDateString() !== now.toDateString()) return false;
    if (payPeriod === "month" && (stamp.getMonth() !== now.getMonth() || stamp.getFullYear() !== now.getFullYear())) return false;
    if (payPeriod === "year" && stamp.getFullYear() !== now.getFullYear()) return false;
    return true;
  });
  const revenueToday = invoices.filter((row: any) => row.status === "paid" && row.paid_at && new Date(row.paid_at).toDateString() === new Date().toDateString())
    .reduce((sum: number, row: any) => sum + Number(row.amount_cents || 0), 0);

  const daySlice = (board?.days || []).slice(range === "7" ? -7 : -14);
  const monthSlice = (board?.months || []).slice(range === "12" ? -12 : range === "90" ? -3 : -1);

  const activePlans = (board?.plans || []).filter((plan: any) => plan.active !== false);
  const popularId = (() => {
    if (activePlans.length < 2) return null;
    const flagged = activePlans.find((plan: any) => plan.features?.prioritySupport);
    if (flagged) return flagged.id;
    const sorts = activePlans.map((plan: any) => Number(plan.sort_order) || 0);
    if (new Set(sorts).size < 2) return null;
    return activePlans.reduce((best: any, plan: any) => (Number(plan.sort_order) || 0) >= (Number(best.sort_order) || 0) ? plan : best).id;
  })();

  const coupons = board?.coupons || [];
  const couponActive = coupons.filter((coupon: any) => (!coupon.expires_at || new Date(coupon.expires_at) > new Date()) && (!coupon.max_uses || coupon.used_count < coupon.max_uses)).length;
  const couponUses = coupons.reduce((sum: number, coupon: any) => sum + Number(coupon.used_count || 0), 0);
  const couponExpired = coupons.filter((coupon: any) => coupon.expires_at && new Date(coupon.expires_at) <= new Date()).length;

  const logs = (board?.logs || []).filter((row: any) => {
    if (logKind && row.kind !== logKind) return false;
    const hay = `${row.kind} ${row.company || ""} ${row.message || ""}`.toLowerCase();
    return !logQuery.trim() || hay.includes(logQuery.trim().toLowerCase());
  });
  const auditRows = (board?.audit || []).filter((row: any) => {
    const hay = `${row.actor || ""} ${row.actor_email || ""} ${row.company || ""} ${row.action || ""} ${row.summary || ""} ${row.ip || ""}`.toLowerCase();
    return !auditQuery.trim() || hay.includes(auditQuery.trim().toLowerCase());
  });

  const openFinder = (company: any) => {
    setFinder("");
    setFinderOn(false);
    setDetail(company);
  };

  const chartInk = dark ? "#94a3b8" : "#64748b";
  const chartGrid = dark ? "#1e293b" : "#e2e8f0";
  const tipStyle = { background: dark ? "#0f172a" : "#fff", border: `1px solid ${chartGrid}`, borderRadius: 12, fontSize: 12, color: dark ? "#f8fafc" : "#020617" };

  return (
    <div className={`sx-shell${menuOpen ? " is-nav" : ""}${dark ? " is-dark" : ""}`}>
      <button type="button" className="sx-backdrop" aria-label="Fechar menu" onClick={() => setMenuOpen(false)} />
      <aside className="sx-side">
        <div className="sx-brand">
          <Mark className="sx-mark" />
          <div><b>Achadinhos</b><small>SUPER ADMIN</small></div>
        </div>
        <nav className="sx-nav">
          {NAV.map(([id, label]) => (
            <button key={id} type="button" className={view === id ? "is-on" : ""} aria-current={view === id ? "page" : undefined} onClick={() => { setView(id); setMenuOpen(false); }}>
              <Icon d={ICONS[id]} />
              <span>{label}</span>
              {board && counts[id] != null ? <em className="sx-count">{num(counts[id] || 0)}</em> : null}
            </button>
          ))}
        </nav>
        <div className="sx-side__foot">
          <div className="sx-me">
            <span className="sx-avatar">{initials(session.user.name)}</span>
            <div><strong>{session.user.name}</strong><span>{session.user.email}</span></div>
          </div>
          <button type="button" className="sx-logout" onClick={onLogout}>Sair da conta</button>
        </div>
      </aside>
      <div className="sx-main">
        <header className="sx-top">
          <button type="button" className="sx-menu" aria-label="Abrir menu" onClick={() => setMenuOpen(true)}><Icon d="M4 7h16M4 12h16M4 17h16" /></button>
          <div className="sx-top__title"><strong>{NAV.find((item) => item[0] === view)?.[1]}</strong><span>{SUBTITLE[view]}</span></div>
          <div className="sx-search">
            <Icon d="M11 19a8 8 0 1 1 0-16 8 8 0 0 1 0 16zM21 21l-4.3-4.3" />
            <input ref={finderRef} value={finder} placeholder="Buscar empresa, responsável ou e-mail" aria-label="Pesquisa global" onFocus={() => setFinderOn(true)} onBlur={() => window.setTimeout(() => setFinderOn(false), 120)} onChange={(event) => { setFinder(event.target.value); setFinderOn(true); }} />
            {finderOn && finder.trim() ? (
              <ul className="sx-search__list">
                {found.length ? found.map((company: any) => (
                  <li key={company.id}><button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => openFinder(company)}><span>{company.name}<small> {company.owner_email || "sem dono"}</small></span><StatusBadge company={company} /></button></li>
                )) : <li><button type="button" disabled>Nenhuma empresa</button></li>}
              </ul>
            ) : null}
          </div>
          <div className="sx-top__actions">
            <button type="button" className="sx-iconbtn" aria-label={dark ? "Tema claro" : "Tema escuro"} onClick={() => setDark((value) => !value)}>
              <Icon d={dark ? "M12 3v2M12 19v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M3 12h2M19 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z" : "M21 14.5A8.5 8.5 0 0 1 9.5 3 7 7 0 1 0 21 14.5z"} />
            </button>
            <button type="button" className="sx-iconbtn" onClick={() => load().then(() => tell("Atualizado", "Os números foram recarregados.")).catch((err) => tell("Não carregou", err.message, "bad"))}><Icon d="M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5" /><span>Atualizar</span></button>
            <button type="button" className="sx-avatarbtn" aria-label="Abrir perfil" onClick={() => setView("profile")}><span className="sx-avatar">{initials(session.user.name)}</span></button>
          </div>
        </header>
        <div className="sx-body">
          {!board ? <Skeleton /> : null}

          {board && view === "dash" ? (
            <>
              <section className="sx-alerts">
                {dueSoon.length ? <button type="button" className="sx-alert is-bad" onClick={() => setView("companies")}><span><b>{num(dueSoon.length)} {dueSoon.length === 1 ? "empresa vence" : "empresas vencem"} em 3 dias</b><small>Abra a base e confira a validade</small></span></button> : null}
                {waOff.length ? <button type="button" className="sx-alert is-warn" onClick={() => setView("whatsapp")}><span><b>{num(waOff.length)} {waOff.length === 1 ? "WhatsApp desconectado" : "WhatsApps desconectados"}</b><small>Conexões fora do ar ou com falha</small></span></button> : null}
                {pendingCount ? <button type="button" className="sx-alert is-money" onClick={() => { setPayStatus("pending"); setView("payments"); }}><span><b>{num(pendingCount)} {pendingCount === 1 ? "pagamento pendente" : "pagamentos pendentes"}</b><small>Faturas ainda não confirmadas</small></span></button> : null}
                {revenueDelta != null ? <button type="button" className="sx-alert is-info" onClick={() => setView("reports")}><span><b>Receita {revenueDelta >= 0 ? "cresceu" : "caiu"} {Math.abs(revenueDelta)}% no mês</b><small>Contra o mês anterior, só fatura paga</small></span></button> : null}
                {!dueSoon.length && !waOff.length && !pendingCount && revenueDelta == null ? <article className="sx-alert is-info"><span><b>Nada urgente agora</b><small>Nenhuma empresa vence em 3 dias e não há pagamento pendente nesta carga</small></span></article> : null}
              </section>
              <section className="sx-kpis">
                <article className="sx-kpi"><span>Empresas</span><strong>{num(total)}</strong><em className="sx-delta is-up">+{num(newClients)} este mês</em><Spark rows={months} field="clients" dark={dark} /></article>
                <article className="sx-kpi"><span>Receita do mês</span><strong>{money(monthRevenue)}</strong><em className={revenueDelta != null && revenueDelta < 0 ? "sx-delta is-down" : "sx-delta is-up"}>{revenueDelta == null ? "sem mês anterior" : `${revenueDelta >= 0 ? "+" : ""}${revenueDelta}%`}</em><Spark rows={months} field="revenue" dark={dark} moneyMode /></article>
                <article className="sx-kpi"><span>Assinaturas ativas</span><strong>{num(metrics.active_paid || 0)}</strong><em>empresas pagas e ativas</em></article>
                <article className="sx-kpi"><span>WhatsApps conectados</span><strong>{num(metrics.whatsapps || 0)}</strong><em>{num(metrics.groups || 0)} grupos no total</em></article>
              </section>
              <section className="sx-stats">
                <article className="sx-stat is-trial"><span>Trial</span><strong>{num(metrics.trialing || 0)}</strong></article>
                <article className="sx-stat is-active"><span>Ativas</span><strong>{num(metrics.active_paid || 0)}</strong></article>
                <article className="sx-stat is-suspended"><span>Suspensas</span><strong>{num(metrics.suspended || 0)}</strong></article>
                <article className="sx-stat is-blocked"><span>Bloqueadas</span><strong>{num(metrics.blocked || 0)}</strong></article>
                <article className="sx-stat is-canceled"><span>Canceladas</span><strong>{num(metrics.canceled || 0)}</strong></article>
              </section>
              <section className="sx-split">
                <article className="sx-card"><span>Conversão teste → pago</span><strong style={{ fontSize: 36, letterSpacing: "-0.05em" }}>{total ? `${conversion}%` : "—"}</strong><p className="sx-note">{paid} de {total} empresas com pelo menos uma fatura paga</p></article>
                <article className="sx-card">
                  <span>Empresas vencendo</span>
                  <strong style={{ fontSize: 28 }}>{num(board.due?.length || 0)}</strong>
                  <ul className="sx-due">{(board.due || []).slice(0, 4).map((item: any) => <li key={item.id}><b>{item.name}</b><small>{day(item.ends_at)}</small></li>)}</ul>
                  {!board.due?.length ? <p className="sx-note">Ninguém nos próximos 7 dias.</p> : null}
                </article>
                <article className="sx-card"><span>Cancelamentos</span><strong style={{ fontSize: 36, letterSpacing: "-0.05em" }}>{num(metrics.canceled || 0)}</strong><p className="sx-note">assinaturas com status cancelado</p><p className="sx-note">{num((metrics.trial_expired || 0) + (metrics.period_expired || 0))} vencidas agora</p></article>
              </section>
              <section className="sx-grid2">
                <article className="sx-card"><div className="sx-card__head"><h2>Publicações nos últimos 14 dias</h2></div><Trend rows={board.days || []} field="posts" dark={dark} ink={chartInk} grid={chartGrid} tip={tipStyle} /></article>
                <article className="sx-card"><div className="sx-card__head"><h2>Receita paga nos últimos 12 meses</h2></div><Trend rows={board.months || []} field="revenue" moneyMode dark={dark} ink={chartInk} grid={chartGrid} tip={tipStyle} /></article>
              </section>
              <article className="sx-card">
                <div className="sx-card__head"><div><h2>Últimos pagamentos</h2><p>As faturas mais recentes da plataforma.</p></div><button type="button" className="sx-btn" onClick={() => setView("payments")}>Ver todos</button></div>
                <PayTable rows={invoices.slice(0, 6)} />
              </article>
            </>
          ) : null}

          {board && view === "companies" ? (
            <>
              <div className="sx-toolbar">
                <div className="sx-tabs">
                  {FILTERS.map(([key, name]) => <button key={key} type="button" className={filter === key ? "is-on" : ""} onClick={() => setFilter(key)}>{name}</button>)}
                </div>
                <button type="button" className="sx-btn is-solid" onClick={() => setCreateOpen(true)}>+ Nova empresa</button>
              </div>
              <section className="sx-stats">
                <article className="sx-stat"><span>Total</span><strong>{num(searched.length)}</strong></article>
                <article className="sx-stat is-trial"><span>Trial</span><strong>{num(trialCount)}</strong></article>
                <article className="sx-stat is-active"><span>Pagantes</span><strong>{num(payingCount)}</strong></article>
                <article className="sx-stat is-suspended"><span>Suspensas</span><strong>{num(suspendedCount)}</strong></article>
                <article className="sx-stat"><span>MRR</span><strong>{money(mrr)}</strong></article>
              </section>
              <div className="sx-filters">
                <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Nome, responsável ou e-mail" aria-label="Buscar na tabela" />
                <select value={planFilter} onChange={(event) => setPlanFilter(event.target.value)} aria-label="Plano"><option value="">Todos os planos</option>{(board.plans || []).map((plan: any) => <option key={plan.id} value={plan.slug}>{plan.name}</option>)}</select>
                <input value={city} onChange={(event) => setCity(event.target.value)} placeholder="Cidade" aria-label="Cidade" />
                <select value={uf} onChange={(event) => setUf(event.target.value)} aria-label="Estado"><option value="">Estado</option>{UFS.map((item) => <option key={item}>{item}</option>)}</select>
                <input type="date" value={from} onChange={(event) => setFrom(event.target.value)} aria-label="Cadastro a partir de" />
                <input type="date" value={to} onChange={(event) => setTo(event.target.value)} aria-label="Cadastro até" />
              </div>
              <div className="sx-tablewrap">
                <table className="sx-table">
                  <thead><tr><th>Empresa</th><th>Responsável</th><th>Plano</th><th>Status</th><th>Receita</th><th>Validade</th><th>Último acesso</th></tr></thead>
                  <tbody>
                    {visible.map((company: any) => (
                      <tr key={company.id}>
                        <td><button type="button" className="sx-rowbtn" onClick={() => setDetail(company)}><span className="sx-avatar">{initials(company.name)}</span><span><strong>{company.name}</strong><small>{company.city ? `${company.city}/${company.state}` : "cidade não informada"}</small></span></button></td>
                        <td>{company.owner_name || "sem dono"}<small>{company.owner_email || "—"}</small></td>
                        <td>{company.plan_name || "—"}</td>
                        <td><StatusBadge company={company} /></td>
                        <td>{money(company.revenue_cents)}</td>
                        <td>{day(company.current_period_end || company.trial_ends_at)}</td>
                        <td>{when(company.last_login_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!visible.length ? <Empty title="Nenhuma empresa neste filtro" text="Troque a aba ou limpe a busca para ver o restante da base." /> : null}
              </div>
              <div className="sx-pager"><span>{companies.length ? `${page * pageSize + 1}–${Math.min(companies.length, (page + 1) * pageSize)} de ${companies.length}` : "0"}</span><span><button type="button" className="sx-btn" disabled={page <= 0} onClick={() => setPage((value) => value - 1)}>Anterior</button> <button type="button" className="sx-btn" disabled={page + 1 >= pages} onClick={() => setPage((value) => value + 1)}>Próxima</button></span></div>
            </>
          ) : null}

          {board && view === "plans" ? (
            <>
              <div className="sx-toolbar"><div><h2 style={{ margin: 0 }}>Planos publicados</h2><p className="sx-note">Nome, preço e benefícios. Limite vazio não trava. Toda empresa usa todas as lojas.</p></div><button type="button" className="sx-btn is-solid" onClick={() => openPlan()}>Novo plano</button></div>
              <div className="sx-plans">
                {(board.plans || []).map((plan: any) => {
                  const lines = String(plan.benefits || "").split("\n").map((line: string) => line.trim()).filter(Boolean);
                  return (
                    <article key={plan.id} className={`sx-plan${plan.id === popularId ? " is-pop" : ""}`}>
                      <header>
                        <strong>{plan.name}</strong>
                        <span style={{ display: "flex", gap: 6 }}>
                          {plan.id === popularId ? <span className="sx-badge is-pop">POPULAR</span> : null}
                          <span className={`sx-badge${plan.active ? " is-ok" : " is-off"}`}>{plan.active ? "Ativo" : "Inativo"}</span>
                        </span>
                      </header>
                      <b>{money(plan.monthly_cents)}<small> /mês</small></b>
                      <p className="sx-note">{plan.description || `${plan.trial_days} dias de teste`}</p>
                      <ul>{(lines.length ? lines : [`${plan.trial_days} dias de teste`]).map((line: string) => <li key={line}>{line}</li>)}</ul>
                      <div className="sx-limits">
                        <span>{cap(plan.max_connections, "WhatsApps")}</span>
                        <span>{cap(plan.max_groups, "grupos")}</span>
                        <span>{cap(plan.max_users, "usuários")}</span>
                      </div>
                      <div className="sx-actions">
                        <button type="button" className="sx-btn" onClick={() => openPlan(plan)}>Editar</button>
                        <button type="button" className="sx-btn is-danger" onClick={() => setAsk({
                          title: "Excluir plano",
                          text: `Excluir ${plan.name}? Empresas que já usam esse plano precisam mudar de plano antes.`,
                          confirm: "Excluir",
                          run: async () => { await run("Excluído", `${plan.name} foi excluído.`, () => api(`/api/admin/plans/${plan.id}`, { method: "DELETE" })); }
                        })}>Excluir</button>
                      </div>
                    </article>
                  );
                })}
              </div>
              {!(board.plans || []).length ? <Empty title="Nenhum plano cadastrado" text="Crie o nome, o preço e os benefícios. A landing só mostra plano ativo." /> : null}
            </>
          ) : null}

          {board && view === "subscriptions" ? <DataTable title="Assinaturas" note="Cada linha é a assinatura atual da empresa." columns={["Empresa", "Plano", "Status", "Ciclo", "Valor", "Início", "Fim do teste", "Próximo fim"]} rows={(board.subscriptions || []).map((row: any) => [row.company, row.plan, <Badge key={row.id} tone={toneOf(row.status)}>{labelOf(row.status)}</Badge>, labelOf(row.cycle), row.amount_cents == null ? "—" : money(row.amount_cents), day(row.created_at), day(row.trial_ends_at), day(row.current_period_end)])} /> : null}

          {board && view === "payments" ? (
            <>
              <section className="sx-kpis">
                <article className="sx-kpi"><span>Receita hoje</span><strong>{money(revenueToday)}</strong><em>faturas pagas carregadas</em></article>
                <article className="sx-kpi"><span>Receita do mês</span><strong>{money(metrics.revenue_month || 0)}</strong></article>
                <article className="sx-kpi"><span>Receita do ano</span><strong>{money(metrics.revenue_year || 0)}</strong></article>
                <article className="sx-kpi"><span>Faturas pendentes</span><strong>{num(pendingCount)}</strong><em>{money(pendingInvoices.reduce((sum: number, row: any) => sum + Number(row.amount_cents || 0), 0))}</em></article>
              </section>
              <div className="sx-filters">
                <select value={payStatus} onChange={(event) => setPayStatus(event.target.value)} aria-label="Status"><option value="">Todos os status</option><option value="paid">Paga</option><option value="pending">Pendente</option></select>
                <select value={payMethod} onChange={(event) => setPayMethod(event.target.value)} aria-label="Método"><option value="">Todos os métodos</option><option value="pix">PIX</option><option value="card">Cartão</option><option value="boleto">Boleto</option></select>
                <select value={payPeriod} onChange={(event) => setPayPeriod(event.target.value)} aria-label="Período"><option value="">Todo o período</option><option value="today">Hoje</option><option value="month">Este mês</option><option value="year">Este ano</option></select>
              </div>
              <PayTable rows={payRows} />
            </>
          ) : null}

          {board && view === "whatsapp" ? (
            <>
              <section className="sx-stats">
                <article className="sx-stat is-active"><span>Conectados</span><strong>{num(waRows.filter((row: any) => row.status === "connected").length)}</strong></article>
                <article className="sx-stat is-suspended"><span>QR pendente</span><strong>{num(waRows.filter((row: any) => row.status === "qrcode").length)}</strong></article>
                <article className="sx-stat is-blocked"><span>Desconectados</span><strong>{num(waOff.length)}</strong></article>
                <article className="sx-stat is-canceled"><span>Erros</span><strong>{num(waRows.filter((row: any) => row.last_error).length)}</strong></article>
              </section>
              <div className="sx-tablewrap">
                <table className="sx-table">
                  <thead><tr><th>Empresa</th><th>Conexão</th><th>Número</th><th>Status</th><th>Publicações</th><th>Último erro</th><th></th></tr></thead>
                  <tbody>
                    {waRows.map((row: any) => (
                      <tr key={row.id}>
                        <td>{row.company}</td>
                        <td>{row.name}</td>
                        <td>{row.phone || "—"}</td>
                        <td><WaStatus status={row.status} error={row.last_error} /></td>
                        <td>{num(row.posts)}</td>
                        <td>{row.last_error || "—"}</td>
                        <td>{row.has_qr ? <button type="button" className="sx-btn" onClick={async () => { const data = await api<{ qr: string; status: string; name: string }>(`/api/admin/whatsapp/${row.id}`); setQr({ name: data.name, image: data.qr, status: data.status }); }}>Ver QR</button> : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!waRows.length ? <Empty title="Nenhuma conexão criada" text="Quando uma empresa gerar um WhatsApp, ele aparece aqui." /> : null}
              </div>
            </>
          ) : null}

          {board && view === "stores" ? (
            <div className="sx-stores">
              {(board.stores || []).map((row: any) => (
                <article key={row.marketplace} className="sx-store">
                  <i>{initials(STORES[row.marketplace] || row.marketplace)}</i>
                  <strong>{STORES[row.marketplace] || row.marketplace}</strong>
                  <b>{num(row.enabled)}</b>
                  <small>{num(row.total)} registros · {row.enabled > 0 ? "ativa" : "sem credencial"}</small>
                </article>
              ))}
              {!(board.stores || []).length ? <Empty title="Nenhuma loja cadastrada" text="As credenciais de afiliado das empresas aparecem agrupadas por marketplace." /> : null}
            </div>
          ) : null}

          {board && view === "coupons" ? (
            <>
              <section className="sx-stats">
                <article className="sx-stat is-active"><span>Cupons ativos</span><strong>{num(couponActive)}</strong></article>
                <article className="sx-stat is-trial"><span>Usos</span><strong>{num(couponUses)}</strong></article>
                <article className="sx-stat is-canceled"><span>Expirados</span><strong>{num(couponExpired)}</strong></article>
              </section>
              <article className="sx-card">
                <div className="sx-card__head"><h2>Novo cupom</h2></div>
                <form className="sx-form" onSubmit={async (event) => {
                  event.preventDefault();
                  const form = new FormData(event.currentTarget);
                  const kind = String(form.get("kind"));
                  const ok = await run("Criado", "O cupom foi gravado.", () => api("/api/admin/coupons", { method: "POST", body: JSON.stringify({
                    code: form.get("code"), kind, percent: form.get("percent"), amountCents: reaisToCents(String(form.get("amount") || "")), planSlug: form.get("plan"), maxUses: form.get("uses"), expiresAt: form.get("expires") || null
                  }) }));
                  if (ok) event.currentTarget.reset();
                }}>
                  <label>Código<input name="code" required placeholder="BEMVINDO10" /></label>
                  <label>Tipo<select name="kind"><option value="percent">Percentual</option><option value="amount">Valor</option></select></label>
                  <label>Percentual<input name="percent" inputMode="numeric" placeholder="10" /></label>
                  <label>Valor (R$)<input name="amount" placeholder="20,00" /></label>
                  <label>Plano<select name="plan"><option value="">Todos</option>{(board.plans || []).map((plan: any) => <option key={plan.id} value={plan.slug}>{plan.name}</option>)}</select></label>
                  <label>Limite de uso<input name="uses" inputMode="numeric" placeholder="Ilimitado" /></label>
                  <label>Validade<input name="expires" type="date" /></label>
                  <div><button className="sx-btn is-solid" type="submit">Salvar cupom</button></div>
                </form>
              </article>
              <div className="sx-tablewrap">
                <table className="sx-table">
                  <thead><tr><th>Código</th><th>Tipo</th><th>Desconto</th><th>Plano</th><th>Usos</th><th>Validade</th><th></th></tr></thead>
                  <tbody>{coupons.map((coupon: any) => (
                    <tr key={coupon.id}>
                      <td><span className="sx-code">{coupon.code}</span></td>
                      <td>{coupon.kind === "amount" ? "Valor" : "Percentual"}</td>
                      <td>{coupon.kind === "amount" ? money(coupon.amount_cents) : `${coupon.percent}%`}</td>
                      <td>{coupon.plan_slug || "todos"}</td>
                      <td>{coupon.used_count}{coupon.max_uses ? ` / ${coupon.max_uses}` : ""}</td>
                      <td>{coupon.expires_at ? day(coupon.expires_at) : "sem validade"}</td>
                      <td><button type="button" className="sx-btn is-danger" onClick={() => setAsk({ title: "Remover cupom", text: `Remover ${coupon.code}?`, confirm: "Remover", run: () => run("Removido", "O cupom saiu.", () => api(`/api/admin/coupons/${coupon.id}`, { method: "DELETE" })) })}>Remover</button></td>
                    </tr>
                  ))}</tbody>
                </table>
                {!coupons.length ? <Empty title="Nenhum cupom" text="Crie um código percentual ou em reais para o checkout." /> : null}
              </div>
            </>
          ) : null}

          {board && view === "reports" ? (
            <>
              <div className="sx-toolbar">
                <p className="sx-note">Publicações e cliques usam a janela diária já calculada (até 14 dias). Clientes, cancelamentos e a receita mensal usam os últimos {range === "12" ? "12 meses" : range === "90" ? "3 meses" : "1 mês"}.</p>
                <div className="sx-tabs">
                  {([["7", "7 dias"], ["30", "30 dias"], ["90", "90 dias"], ["12", "12 meses"]] as Array<[Range, string]>).map(([key, name]) => (
                    <button key={key} type="button" className={range === key ? "is-on" : ""} onClick={() => setRange(key)}>{name}</button>
                  ))}
                </div>
              </div>
              <article className="sx-card"><div className="sx-card__head"><h2>Novos clientes</h2></div><Trend rows={monthSlice} field="clients" dark={dark} ink={chartInk} grid={chartGrid} tip={tipStyle} bars /></article>
              <article className="sx-card"><div className="sx-card__head"><h2>Cancelamentos</h2></div><Trend rows={monthSlice} field="canceled" dark={dark} ink={chartInk} grid={chartGrid} tip={tipStyle} bars color="#ef4444" /></article>
              <article className="sx-card"><div className="sx-card__head"><h2>Cliques</h2><span>{range === "7" ? "7 dias" : "14 dias disponíveis"}</span></div><Trend rows={daySlice} field="clicks" dark={dark} ink={chartInk} grid={chartGrid} tip={tipStyle} color="#10b981" /></article>
            </>
          ) : null}

          {board && view === "logs" ? (
            <>
              <div className="sx-filters">
                <input value={logQuery} onChange={(event) => setLogQuery(event.target.value)} placeholder="Buscar mensagem ou empresa" aria-label="Buscar logs" />
                <select value={logKind} onChange={(event) => setLogKind(event.target.value)} aria-label="Tipo de log"><option value="">Todos</option><option value="publicação">Erro</option><option value="pagamento">Pagamento</option></select>
              </div>
              <div className="sx-logs">
                {logs.map((row: any, index: number) => {
                  const tone = row.kind === "pagamento" ? "ok" : row.kind === "publicação" ? "bad" : "info";
                  const open = openLog === index;
                  return (
                    <button key={`${row.at}-${index}`} type="button" className={`sx-log is-${tone}${open ? " is-open" : ""}`} onClick={() => setOpenLog(open ? null : index)}>
                      <Badge tone={tone}>{row.kind === "publicação" ? "Erro" : row.kind === "pagamento" ? "Pagamento" : "Sistema"}</Badge>
                      <div><strong>{row.company || "Plataforma"}</strong><p>{open ? row.message : String(row.message || "").slice(0, 120)}</p></div>
                      <small>{when(row.at)}</small>
                    </button>
                  );
                })}
              </div>
              {!logs.length ? <Empty title="Nenhum evento neste filtro" text="Erros do robô e eventos de pagamento aparecem aqui." /> : null}
            </>
          ) : null}

          {board && view === "audit" ? (
            <>
              <div className="sx-filters"><input value={auditQuery} onChange={(event) => setAuditQuery(event.target.value)} placeholder="Quem, empresa, ação ou IP" aria-label="Buscar auditoria" /></div>
              <article className="sx-card">
                <ul className="sx-timeline">
                  {auditRows.map((row: any) => (
                    <li key={row.id}>
                      <i />
                      <div>
                        <strong>{row.summary || row.action}</strong>
                        <p>{row.action} · {row.company || "plataforma"}</p>
                        <small>{row.actor || row.actor_email || "sistema"} · {when(row.created_at)} · {row.ip || "sem IP"}</small>
                      </div>
                    </li>
                  ))}
                </ul>
                {!auditRows.length ? <Empty title="Nenhum registro" text="Entrar como cliente, renovar, cancelar e salvar a plataforma deixam rastro aqui." /> : null}
              </article>
            </>
          ) : null}

          {board && view === "quotes" ? (
            <article className="sx-card">
              <div className="sx-card__head"><div><h2>Depoimentos da landing</h2><p>Sem nenhum publicado, a seção não aparece.</p></div></div>
              <form className="sx-form" onSubmit={async (event) => {
                event.preventDefault();
                const form = new FormData(event.currentTarget);
                const ok = await run("Publicado", "O depoimento entrou na landing.", () => api("/api/admin/testimonials", { method: "POST", body: JSON.stringify({ author: form.get("author"), company: form.get("company"), quote: form.get("quote") }) }));
                if (ok) event.currentTarget.reset();
              }}>
                <label>Autor<input name="author" required /></label>
                <label>Empresa<input name="company" /></label>
                <label className="is-wide">Texto<textarea name="quote" required /></label>
                <div><button className="sx-btn is-solid" type="submit">Publicar</button></div>
              </form>
              <div className="sx-logs" style={{ marginTop: 14 }}>
                {(board.testimonials || []).map((item: any) => (
                  <article key={item.id} className="sx-log is-info">
                    <span className="sx-avatar">{initials(item.author)}</span>
                    <div><strong>{item.author}</strong><p>{item.company ? `${item.company} — ` : ""}{item.quote}</p></div>
                    <button type="button" className="sx-btn is-danger" onClick={() => run("Removido", "O depoimento saiu da landing.", () => api(`/api/admin/testimonials/${item.id}`, { method: "DELETE" }))}>Remover</button>
                  </article>
                ))}
              </div>
              {!(board.testimonials || []).length ? <Empty title="Nenhum depoimento" text="Publique um autor e um texto para a seção aparecer na página inicial." /> : null}
            </article>
          ) : null}

          {board && view === "efi" ? (
            <section className="sx-efi">
              <article className="sx-card sx-efi__status">
                <span className={`sx-badge ${board.platform.clientId && board.platform.secretSet ? "is-ok" : "is-off"}`}>{board.platform.clientId && board.platform.secretSet ? "Conectado" : "Não configurado"}</span>
                <strong>EFI / Gerencianet</strong>
                <p className="sx-note">Webhook recebido em /api/billing/webhook. O certificado PFX continua no servidor.</p>
                <div className="sx-meta">
                  <div><span>PIX</span><b>{board.platform.pixKey ? "definida" : "vazia"}</b></div>
                  <div><span>Webhook</span><b>{board.platform.webhookUrl ? "anotado" : "vazio"}</b></div>
                  <div><span>Ambiente</span><b>{efi.sandbox ? "Sandbox" : "Produção"}</b></div>
                  <div><span>Certificado</span><b>{board.platform.certReady ? "no servidor" : "ausente"}</b></div>
                  <div><span>Segredo</span><b>{board.platform.secretSet ? "gravado" : "vazio"}</b></div>
                </div>
                {efiResult ? <div className={`sx-result is-${efiResult}`}>{efiResult === "ok" ? "Conexão respondida" : "A conexão falhou"}</div> : null}
              </article>
              <article className="sx-card">
                <form className="sx-form" onSubmit={(event) => { event.preventDefault(); run("Salvo", "A EFI foi gravada.", () => api("/api/admin/platform", { method: "PUT", body: JSON.stringify(efi) })); }}>
                  <label>Client ID<input value={efi.clientId} onChange={(event) => setEfi({ ...efi, clientId: event.target.value })} autoComplete="off" /></label>
                  <label>Client Secret<input type="password" value={efi.clientSecret} placeholder={board.platform.secretSet ? "em branco mantém o atual" : "cole o segredo"} onChange={(event) => setEfi({ ...efi, clientSecret: event.target.value })} autoComplete="new-password" /></label>
                  <label>Chave PIX<input value={efi.pixKey} onChange={(event) => setEfi({ ...efi, pixKey: event.target.value })} /></label>
                  <label>URL de webhook anotada<input value={efi.webhookUrl} placeholder="https://seu-dominio/api/billing/webhook" onChange={(event) => setEfi({ ...efi, webhookUrl: event.target.value })} /></label>
                  <label className="is-wide">Ambiente<select value={efi.sandbox ? "sandbox" : "production"} onChange={(event) => setEfi({ ...efi, sandbox: event.target.value === "sandbox" })}><option value="sandbox">Sandbox</option><option value="production">Produção</option></select></label>
                  <div className="sx-actions"><button className="sx-btn is-solid" type="submit">Salvar</button><button type="button" className="sx-btn" onClick={async () => {
                    try {
                      await api("/api/admin/efi/test", { method: "POST" });
                      setEfiResult("ok");
                      await load();
                      tell("EFI", "A conexão respondeu.");
                    } catch (err) {
                      setEfiResult("bad");
                      tell("Não concluiu", err instanceof Error ? err.message : "A ação não concluiu", "bad");
                    }
                  }}>Testar conexão</button></div>
                </form>
              </article>
            </section>
          ) : null}

          {board && view === "settings" ? (
            <section className="sx-settings">
              <article className="sx-card">
                <div className="sx-card__head"><div><h2>Teste</h2><p>Dias usados como padrão das regras novas.</p></div></div>
                <form className="sx-form" onSubmit={(event) => { event.preventDefault(); run("Salvo", "O teste foi gravado.", () => api("/api/admin/platform", { method: "PUT", body: JSON.stringify({ trialDays: Number(rules.trialDays) }) })); }}>
                  <label className="is-wide">Dias de teste<input value={rules.trialDays} onChange={(event) => setRules({ ...rules, trialDays: event.target.value.replace(/[^\d]/g, "") })} /></label>
                  <div><button className="sx-btn is-solid" type="submit">Salvar teste</button></div>
                </form>
              </article>
              <article className="sx-card">
                <div className="sx-card__head"><div><h2>Cobrança</h2><p>O worker suspende quem continua em teste, nunca pagou e passou do prazo.</p></div></div>
                <form className="sx-form" onSubmit={(event) => { event.preventDefault(); run("Salvo", "A cobrança foi gravada.", () => api("/api/admin/platform", { method: "PUT", body: JSON.stringify({ blockAfterDays: Number(rules.blockAfterDays), warnDays: rules.warn.join(",") }) })); }}>
                  <label className="is-wide">Suspender o teste depois de quantos dias do vencimento<input value={rules.blockAfterDays} onChange={(event) => setRules({ ...rules, blockAfterDays: event.target.value.replace(/[^\d]/g, "") })} /></label>
                  <div className="sx-checks is-wide">{["7", "3", "1"].map((item) => <label key={item} className="sx-check"><input type="checkbox" checked={rules.warn.includes(item)} onChange={(event) => setRules({ ...rules, warn: event.target.checked ? [...rules.warn, item] : rules.warn.filter((day) => day !== item) })} /> Aviso de {item} dia{item === "1" ? "" : "s"}</label>)}</div>
                  <div><button className="sx-btn is-solid" type="submit">Salvar cobrança</button></div>
                </form>
              </article>
              <article className="sx-card">
                <div className="sx-card__head"><div><h2>SMTP</h2><p>Com o servidor gravado, o aviso também sai por e-mail para o dono.</p></div></div>
                <form className="sx-form" onSubmit={(event) => {
                  event.preventDefault();
                  const form = new FormData(event.currentTarget);
                  run("Salvo", "O e-mail foi gravado.", () => api("/api/admin/platform", { method: "PUT", body: JSON.stringify({ smtpHost: form.get("host"), smtpPort: Number(form.get("port") || 587), smtpUser: form.get("user"), smtpPass: form.get("pass"), smtpFrom: form.get("from") }) }));
                }}>
                  <label>Servidor<input name="host" defaultValue={board.platform.smtpHost || ""} placeholder="smtp.seudominio.com" /></label>
                  <label>Porta<input name="port" defaultValue={board.platform.smtpPort || 587} /></label>
                  <label>Usuário<input name="user" defaultValue={board.platform.smtpUser || ""} /></label>
                  <label>Senha<input name="pass" type="password" placeholder={board.platform.smtpSet ? "em branco mantém a atual" : ""} /></label>
                  <label className="is-wide">Remetente<input name="from" defaultValue={board.platform.smtpFrom || ""} placeholder="avisos@seudominio.com" /></label>
                  <div className="sx-actions"><button className="sx-btn is-solid" type="submit">Salvar e-mail</button><button type="button" className="sx-btn" onClick={() => run("Enviado", `O teste foi para ${session.user.email}.`, () => api("/api/admin/smtp/test", { method: "POST", body: JSON.stringify({ to: session.user.email }) }))}>Testar envio</button></div>
                </form>
              </article>
              <article className="sx-card">
                <div className="sx-card__head"><div><h2>Notificações</h2><p>Avisos já gerados para as empresas.</p></div></div>
                {(board.reminders || []).length ? (
                  <div className="sx-tablewrap"><table className="sx-table"><thead><tr><th>Empresa</th><th>Aviso</th><th>Canal</th><th>Status</th></tr></thead><tbody>{board.reminders.map((row: any) => <tr key={row.id}><td>{row.company}</td><td>{row.title}<small>{row.detail || when(row.created_at)}</small></td><td>{labelOf(row.channel)}</td><td><Badge tone={toneOf(row.status)}>{labelOf(row.status)}</Badge></td></tr>)}</tbody></table></div>
                ) : <Empty title="Nenhum aviso ainda" text="Os lembretes de 7, 3 e 1 dia aparecem aqui quando o worker os gera." />}
              </article>
            </section>
          ) : null}

          {view === "profile" ? (
            <section className="sx-profile">
              <article className="sx-card sx-profile__card">
                <span className="sx-avatar is-lg">{initials(session.user.name)}</span>
                <h2>{session.user.name}</h2>
                <p>{session.user.email}</p>
                <span className="sx-badge">SUPER ADMIN</span>
              </article>
              <article className="sx-card">
                <div className="sx-card__head"><div><h2>Conta</h2><p>A senha em branco mantém a atual.</p></div></div>
                <form key={`${session.user.id}-${session.user.email}`} className="sx-form" onSubmit={(event) => {
                  event.preventDefault();
                  const formEl = event.currentTarget;
                  const form = new FormData(formEl);
                  const password = String(form.get("password") || "");
                  run("Salvo", "O perfil foi atualizado.", async () => {
                    await api("/api/admin/profile", { method: "PATCH", body: JSON.stringify({ name: form.get("name"), email: form.get("email"), password }) });
                    await onRefresh();
                    const field = formEl.elements.namedItem("password") as HTMLInputElement | null;
                    if (field) field.value = "";
                  });
                }}>
                  <label>Nome<input name="name" required defaultValue={session.user.name} /></label>
                  <label>E-mail<input name="email" type="email" required defaultValue={session.user.email} /></label>
                  <label className="is-wide">Nova senha<input name="password" type="password" minLength={6} placeholder="Em branco mantém a atual" /></label>
                  <div><button className="sx-btn is-solid" type="submit">Salvar</button></div>
                </form>
              </article>
            </section>
          ) : null}
        </div>
      </div>

      <div className="sx-toasts">{notices.map((item) => (
        <article key={item.id} className={`sx-toast${item.tone === "bad" ? " is-bad" : ""}`} role="status">
          <span className="sx-toast__mark" aria-hidden="true">{item.tone === "bad" ? "!" : "✓"}</span>
          <div><strong>{item.title}</strong><p>{item.text}</p></div>
          <button type="button" aria-label="Fechar aviso" onClick={() => setNotices((list) => list.filter((row) => row.id !== item.id))}>×</button>
        </article>
      ))}</div>

      {ask ? (
        <div className="sx-modal" role="dialog" aria-modal="true">
          <button type="button" className="sx-modal__backdrop" aria-label="Fechar" onClick={() => setAsk(null)} />
          <div className="sx-modal__card"><h2>{ask.title}</h2><p>{ask.text}</p><div className="sx-modal__actions"><button type="button" className="sx-btn" onClick={() => setAsk(null)}>Cancelar</button><button type="button" className="sx-btn is-solid" onClick={async () => { const job = ask; setAsk(null); await job.run(); }}>{ask.confirm}</button></div></div>
        </div>
      ) : null}

      {detail ? (
        <div className="sx-drawer" role="dialog" aria-modal="true" aria-label={detail.name}>
          <button type="button" className="sx-drawer__backdrop" aria-label="Fechar" onClick={() => setDetail(null)} />
          <aside className="sx-drawer__panel">
            <header className="sx-drawer__head">
              <div className="sx-who"><span className="sx-avatar">{initials(detail.name)}</span><div><h2>{detail.name}</h2><StatusBadge company={detail} /></div></div>
              <button type="button" className="sx-iconbtn" aria-label="Fechar" onClick={() => setDetail(null)}>×</button>
            </header>
            <div className="sx-drawer__body">
              <dl className="sx-facts">
                <div><dt>Plano</dt><dd>{detail.plan_name || "—"} · {labelOf(detail.sub_status)}</dd></div>
                <div><dt>Responsável</dt><dd>{detail.owner_name || "—"}</dd></div>
                <div><dt>E-mail</dt><dd>{detail.owner_email || "—"}</dd></div>
                <div><dt>Telefone</dt><dd>{detail.owner_phone || "—"}</dd></div>
                <div><dt>Cidade</dt><dd>{detail.city || "—"}</dd></div>
                <div><dt>Estado</dt><dd>{detail.state || "—"}</dd></div>
                <div><dt>Receita paga</dt><dd>{money(detail.revenue_cents)}</dd></div>
                <div><dt>Validade</dt><dd>{when(detail.current_period_end || detail.trial_ends_at)}</dd></div>
                <div><dt>Último acesso</dt><dd>{when(detail.last_login_at)}</dd></div>
                <div><dt>Cadastro</dt><dd>{when(detail.created_at)}</dd></div>
              </dl>
              <div className="sx-mini">
                <article><span>WhatsApps</span><strong>{num(detail.whatsapps)}</strong></article>
                <article><span>Grupos</span><strong>{num(detail.groups)}</strong></article>
                <article><span>Publicações</span><strong>{num(detail.posts)}</strong></article>
                <article><span>Cliques</span><strong>{num(detail.clicks)}</strong></article>
              </div>
              <form className="sx-form" key={`${detail.id}-${detail.updated || detail.plan_slug}-${detail.status}-${detail.sub_status}`} onSubmit={async (event) => {
                event.preventDefault();
                const data = new FormData(event.currentTarget);
                const ok = await run("Salvo", `${detail.name} foi atualizada.`, () => api(`/api/admin/companies/${detail.id}`, { method: "PATCH", body: JSON.stringify({
                  name: data.get("name"),
                  planSlug: data.get("plan"),
                  status: data.get("status"),
                  subStatus: data.get("subStatus"),
                  validUntil: data.get("validUntil")
                }) }));
                if (ok) setDetail(null);
              }}>
                <label className="is-wide">Nome<input name="name" required defaultValue={detail.name} /></label>
                <label>Plano<select name="plan" defaultValue={detail.plan_slug || ""}>{(board?.plans || []).map((plan: any) => <option key={plan.id} value={plan.slug}>{plan.name}</option>)}</select></label>
                <label>Status<select name="status" defaultValue={detail.status === "blocked" || detail.status === "suspended" ? detail.status : "active"}><option value="active">Ativa</option><option value="suspended">Suspensa</option><option value="blocked">Bloqueada</option></select></label>
                <label>Assinatura<select name="subStatus" defaultValue={detail.sub_status || "trialing"}><option value="trialing">Teste</option><option value="active">Paga</option><option value="canceled">Cancelada</option></select></label>
                <label>Validade<input type="date" name="validUntil" defaultValue={String(detail.current_period_end || detail.trial_ends_at || "").slice(0, 10)} /></label>
                <div className="is-wide"><button className="sx-btn is-solid" type="submit">Salvar</button></div>
              </form>
            </div>
            <footer className="sx-drawer__foot">
              <div className="sx-actions">
                <button type="button" className="sx-btn is-solid" onClick={() => act(detail, "enter")}>Entrar como cliente</button>
                <button type="button" className="sx-btn is-danger" onClick={() => act(detail, "delete")}>Excluir</button>
              </div>
            </footer>
          </aside>
        </div>
      ) : null}

      {createOpen ? (
        <div className="sx-drawer" role="dialog" aria-modal="true" aria-label="Nova empresa">
          <button type="button" className="sx-drawer__backdrop" aria-label="Fechar" onClick={() => setCreateOpen(false)} />
          <aside className="sx-drawer__panel">
            <header className="sx-drawer__head"><h2>Nova empresa</h2><button type="button" className="sx-iconbtn" aria-label="Fechar" onClick={() => setCreateOpen(false)}>×</button></header>
            <form className="sx-drawer__body" onSubmit={async (event) => {
              event.preventDefault();
              const form = event.currentTarget;
              const data = new FormData(form);
              const ok = await run("Criada", "A empresa foi criada em teste.", () => api("/api/admin/companies", { method: "POST", body: JSON.stringify({ name: data.get("name"), planSlug: data.get("plan"), ownerName: data.get("ownerName"), email: data.get("email"), password: data.get("password") }) }));
              if (!ok) return;
              form.reset();
              setCreateOpen(false);
            }}>
              <p className="sx-note">A validade do teste sai dos dias do plano. O e-mail e a senha criam o acesso de quem vai entrar no painel.</p>
              <div className="sx-form">
                <label className="is-wide">Nome da empresa<input name="name" required placeholder="Nome da empresa" /></label>
                <label className="is-wide">Plano<select name="plan" required>{(board?.plans || []).filter((plan: any) => plan.active !== false).map((plan: any) => <option key={plan.id} value={plan.slug}>{plan.name}</option>)}</select></label>
                <label>Responsável<input name="ownerName" placeholder="Nome de quem acessa" /></label>
                <label>E-mail<input name="email" type="email" placeholder="acesso@empresa.com" /></label>
                <label className="is-wide">Senha<input name="password" type="password" minLength={6} placeholder="6 caracteres, se for criar o acesso" /></label>
              </div>
              <div className="sx-actions"><button className="sx-btn" type="button" onClick={() => setCreateOpen(false)}>Cancelar</button><button className="sx-btn is-solid" type="submit">Criar</button></div>
            </form>
          </aside>
        </div>
      ) : null}

      {planOpen ? (
        <div className="sx-drawer" role="dialog" aria-modal="true" aria-label={planOpen.id ? "Editar plano" : "Novo plano"}>
          <button type="button" className="sx-drawer__backdrop" aria-label="Fechar" onClick={() => setPlanOpen(null)} />
          <aside className="sx-drawer__panel">
            <header className="sx-drawer__head"><h2>{planOpen.id ? "Editar plano" : "Novo plano"}</h2><button type="button" className="sx-iconbtn" aria-label="Fechar" onClick={() => setPlanOpen(null)}>×</button></header>
            <div className="sx-drawer__body">
              <div className="sx-form">
                <label className="is-wide">Nome<input value={planOpen.name} onChange={(event) => setPlanOpen({ ...planOpen, name: event.target.value })} /></label>
                <label className="is-wide">Descrição<input value={planOpen.description} onChange={(event) => setPlanOpen({ ...planOpen, description: event.target.value })} /></label>
                <label className="is-wide">Benefícios<textarea rows={4} value={planOpen.benefits} placeholder="Um benefício por linha" onChange={(event) => setPlanOpen({ ...planOpen, benefits: event.target.value })} /></label>
                <label>Mensal (R$)<input value={planOpen.monthly} inputMode="decimal" placeholder="0,00" onChange={(event) => setPlanOpen({ ...planOpen, monthly: event.target.value })} /></label>
                <label>Anual (R$)<input value={planOpen.yearly} inputMode="decimal" placeholder="opcional" onChange={(event) => setPlanOpen({ ...planOpen, yearly: event.target.value })} /></label>
                <label>Trimestral (R$)<input value={planOpen.quarterly} inputMode="decimal" placeholder="opcional" onChange={(event) => setPlanOpen({ ...planOpen, quarterly: event.target.value })} /></label>
                <label>Semestral (R$)<input value={planOpen.semiannual} inputMode="decimal" placeholder="opcional" onChange={(event) => setPlanOpen({ ...planOpen, semiannual: event.target.value })} /></label>
                <label>Dias de teste<input value={planOpen.trial} inputMode="numeric" onChange={(event) => setPlanOpen({ ...planOpen, trial: event.target.value })} /></label>
                <label>WhatsApps<input value={planOpen.connections} inputMode="numeric" placeholder="Ilimitado" onChange={(event) => setPlanOpen({ ...planOpen, connections: event.target.value })} /></label>
                <label>Grupos<input value={planOpen.groups} inputMode="numeric" placeholder="Ilimitado" onChange={(event) => setPlanOpen({ ...planOpen, groups: event.target.value })} /></label>
                <label>Usuários<input value={planOpen.users} inputMode="numeric" placeholder="Ilimitado" onChange={(event) => setPlanOpen({ ...planOpen, users: event.target.value })} /></label>
                <label className="sx-check"><input type="checkbox" checked={planOpen.api} onChange={(event) => setPlanOpen({ ...planOpen, api: event.target.checked })} /> API liberada</label>
                <label className="sx-check"><input type="checkbox" checked={planOpen.priority} onChange={(event) => setPlanOpen({ ...planOpen, priority: event.target.checked })} /> Suporte prioritário</label>
                <label className="sx-check"><input type="checkbox" checked={planOpen.active} onChange={(event) => setPlanOpen({ ...planOpen, active: event.target.checked })} /> Plano ativo na landing</label>
              </div>
            </div>
            <footer className="sx-drawer__foot"><button type="button" className="sx-btn" onClick={() => setPlanOpen(null)}>Cancelar</button><button type="button" className="sx-btn is-solid" onClick={savePlan}>Salvar</button></footer>
          </aside>
        </div>
      ) : null}

      {qr ? (
        <div className="sx-modal" role="dialog" aria-modal="true">
          <button type="button" className="sx-modal__backdrop" aria-label="Fechar" onClick={() => setQr(null)} />
          <div className="sx-modal__card"><h2>{qr.name}</h2>{qr.image ? <img src={qr.image} alt="QR Code" width={260} height={260} /> : <p>O QR não está mais disponível. Status: {qr.status}</p>}<button type="button" className="sx-btn" onClick={() => setQr(null)}>Fechar</button></div>
        </div>
      ) : null}
    </div>
  );
}

function Icon({ d }: { d: string }) {
  return <svg className="sx-ico" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>;
}

function StatusBadge({ company }: { company: any }) {
  const canceled = company.sub_status === "canceled";
  const tone = company.status === "blocked" ? "bad" : canceled ? "off" : company.status === "suspended" ? "wait" : company.sub_status === "trialing" ? "trial" : "ok";
  const label = company.status === "blocked" ? "Bloqueada" : canceled ? "Cancelada" : company.status === "suspended" ? "Suspensa" : company.sub_status === "trialing" ? "Teste" : "Ativa";
  return <span className={`sx-badge is-${tone}`}>{label}</span>;
}

function Badge({ tone, children }: { tone: string; children: string }) {
  return <span className={`sx-badge is-${tone}`}>{children}</span>;
}

function WaStatus({ status, error }: { status: string; error?: string }) {
  const live = status === "connected" || status === "qrcode";
  const tone = error && status !== "connected" ? "bad" : status === "connected" ? "ok" : status === "qrcode" ? "wait" : "bad";
  return <span className={`sx-badge is-${tone}`}><i className={`sx-dot${live ? " is-live" : ""}`} />{labelOf(status)}</span>;
}

function Empty({ title, text }: { title: string; text: string }) {
  return <div className="sx-empty"><strong>{title}</strong>{text}</div>;
}

function Skeleton() {
  return (
    <>
      <div className="sx-skeleton" style={{ minHeight: 56 }} />
      <section className="sx-kpis">{Array.from({ length: 4 }, (_, index) => <div key={index} className="sx-skeleton" />)}</section>
      <section className="sx-stats">{Array.from({ length: 5 }, (_, index) => <div key={index} className="sx-skeleton" style={{ minHeight: 78 }} />)}</section>
      <div className="sx-skeleton" style={{ minHeight: 280 }} />
    </>
  );
}

function Spark({ rows, field, dark, moneyMode = false }: { rows: any[]; field: string; dark: boolean; moneyMode?: boolean }) {
  const data = rows.map((row) => ({ label: row.label, value: Number(row[field]) || 0 }));
  if (data.length < 2) return null;
  const color = "#6366f1";
  return (
    <div className="sx-spark">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 4, right: 0, left: 0, bottom: 0 }}>
          <Area type="monotone" dataKey="value" stroke={color} strokeWidth={1.75} fill={dark ? "rgba(99,102,241,0.25)" : "rgba(99,102,241,0.15)"} />
          <Tooltip formatter={(value) => moneyMode ? money(Number(value)) : num(Number(value))} labelFormatter={(label) => String(label)} contentStyle={{ background: dark ? "#0f172a" : "#fff", border: "1px solid #e2e8f0", borderRadius: 10, fontSize: 11 }} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

function Trend({ rows, field, dark, ink, grid, tip, moneyMode = false, bars = false, color = "#6366f1" }: { rows: any[]; field: string; dark: boolean; ink: string; grid: string; tip: object; moneyMode?: boolean; bars?: boolean; color?: string }) {
  const data = rows.map((row) => ({ label: row.label, value: Number(row[field]) || 0 }));
  const id = useId().replace(/:/g, "");
  if (!data.length) return <Empty title="Sem série ainda" text="Quando houver movimento, o gráfico entra aqui." />;
  const axis = { tick: { fontSize: 11, fill: ink }, axisLine: false, tickLine: false };
  return (
    <div className="sx-chart">
      <ResponsiveContainer width="100%" height="100%">
        {bars ? (
          <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid stroke={grid} vertical={false} />
            <XAxis dataKey="label" {...axis} />
            <YAxis {...axis} width={36} />
            <Tooltip formatter={(value) => num(Number(value))} contentStyle={tip} />
            <Bar dataKey="value" fill={color} radius={[8, 8, 0, 0]} maxBarSize={28} />
          </BarChart>
        ) : (
          <AreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity={0.35} />
                <stop offset="100%" stopColor={color} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke={grid} vertical={false} />
            <XAxis dataKey="label" {...axis} />
            <YAxis {...axis} width={moneyMode ? 72 : 36} tickFormatter={(value) => moneyMode ? money(Number(value)) : num(Number(value))} />
            <Tooltip formatter={(value) => moneyMode ? money(Number(value)) : num(Number(value))} contentStyle={tip} />
            <Area type="monotone" dataKey="value" stroke={color} strokeWidth={2} fill={`url(#${id})`} />
          </AreaChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}

function PayTable({ rows }: { rows: any[] }) {
  return (
    <div className="sx-tablewrap">
      <table className="sx-table">
        <thead><tr><th>Empresa</th><th>Valor</th><th>Método</th><th>Status</th><th>Data</th></tr></thead>
        <tbody>
          {rows.map((row: any) => (
            <tr key={row.id}><td>{row.company}</td><td>{money(row.amount_cents)}</td><td>{labelOf(row.method)}</td><td><Badge tone={toneOf(row.status)}>{labelOf(row.status)}</Badge></td><td>{when(row.paid_at || row.created_at)}</td></tr>
          ))}
        </tbody>
      </table>
      {!rows.length ? <Empty title="Nenhum pagamento neste filtro" text="As faturas pagas e pendentes aparecem aqui." /> : null}
    </div>
  );
}

function DataTable({ title, note, columns, rows }: { title: string; note?: string; columns: string[]; rows: Array<Array<ReactNode>> }) {
  return (
    <article className="sx-card">
      <div className="sx-card__head"><div><h2>{title}</h2>{note ? <p>{note}</p> : null}</div></div>
      <div className="sx-tablewrap">
        <table className="sx-table">
          <thead><tr>{columns.map((column) => <th key={column}>{column}</th>)}</tr></thead>
          <tbody>{rows.map((row, index) => <tr key={index}>{row.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}</tr>)}</tbody>
        </table>
      </div>
      {!rows.length ? <Empty title="Nada por aqui ainda" text="Quando houver registros, eles entram nesta lista." /> : null}
    </article>
  );
}
