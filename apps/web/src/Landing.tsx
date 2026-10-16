import { useEffect, useState } from "react";
import { Mark } from "./Mark";
import { api } from "./api";

type Plan = {
  slug: string;
  name: string;
  description: string;
  benefits: string;
  monthly_cents: number;
  yearly_cents: number;
  trial_days: number;
  max_connections: number | null;
  max_groups: number | null;
};
type Quote = { id: number; author: string; company: string; quote: string };

const money = (cents: number) => (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const linesOf = (value: string) => value.split("\n").map((line) => line.trim()).filter(Boolean);
const cap = (value: number | null, one: string, many: string) => (value == null ? `${many} sem limite` : value === 1 ? `1 ${one}` : `${value} ${many}`);

const stores = [
  ["ml", "Mercado Livre"],
  ["shopee", "Shopee"],
  ["amazon", "Amazon"],
  ["aliexpress", "AliExpress"],
  ["awin", "Awin"],
  ["rakuten", "Rakuten"],
  ["epoca", "Época Cosméticos"]
] as const;

const faqs = [
  ["Preciso deixar meu computador ligado?", "Não. A publicação continua na plataforma, mesmo com o seu computador desligado."],
  ["Posso usar vários grupos?", "Sim. Cada grupo pode receber lojas, categorias e horários diferentes."],
  ["Posso pausar a automação?", "Sim. Você pausa quando quiser e volta a publicar sem montar tudo de novo."],
  ["Minha conta é separada das outras empresas?", "Sim. Cada empresa enxerga apenas os próprios grupos, lojas e credenciais."],
  ["Quais lojas são suportadas?", "Mercado Livre, Shopee, Amazon, AliExpress, Awin, Rakuten e Época Cosméticos."],
  ["Posso escolher quais categorias serão enviadas?", "Sim. Você define o tipo de produto que cada grupo deve receber."],
  ["A mesma oferta pode ser enviada várias vezes?", "O Achadinhos segura a repetição pelo período que você definir na automação."],
  ["Como funciona o teste grátis?", "A conta já entra no período de teste do plano escolhido. O cartão não é pedido para começar."]
];

const Icon = ({ d }: { d: string }) => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d={d} />
  </svg>
);

const icons = {
  clock: "M12 7v5l3 2M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18",
  groups: "M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6M16 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6M4 19c0-2.2 1.8-4 4-4s4 1.8 4 4M12 19c0-2.2 1.8-4 4-4s4 1.8 4 4",
  plug: "M8 3v5M16 3v5M7 8h10v3a5 5 0 0 1-10 0V8M12 16v5",
  shield: "M12 3l7 3v6c0 4.2-2.8 7.4-7 9-4.2-1.6-7-4.8-7-9V6l7-3",
  store: "M4 9h16l-1 11H5L4 9M4 9l2-5h12l2 5M9 13v3M15 13v3",
  chat: "M5 6h14v9H8l-3 3V6",
  filter: "M4 6h16M7 12h10M10 18h4",
  clock2: "M12 8v4l2.5 1.5M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18",
  repeat: "M7 7h9l-2-2M17 17H8l2 2M7 7v4M17 17v-4",
  chart: "M4 19V5M4 19h16M8 16v-4M12 16V8M16 16v-6",
  check: "M5 12.5 9.2 17 19 7"
};

export function Landing({ onLogin, onRegister }: { onLogin: () => void; onRegister: (slug: string) => void }) {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [plansReady, setPlansReady] = useState(false);
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [menu, setMenu] = useState(false);
  const [openFaq, setOpenFaq] = useState(0);
  const [legal, setLegal] = useState<"termos" | "privacidade" | "contato" | null>(null);

  useEffect(() => {
    api<{ plans: Plan[] }>("/api/plans").then((data) => setPlans(data.plans || [])).catch(() => setPlans([])).finally(() => setPlansReady(true));
    api<{ testimonials: Quote[] }>("/api/testimonials").then((data) => setQuotes(data.testimonials || [])).catch(() => undefined);
  }, []);

  useEffect(() => {
    const nodes = document.querySelectorAll(".land-reveal");
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) entry.target.classList.add("is-in");
      });
    }, { threshold: 0.16 });
    nodes.forEach((node) => observer.observe(node));
    return () => observer.disconnect();
  }, [plansReady, plans.length, quotes.length, legal]);

  const start = (slug?: string) => onRegister(slug || plans[0]?.slug || "");
  const closeMenu = () => setMenu(false);

  return (
    <div className="land">
      <header className="land-nav">
        <div className="land-wrap land-nav__bar">
          <a className="land-brand" href="#topo" onClick={closeMenu}>
            <Mark />
            Achadinhos
          </a>
          <nav className={menu ? "is-open" : ""} aria-label="Seções">
            <a href="#recursos" onClick={closeMenu}>Recursos</a>
            <a href="#como" onClick={closeMenu}>Como funciona</a>
            <a href="#integracoes" onClick={closeMenu}>Integrações</a>
            {plans.length ? <a href="#planos" onClick={closeMenu}>Planos</a> : null}
            <a href="#faq" onClick={closeMenu}>FAQ</a>
            <button type="button" className="land-btn is-ghost" onClick={onLogin}>Entrar</button>
            <button type="button" className="land-btn is-primary" onClick={() => start()}>Criar conta grátis</button>
          </nav>
          <button type="button" className="land-btn is-ghost land-nav__enter" onClick={onLogin}>Entrar</button>
          <button type="button" className="land-burger" aria-label={menu ? "Fechar menu" : "Abrir menu"} aria-expanded={menu} onClick={() => setMenu((open) => !open)}>
            <i /><i /><i />
          </button>
        </div>
      </header>

      <section className="land-hero" id="topo">
        <div className="land-glow" aria-hidden="true" />
        <div className="land-wrap land-hero__grid">
          <div className="land-hero__copy">
            <p className="land-kicker">Automação para afiliados</p>
            <h1>Transforme seus grupos do WhatsApp em uma máquina de ofertas.</h1>
            <p>Encontre promoções, aplique seus links de afiliado e publique automaticamente nos seus grupos — enquanto o Achadinhos trabalha por você.</p>
            <div className="land-actions">
              <button type="button" className="land-btn is-primary" onClick={() => start()}>Começar grátis</button>
              <a className="land-btn is-ghost" href="#como">Ver como funciona</a>
            </div>
            <ul className="land-checks">
              <li><Icon d={icons.check} />Teste grátis</li>
              <li><Icon d={icons.check} />Sem cartão para começar</li>
              <li><Icon d={icons.check} />Cancele quando quiser</li>
            </ul>
          </div>
          <div className="land-stage" aria-hidden="true">
            <div className="land-mock">
              <header>
                <strong>Achadinhos</strong>
                <span><i />Automação ativa</span>
              </header>
              <div className="land-mock__stats">
                <article><small>Ofertas enviadas hoje</small><b>247</b></article>
                <article><small>Comissões estimadas</small><b>R$ 384,72</b></article>
                <article><small>Grupos ativos</small><b>12</b></article>
              </div>
              <p>Últimas ofertas</p>
              <div className="land-offer">
                <span className="is-phone" />
                <div><strong>Smartphone Samsung</strong><em>R$ 1.899 <b>R$ 1.549</b></em></div>
                <small>Mercado Livre</small>
              </div>
              <div className="land-offer">
                <span className="is-speaker" />
                <div><strong>Echo Dot</strong><em>R$ 429 <b>R$ 299</b></em></div>
                <small>Amazon</small>
              </div>
            </div>
            <div className="land-toast"><Icon d={icons.check} />Oferta enviada para Grupo Ofertas VIP</div>
          </div>
        </div>
      </section>

      <section className="land-proof">
        <div className="land-wrap">
          {[
            [icons.clock, "Automação 24/7", "Publica mesmo fora do seu horário"],
            [icons.groups, "Vários grupos", "Uma estratégia para cada público"],
            [icons.plug, "7 integrações", "As principais lojas de afiliado"],
            [icons.shield, "Ambiente isolado", "Cada empresa com os próprios dados"]
          ].map(([icon, title, text]) => (
            <article key={title}>
              <Icon d={icon} />
              <div><strong>{title}</strong><span>{text}</span></div>
            </article>
          ))}
        </div>
      </section>

      <section className="land-band" id="como">
        <div className="land-wrap land-reveal">
          <div className="land-head">
            <h2>Configure uma vez. Deixe o Achadinhos trabalhar.</h2>
            <p>Da configuração ao envio da oferta em poucos minutos.</p>
          </div>
          <div className="land-steps">
            {[
              [icons.store, "Conecte suas lojas", "Adicione suas credenciais e links de afiliado."],
              [icons.chat, "Conecte seu WhatsApp", "Use sua própria conexão para enviar as ofertas."],
              [icons.filter, "Escolha grupos e categorias", "Defina quais produtos cada público deve receber."],
              [icons.clock2, "Ative a automação", "O sistema busca, filtra e publica as ofertas automaticamente."]
            ].map(([icon, title, text], index) => (
              <article key={title}>
                <b>{String(index + 1).padStart(2, "0")}</b>
                <Icon d={icon} />
                <h3>{title}</h3>
                <p>{text}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="land-band is-soft" id="recursos">
        <div className="land-wrap land-reveal">
          <div className="land-head">
            <h2>Tudo que você precisa para escalar seus grupos de ofertas</h2>
          </div>
          <div className="land-cards">
            {[
              [icons.chat, "Publicação automática", "Envie ofertas sem precisar procurar produto por produto."],
              [icons.groups, "Múltiplos grupos", "Configure estratégias diferentes para cada público."],
              [icons.store, "Múltiplas lojas", "Centralize seus programas de afiliados em um só lugar."],
              [icons.clock2, "Controle de horários", "Defina dias e horários em que cada automação pode funcionar."],
              [icons.repeat, "Anti-repetição", "Evite reenviar a mesma oferta dentro do período configurado."],
              [icons.chart, "Métricas", "Acompanhe cliques, ofertas publicadas e desempenho das campanhas."]
            ].map(([icon, title, text]) => (
              <article key={title}>
                <Icon d={icon} />
                <h3>{title}</h3>
                <p>{text}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="land-band" id="integracoes">
        <div className="land-wrap land-reveal">
          <div className="land-head">
            <h2>Suas lojas favoritas em um só lugar</h2>
            <p>Conecte a conta de afiliado e deixe a busca entrar na rotina dos grupos.</p>
          </div>
          <div className="land-stores">
            {stores.map(([id, name]) => (
              <article key={id}>
                <img src={`/deals-logos/${id}.svg`} alt="" />
                <strong>{name}</strong>
                <span>Disponível</span>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="land-spot">
        <div className="land-wrap land-split land-reveal">
          <div className="land-board" aria-hidden="true">
            <header><strong>Painel</strong><span>Hoje</span></header>
            <div className="land-board__row"><i className="is-on" />WhatsApp conectado<small>12 grupos</small></div>
            <div className="land-board__row"><i className="is-on" />Mercado Livre<small>42 ofertas hoje</small></div>
            <div className="land-board__row"><i />Amazon<small>aguardando horário</small></div>
            <div className="land-board__bars"><span style={{ height: "46%" }} /><span style={{ height: "72%" }} /><span style={{ height: "58%" }} /><span style={{ height: "88%" }} /><span style={{ height: "64%" }} /></div>
          </div>
          <div>
            <h2>Sua operação inteira em um único painel</h2>
            <p>Veja quais grupos estão ativos, acompanhe as últimas publicações, gerencie suas lojas e controle toda a automação sem precisar alternar entre várias ferramentas.</p>
            <ul className="land-list">
              {["Status das conexões", "Histórico de publicações", "Configuração por grupo", "Controle de lojas e categorias", "Métricas de desempenho"].map((item) => (
                <li key={item}><Icon d={icons.check} />{item}</li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      {plansReady && plans.length ? (
        <section className="land-band" id="planos">
          <div className="land-wrap land-reveal">
            <div className="land-head">
              <h2>Escolha como quer começar</h2>
              <p>O teste grátis vale para o plano que você escolher no cadastro.</p>
            </div>
            <div className={`land-plans is-${Math.min(plans.length, 3)}`}>
              {plans.map((plan, index) => {
                const benefits = linesOf(plan.benefits || plan.description || "");
                const price = plan.monthly_cents > 0 ? [plan.monthly_cents, "/mês"] : [plan.yearly_cents, "/ano"];
                const popular = plans.length >= 3 && index === 1;
                return (
                  <article key={plan.slug} className={popular ? "is-popular" : ""}>
                    {popular ? <em>Mais popular</em> : null}
                    <h3>{plan.name}</h3>
                    <p className="land-price">{money(price[0] as number)}<small>{price[1]}</small></p>
                    {plan.trial_days > 0 ? <p className="land-trial">{plan.trial_days} dias grátis</p> : null}
                    <ul>
                      <li>{cap(plan.max_groups, "grupo", "grupos")}</li>
                      <li>{cap(plan.max_connections, "conexão WhatsApp", "conexões WhatsApp")}</li>
                      {benefits.map((line) => <li key={line}>{line}</li>)}
                    </ul>
                    <button type="button" className="land-btn is-primary" onClick={() => start(plan.slug)}>Começar grátis</button>
                  </article>
                );
              })}
            </div>
          </div>
        </section>
      ) : null}

      {quotes.length ? (
        <section className="land-band is-soft">
          <div className="land-wrap land-reveal">
            <div className="land-head"><h2>Quem automatiza os grupos</h2></div>
            <div className="land-cards">
              {quotes.map((item) => (
                <article key={item.id}>
                  <p>“{item.quote}”</p>
                  <strong>{item.author}</strong>
                  {item.company ? <span>{item.company}</span> : null}
                </article>
              ))}
            </div>
          </div>
        </section>
      ) : null}

      <section className="land-band" id="faq">
        <div className="land-wrap land-faq land-reveal">
          <div className="land-head"><h2>Dúvidas frequentes</h2></div>
          {faqs.map(([question, answer], index) => (
            <article key={question} className={openFaq === index ? "is-open" : ""}>
              <button type="button" aria-expanded={openFaq === index} onClick={() => setOpenFaq(openFaq === index ? -1 : index)}>
                {question}
                <span aria-hidden="true">{openFaq === index ? "−" : "+"}</span>
              </button>
              <div><p>{answer}</p></div>
            </article>
          ))}
        </div>
      </section>

      <section className="land-cta">
        <div className="land-wrap">
          <h2>Pare de procurar ofertas manualmente.</h2>
          <p>Configure seus grupos e deixe o Achadinhos cuidar da rotina de publicação.</p>
          <button type="button" className="land-btn is-primary" onClick={() => start()}>Criar minha conta grátis</button>
          <small>Leva menos de 5 minutos para começar.</small>
        </div>
      </section>

      <footer className="land-foot">
        <div className="land-wrap">
          <div className="land-foot__brand">
            <Mark />
            <div>
              <strong>Achadinhos</strong>
              <p>Automação de ofertas para afiliados.</p>
            </div>
          </div>
          <div>
            <b>Produto</b>
            <a href="#recursos">Recursos</a>
            <a href="#integracoes">Integrações</a>
            {plans.length ? <a href="#planos">Planos</a> : null}
          </div>
          <div>
            <b>Empresa</b>
            <button type="button" onClick={() => setLegal("contato")}>Contato</button>
            <button type="button" onClick={() => setLegal("termos")}>Termos de Uso</button>
            <button type="button" onClick={() => setLegal("privacidade")}>Política de Privacidade</button>
          </div>
          <div>
            <b>Conta</b>
            <button type="button" onClick={onLogin}>Entrar</button>
            <button type="button" onClick={() => start()}>Criar conta</button>
          </div>
        </div>
        {legal ? (
          <div className="land-wrap land-legal">
            <h2>{legal === "termos" ? "Termos de Uso" : legal === "privacidade" ? "Política de Privacidade" : "Contato"}</h2>
            {legal === "termos" ? (
              <p>O uso segue o plano escolhido no cadastro. O teste pode ser encerrado a qualquer momento, e a publicação automática fica limitada ao que esse plano permitir.</p>
            ) : legal === "privacidade" ? (
              <p>Cada empresa acessa somente os próprios grupos, contatos, lojas e credenciais. Esses dados não são exibidos para as outras contas da plataforma.</p>
            ) : (
              <p>O canal de contato desta instalação fica com quem liberou o seu acesso. Crie a conta para começar o teste do plano publicado.</p>
            )}
          </div>
        ) : null}
        <div className="land-wrap land-copyline">© {new Date().getFullYear()} Achadinhos. Todos os direitos reservados.</div>
      </footer>
    </div>
  );
}
