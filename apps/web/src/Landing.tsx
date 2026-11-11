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
/** WhatsApp de contato e suporte (botão flutuante e "Contato" do rodapé). Para trocar o número, é só aqui. */
const SUPPORT_WHATSAPP = "5519997339377";
const supportLink = (text: string) => `https://wa.me/${SUPPORT_WHATSAPP}?text=${encodeURIComponent(text)}`;
const SALES_TEXT = "Olá! Vim pelo site do Achadinhos e quero saber mais.";
const linesOf = (value: string) => value.split("\n").map((line) => line.trim()).filter(Boolean);
const cap = (value: number | null, one: string, many: string) => (value == null ? `${many} sem limite` : value === 1 ? `1 ${one}` : `${value} ${many}`);

const stores = [
  ["ml", "Mercado Livre", true],
  ["amazon", "Amazon", true],
  ["shopee", "Shopee", true],
  ["magalu", "Magalu", true],
  ["aliexpress", "AliExpress", false],
  ["awin", "Casas Bahia, Natura e +", false],
  ["rakuten", "Rakuten", false],
  ["epoca", "Época Cosméticos", false]
] as const;

const faqs = [
  ["Preciso deixar o computador ou o celular ligado?", "Não. O robô roda nos nossos servidores, 24 horas por dia. Você configura uma vez e acompanha pelo painel quando quiser, até pelo celular."],
  ["A comissão é minha mesmo?", "Sim. Cada oferta sai com o seu código de afiliado (a sua etiqueta do Mercado Livre, a sua tag da Amazon, a sua conta da Shopee e a sua loja do Magalu). A comissão cai direto na sua conta de cada loja."],
  ["Quais lojas posso usar?", "Mercado Livre, Amazon, Shopee e Magalu já estão liberadas. AliExpress, Casas Bahia, Natura, Rakuten e Época Cosméticos estão em fase final de testes e chegam em breve."],
  ["O preço publicado é confiável?", "No Mercado Livre o robô usa a API oficial e confere o preço do anúncio no momento do envio: se o desconto acabou, a oferta não sai. Só publicamos produto com preço antigo maior que o atual."],
  ["Posso publicar no Status do WhatsApp e no Telegram?", "Sim. Além dos grupos, o Achadinhos publica no Status do WhatsApp e em grupos e canais do Telegram, cada um com o próprio ritmo e as próprias lojas."],
  ["Vai repetir sempre as mesmas ofertas?", "Não. O mesmo produto (ou uma variação dele) não volta ao mesmo grupo por 72 horas, e o robô intercala os tipos de produto para não mandar três air fryers seguidas."],
  ["Corro risco de ter o número bloqueado?", "Você controla o ritmo de cada loja, quantas ofertas por vez e os horários. Se o número for removido de um grupo, o robô desliga aquele grupo sozinho. Recomendamos usar um número só para o robô e grupos que aceitam divulgação."],
  ["Como funciona o teste grátis e o pagamento?", "A conta começa com dias grátis no plano escolhido, sem pagar nada. Depois, você paga por Pix (mensal, trimestral, semestral ou anual) e a liberação é na hora. Dá para trocar de plano na própria tela de pagamento."],
  ["Posso cancelar quando quiser?", "Sim. Não há fidelidade nem multa: é só não renovar."]
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
  const trialDays = Math.max(0, ...plans.map((plan) => Number(plan.trial_days) || 0));
  // Desconto do anual frente a 12 mensalidades, para destacar no card do plano.
  const yearlySaving = (plan: Plan) => {
    if (!plan.monthly_cents || !plan.yearly_cents) return 0;
    const saving = Math.round((1 - plan.yearly_cents / (plan.monthly_cents * 12)) * 100);
    return saving >= 5 ? saving : 0;
  };
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
            <p className="land-kicker">Robô de ofertas para afiliados</p>
            <h1>Seus grupos de ofertas publicando sozinhos, 24 horas por dia.</h1>
            <p>O Achadinhos garimpa promoções com desconto de verdade no Mercado Livre, na Amazon, na Shopee e no Magalu, coloca o seu link de afiliado e publica nos seus grupos do WhatsApp, no Status e no Telegram. Você só acompanha as comissões.</p>
            <div className="land-actions">
              <button type="button" className="land-btn is-primary" onClick={() => start()}>{trialDays ? `Testar ${trialDays} dias grátis` : "Começar agora"}</button>
              <a className="land-btn is-ghost" href="#como">Ver como funciona</a>
            </div>
            <ul className="land-checks">
              <li><Icon d={icons.check} />{trialDays ? `${trialDays} dias grátis` : "Teste grátis"}</li>
              <li><Icon d={icons.check} />Sem cartão: pague por Pix depois</li>
              <li><Icon d={icons.check} />Sem fidelidade</li>
            </ul>
          </div>
          <div className="land-stage" aria-hidden="true">
            <div className="land-mock">
              <header>
                <strong>Achadinhos</strong>
                <span><i />Automação ativa</span>
              </header>
              <div className="land-mock__stats">
                <article><small>Ofertas enviadas hoje</small><b>1.086</b></article>
                <article><small>Cliques nos links</small><b>3.412</b></article>
                <article><small>Grupos ativos</small><b>24</b></article>
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
            <div className="land-toast"><Icon d={icons.check} />Preço conferido · oferta enviada para 24 grupos</div>
          </div>
        </div>
      </section>

      <section className="land-proof">
        <div className="land-wrap">
          {[
            [icons.clock, "24 horas por dia", "Sem PC nem celular ligado"],
            [icons.check, "Desconto de verdade", "Preço conferido na hora do envio"],
            [icons.chat, "Grupos, Status e Telegram", "Tudo no mesmo robô"],
            [icons.shield, "Sua comissão", "Seu link de afiliado em cada oferta"]
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
            <h2>Em 5 minutos o seu grupo começa a publicar sozinho.</h2>
            <p>Sem programar, sem planilha e sem ficar copiando link.</p>
          </div>
          <div className="land-steps">
            {[
              [icons.store, "Conecte suas lojas", "Cole o seu código de afiliado do Mercado Livre, Amazon, Shopee ou Magalu. O guia passo a passo está dentro do painel."],
              [icons.chat, "Conecte o WhatsApp", "Leia o QR code com o celular, como no WhatsApp Web. Telegram também."],
              [icons.filter, "Escolha grupos e ritmo", "Marque os grupos, os horários e de quanto em quanto tempo cada loja publica."],
              [icons.clock2, "Pronto", "O robô garimpa, confere o preço, monta a mensagem com foto e publica sozinho."]
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
            <h2>Feito para quem vive de grupo de ofertas</h2>
            <p>Cada detalhe foi pensado para o seu grupo vender mais e cansar menos.</p>
          </div>
          <div className="land-cards">
            {[
              [icons.check, "Só desconto de verdade", "Publica só o que tem preço antigo maior que o atual, conferido no Mercado Livre na hora do envio."],
              [icons.store, "Milhares de produtos", "Os mais vendidos de centenas de categorias do Mercado Livre pela API oficial, mais as promoções da Amazon, Shopee e Magalu."],
              [icons.chat, "Grupos, Status e Telegram", "Publique nos grupos do WhatsApp, no Status para os seus contatos e no Telegram, cada um no seu ritmo."],
              [icons.repeat, "Sem repetição e sem monotonia", "O mesmo produto não volta ao grupo por 72 h, e o robô intercala os tipos de produto."],
              [icons.shield, "Proteção do seu número", "Ritmo e horários por loja, e o grupo que remove o número é desligado sozinho."],
              [icons.chart, "Cliques medidos", "Veja quantas pessoas clicaram em cada oferta e quais lojas dão mais resultado."]
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
            <h2>As maiores lojas do Brasil, com o seu link de afiliado</h2>
            <p>Cada empresa usa as próprias contas: a comissão de cada venda é sua.</p>
          </div>
          <div className="land-stores">
            {stores.map(([id, name, live]) => (
              <article key={id} className={live ? "" : "is-soon"}>
                <img src={`/deals-logos/${id}.svg`} alt="" />
                <div>
                  <strong>{name}</strong>
                  <span>{live ? "Disponível" : "Em breve"}</span>
                </div>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="land-spot">
        <div className="land-wrap land-split land-reveal">
          <div className="land-board" aria-hidden="true">
            <header><strong>Painel</strong><span>Hoje</span></header>
            <div className="land-board__row"><i className="is-on" />WhatsApp conectado<small>24 grupos · 2 números</small></div>
            <div className="land-board__row"><i className="is-on" />Mercado Livre<small>612 ofertas hoje</small></div>
            <div className="land-board__row"><i className="is-on" />Status do WhatsApp<small>96 publicações</small></div>
            <div className="land-board__row"><i className="is-on" />Amazon<small>184 ofertas hoje</small></div>
            <div className="land-board__row"><i className="is-on" />Shopee<small>142 ofertas hoje</small></div>
            <div className="land-board__bars"><span style={{ height: "46%" }} /><span style={{ height: "72%" }} /><span style={{ height: "58%" }} /><span style={{ height: "88%" }} /><span style={{ height: "64%" }} /></div>
          </div>
          <div>
            <h2>Você no controle, sem trabalho manual</h2>
            <p>Acompanhe tudo de um painel só, inclusive pelo celular: o que saiu, para onde foi, quantos cliques deu e quando sai o próximo lote.</p>
            <ul className="land-list">
              {["Conexões e grupos", "Ritmo e horário por loja", "Histórico de publicações", "Cliques por oferta", "Guia passo a passo de cada loja"].map((item) => (
                <li key={item}><Icon d={icons.check} />{item}</li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      <section className="land-band is-soft">
        <div className="land-wrap land-reveal">
          <div className="land-head">
            <h2>Garimpar na mão ou deixar o robô trabalhar?</h2>
          </div>
          <div className="land-cards land-compare">
            <article>
              <h3>Na mão</h3>
              <ul className="land-list">
                {["Horas por dia procurando promoção", "Copiar link, montar texto, achar foto", "Oferta que já acabou quando você posta", "Grupo parado quando você dorme ou trabalha", "Sempre os mesmos produtos"].map((item) => <li key={item}>✕ {item}</li>)}
              </ul>
            </article>
            <article className="is-good">
              <h3>Com o Achadinhos</h3>
              <ul className="land-list">
                {["Ofertas novas o dia todo, sozinho", "Mensagem pronta com foto, preço e seu link", "Preço conferido na hora do envio", "Grupo ativo 24 horas por dia", "Milhares de produtos, sem repetir em 72 h"].map((item) => <li key={item}><Icon d={icons.check} />{item}</li>)}
              </ul>
            </article>
          </div>
        </div>
      </section>

      {plansReady && plans.length ? (
        <section className="land-band" id="planos">
          <div className="land-wrap land-reveal">
            <div className="land-head">
              <h2>Comece grátis. Escolha o plano depois.</h2>
              <p>{trialDays ? `${trialDays} dias grátis em qualquer plano. ` : ""}Depois, pague por Pix com liberação na hora, e troque de plano quando quiser.</p>
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
                    {yearlySaving(plan) ? <p className="land-trial">ou {money(plan.yearly_cents)}/ano, economize {yearlySaving(plan)}%</p> : null}
                    <ul>
                      <li>{cap(plan.max_groups, "grupo", "grupos")}</li>
                      <li>{cap(plan.max_connections, "conexão WhatsApp", "conexões WhatsApp")}</li>
                      {benefits.map((line) => <li key={line}>{line}</li>)}
                    </ul>
                    <button type="button" className="land-btn is-primary" onClick={() => start(plan.slug)}>{plan.trial_days > 0 ? `Testar ${plan.trial_days} dias grátis` : "Assinar"}</button>
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
          <h2>Pare de garimpar oferta na mão.</h2>
          <p>Enquanto você trabalha, dorme ou descansa, o Achadinhos mantém os seus grupos vivos e com o seu link em cada oferta.</p>
          <button type="button" className="land-btn is-primary" onClick={() => start()}>{trialDays ? `Começar meus ${trialDays} dias grátis` : "Criar minha conta"}</button>
          <small>Leva menos de 5 minutos. Sem cartão e sem fidelidade.</small>
        </div>
      </section>

      <footer className="land-foot">
        <div className="land-wrap">
          <div className="land-foot__brand">
            <Mark />
            <div>
              <strong>Achadinhos</strong>
              <p>Robô de ofertas para afiliados: Mercado Livre, Amazon, Shopee e Magalu.</p>
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
            <a href={supportLink(SALES_TEXT)} target="_blank" rel="noopener noreferrer">Contato pelo WhatsApp</a>
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
              <p>O uso segue o plano contratado. O teste grátis pode ser encerrado a qualquer momento; depois dele, a assinatura é paga por Pix e renovada só se você pagar o próximo período. Os limites de grupos, conexões e usuários são os do plano. Você é responsável pelas regras de cada grupo e das lojas de afiliados.</p>
            ) : legal === "privacidade" ? (
              <p>Cada empresa acessa somente os próprios grupos, contatos, lojas e credenciais. Esses dados não são exibidos para as outras contas da plataforma.</p>
            ) : (
              <p>Fale com a gente pelo WhatsApp: <a href={supportLink(SALES_TEXT)} target="_blank" rel="noopener noreferrer">(19) 99733-9377</a>.</p>
            )}
          </div>
        ) : null}
        <div className="land-wrap land-copyline">© {new Date().getFullYear()} Achadinhos. Todos os direitos reservados.</div>
      </footer>
      <a className="land-whats" href={supportLink(SALES_TEXT)} target="_blank" rel="noopener noreferrer" aria-label="Falar no WhatsApp">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2Zm0 18.2a8.2 8.2 0 0 1-4.2-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2Zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8s-.4-.1-.6.1-.7.8-.8 1-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.3-.4.2-.4.7-1.3.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.2 5.2 5.2 0 0 0 1.1 2.8 11.9 11.9 0 0 0 4.6 4c1.7.7 2.4.8 3.2.7a2.8 2.8 0 0 0 1.8-1.3 2.3 2.3 0 0 0 .2-1.3c-.1-.1-.2-.2-.4-.3Z" /></svg>
        <span>Fale com a gente</span>
      </a>
    </div>
  );
}
