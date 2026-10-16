import { useEffect, useState } from "react";
import { api, clearToken, getToken, setToken } from "./api";
import { Landing } from "./Landing";
import { Mark } from "./Mark";
import { Admin } from "./Admin";
import { Panel } from "./Panel";
import { go, isAdminPath, isClientPath, isPublicPath, usePath } from "./route";

export type Session = {
  user: { id: number; name: string; email: string; role: string; companyId: number | null; tenantId: string | null; companyStatus: string | null };
  subscription: {
    status: string;
    plan_name: string;
    trial_ends_at: string | null;
    current_period_end: string | null;
    company_status: string;
    company_name: string;
    tenant_id: string;
    max_connections: number | null;
    max_groups: number | null;
    max_users: number | null;
    max_posts_per_month?: number | null;
    features?: { api?: boolean; prioritySupport?: boolean };
    city?: string;
    state?: string;
  } | null;
  efi: boolean;
};

export function App() {
  const path = usePath();
  const [ready, setReady] = useState(!getToken());
  const [session, setSession] = useState<Session | null>(null);
  const [plan, setPlan] = useState(() => new URLSearchParams(window.location.search).get("plano") || "");
  const [plans, setPlans] = useState<Array<{ slug: string; name: string; trial_days: number }>>([]);
  const [error, setError] = useState("");
  const screen = path === "/login" ? "login" : path === "/cadastro" ? "register" : "landing";

  const refresh = async () => {
    const data = await api<Session>("/api/me");
    setSession(data);
    return data;
  };

  useEffect(() => {
    if (!getToken()) return;
    refresh().catch(() => clearToken()).finally(() => setReady(true));
  }, []);

  useEffect(() => {
    if (!ready) return;
    const admin = session?.user.role === "superadmin";
    if (!session) {
      if (!isPublicPath(path)) go("/login", true);
      return;
    }
    const home = admin ? "/admin" : "/home";
    if (path === "/" || path === "/login" || path === "/cadastro") go(home, true);
    else if (admin && !isAdminPath(path)) go("/admin", true);
    else if (!admin && !isClientPath(path)) go("/home", true);
  }, [ready, session, path]);

  useEffect(() => {
    if (screen !== "register") return;
    api<{ plans: Array<{ slug: string; name: string; trial_days: number }> }>("/api/plans").then((data) => {
      const rows = data.plans || [];
      setPlans(rows);
      setPlan((current) => rows.some((item) => item.slug === current) ? current : (rows[0]?.slug || ""));
    }).catch(() => setPlans([]));
  }, [screen]);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");
    const form = new FormData(event.currentTarget);
    try {
      const url = screen === "register" ? "/api/auth/register" : "/api/auth/login";
      const body = screen === "register"
        ? { name: form.get("name"), email: form.get("email"), password: form.get("password"), companyName: form.get("companyName"), phone: form.get("phone"), city: form.get("city"), state: form.get("state"), planSlug: plan }
        : { email: form.get("email"), password: form.get("password") };
      const data = await api<{ token: string }>(url, { method: "POST", body: JSON.stringify(body) });
      setToken(data.token);
      const next = await refresh();
      go(next.user.role === "superadmin" ? "/admin" : "/home");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha");
    }
  };

  const logout = async () => {
    await api("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    sessionStorage.removeItem("achadinhos-admin");
    clearToken();
    setSession(null);
    go("/");
  };

  const enterCompany = async (token: string) => {
    const current = getToken();
    if (current) sessionStorage.setItem("achadinhos-admin", current);
    setToken(token);
    await refresh();
    go("/home");
  };

  const backToAdmin = async () => {
    const saved = sessionStorage.getItem("achadinhos-admin");
    sessionStorage.removeItem("achadinhos-admin");
    if (!saved) return logout();
    setToken(saved);
    await refresh();
    go("/admin");
  };

  if (!ready) return <main className="land" />;

  if (session?.user.role === "superadmin" && isAdminPath(path)) {
    return <Admin session={session} onLogout={logout} onEnter={enterCompany} onRefresh={refresh} />;
  }
  if (session && isClientPath(path)) {
    return <div className="aff-screen"><Panel session={session} onLogout={logout} onRefresh={refresh} onReturn={sessionStorage.getItem("achadinhos-admin") ? backToAdmin : undefined} /></div>;
  }
  if (screen === "login" || screen === "register") {
    const estados = ["AC","AL","AM","AP","BA","CE","DF","ES","GO","MA","MG","MS","MT","PA","PB","PE","PI","PR","RJ","RN","RO","RR","RS","SC","SE","SP","TO"];
    return (
      <main className="auth">
        <section className="auth-aside">
          <div>
            <button type="button" className="land-brand" onClick={() => go("/")}>
              <Mark />
              Achadinhos
            </button>
            <h1>{screen === "register" ? "Comece a publicar ofertas nos seus grupos." : "Sua operação de ofertas continua aqui."}</h1>
            <ul>
              <li>Ofertas publicadas automaticamente no WhatsApp</li>
              <li>Várias lojas e grupos na mesma conta</li>
              <li>Dados isolados da sua empresa</li>
            </ul>
          </div>
        </section>
        <section className="auth-panel">
          <div className="auth-card">
            <h2>{screen === "register" ? "Criar conta grátis" : "Entrar"}</h2>
            <p>{screen === "register" ? "Leva menos de 5 minutos para deixar a automação pronta." : "Use o e-mail e a senha da sua empresa."}</p>
            <form onSubmit={submit}>
              {screen === "register" && (
                <>
                  <label>Seu nome<input name="name" required autoComplete="name" /></label>
                  <label>Empresa<input name="companyName" required autoComplete="organization" /></label>
                  <label>Telefone<input name="phone" inputMode="tel" autoComplete="tel" /></label>
                  <div className="auth-row">
                    <label>Cidade<input name="city" required autoComplete="address-level2" /></label>
                    <label>Estado
                      <select name="state" required defaultValue="">
                        <option value="" disabled>UF</option>
                        {estados.map((uf) => <option key={uf} value={uf}>{uf}</option>)}
                      </select>
                    </label>
                  </div>
                  <label>Plano
                    <select value={plan} onChange={(event) => setPlan(event.target.value)} required>
                      {!plans.length ? <option value="">Nenhum plano disponível</option> : null}
                      {plans.map((item) => <option key={item.slug} value={item.slug}>{item.name} · {item.trial_days} dias grátis</option>)}
                    </select>
                  </label>
                </>
              )}
              <label>E-mail<input name="email" type="email" required autoComplete="email" /></label>
              <label>Senha<input name="password" type="password" required minLength={6} autoComplete={screen === "register" ? "new-password" : "current-password"} /></label>
              {error ? <p className="auth-error">{error}</p> : null}
              <button className="land-btn is-primary" type="submit" disabled={screen === "register" && !plan}>{screen === "register" ? "Criar minha conta grátis" : "Entrar"}</button>
            </form>
            <div className="auth-links">
              <button type="button" onClick={() => go(screen === "login" ? "/cadastro" : "/login")}>{screen === "login" ? "Criar conta grátis" : "Já tenho conta"}</button>
              <button type="button" onClick={() => go("/")}>Voltar ao início</button>
            </div>
          </div>
        </section>
      </main>
    );
  }
  return <Landing onLogin={() => go("/login")} onRegister={(slug) => { setPlan(slug); go(slug ? `/cadastro?plano=${encodeURIComponent(slug)}` : "/cadastro"); }} />;
}
