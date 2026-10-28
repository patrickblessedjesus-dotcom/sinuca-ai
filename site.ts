import { Router } from 'express';

/**
 * Site público (página inicial). Para mudar preços e textos dos planos, edite PLANS abaixo.
 */
export const PLANS = [
  {
    name: 'Mensal',
    price: 'R$ 29,90',
    period: '/mês',
    highlight: false,
    items: ['Análises ilimitadas pelo WhatsApp', 'Foto da mesa + áudio ou texto', 'Jogadas desenhadas na foto', 'Par ou Ímpar e Bolinho'],
    cta: 'Assinar mensal',
  },
  {
    name: 'Anual',
    price: 'R$ 249,90',
    period: '/ano',
    highlight: true,
    items: ['Tudo do plano mensal', 'Economia de 2 meses', 'Prioridade nas novidades', 'Acesso antecipado a novos jogos'],
    cta: 'Assinar anual',
  },
  {
    name: 'Exclusivo',
    price: 'Sob consulta',
    period: '',
    highlight: false,
    items: ['Treinador personalizado', 'Seu estilo de jogo e suas regras', 'Para clubes, torneios e criadores', 'Atendimento direto'],
    cta: 'Falar com a gente',
  },
];

/** Link dos botões (WhatsApp, checkout etc.). Configure SITE_CTA_URL no Render. */
function ctaUrl(): string {
  const u = process.env.SITE_CTA_URL?.trim();
  return u && /^https:\/\//.test(u) ? u : '#planos';
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function siteHtml(): string {
  const href = esc(ctaUrl());
  const plans = PLANS.map(
    (p) => `<div class="plan${p.highlight ? ' hi' : ''}">
${p.highlight ? '<span class="tag">Mais escolhido</span>' : ''}
<h3>${esc(p.name)}</h3>
<p class="price">${esc(p.price)}<small>${esc(p.period)}</small></p>
<ul>${p.items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>
<a class="btn${p.highlight ? '' : ' ghost'}" href="${href}">${esc(p.cta)}</a>
</div>`,
  ).join('\n');

  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sinuca AI · Seu treinador de sinuca no WhatsApp</title>
<meta name="description" content="Mande a foto da mesa e explique a situação: o Sinuca AI responde no WhatsApp com as melhores jogadas desenhadas na foto.">
<style>
:root{--felt:#0d5c3a;--felt2:#0a4a2f;--ink:#14201a;--muted:#5b6b62;--bg:#f6f8f6;--card:#fff;--gold:#e8b931;--line:#dfe6e1}
*{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:var(--ink);background:var(--bg);line-height:1.55}
a{color:inherit}.wrap{max-width:1040px;margin:0 auto;padding:0 16px}
header{background:var(--felt);color:#fff}
nav{display:flex;justify-content:space-between;align-items:center;padding:16px 0}
.logo{font-weight:800;font-size:20px;text-decoration:none}.logo span{color:var(--gold)}
nav a.small{font-size:15px;text-decoration:none;opacity:.9}
.hero{padding:48px 0 64px;display:grid;gap:32px;grid-template-columns:1.2fr 1fr;align-items:center}
.hero h1{font-size:clamp(30px,5vw,46px);line-height:1.1;margin:0 0 16px}
.hero p{font-size:18px;opacity:.92;margin:0 0 24px}
.btn{display:inline-block;background:var(--gold);color:#1b1400;font-weight:700;padding:13px 22px;border-radius:10px;text-decoration:none;text-align:center}
.btn.ghost{background:transparent;border:2px solid var(--felt);color:var(--felt)}
.phone{background:#e5ddd5;border-radius:18px;padding:16px;color:var(--ink);box-shadow:0 12px 40px rgba(0,0,0,.25)}
.bubble{background:#fff;border-radius:10px;padding:10px 12px;margin:8px 0;font-size:14px;max-width:88%}
.bubble.me{background:#d9fdd3;margin-left:auto}
section{padding:56px 0}h2{font-size:30px;margin:0 0 8px;text-align:center}.sub{text-align:center;color:var(--muted);margin:0 0 32px}
.steps{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
.step{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:20px}
.step b{display:inline-grid;place-items:center;width:32px;height:32px;border-radius:50%;background:var(--felt);color:#fff;margin-bottom:8px}
.legend span{display:inline-block;margin:0 10px 6px 0}
.plans{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;align-items:stretch}
.plan{position:relative;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:24px;display:flex;flex-direction:column}
.plan.hi{border:2px solid var(--felt);box-shadow:0 10px 30px rgba(13,92,58,.15)}
.plan h3{margin:0 0 4px}.price{font-size:30px;font-weight:800;margin:4px 0 12px}.price small{font-size:15px;font-weight:500;color:var(--muted)}
.plan ul{padding-left:18px;margin:0 0 20px;flex:1}.plan .btn{width:100%}
.plan.hi .btn{background:var(--felt);color:#fff}
.tag{position:absolute;top:-12px;left:24px;background:var(--gold);font-size:12px;font-weight:700;padding:3px 10px;border-radius:20px}
footer{background:var(--felt2);color:#d6e5dc;padding:28px 0;font-size:14px}
footer .wrap{display:flex;flex-wrap:wrap;gap:12px 24px;justify-content:space-between}
@media(max-width:760px){.hero,.steps,.plans{grid-template-columns:1fr}.hero{padding:24px 0 48px}}
</style></head><body>
<header><div class="wrap">
<nav><a class="logo" href="/">Sinuca <span>AI</span> 🎱</a><a class="small" href="#planos">Planos</a></nav>
<div class="hero">
<div><h1>Seu treinador de sinuca no WhatsApp</h1>
<p>Mande a foto da mesa e conte a situação por áudio ou texto. Em segundos você recebe as melhores jogadas, com o efeito, onde a branca para e o porquê, desenhadas em cima da sua foto.</p>
<a class="btn" href="#planos">Ver planos</a></div>
<div class="phone">
<div class="bubble me">📷 Foto da mesa</div>
<div class="bubble me">🎤 "Par ou ímpar, tenho 3 bolas, ele tem 2. Ataco ou defendo?"</div>
<div class="bubble">🟢 <b>Jogada 1 · tranquila</b>: bola 4 na caçapa 2, com efeito embaixo. A branca para no meio da mesa.<br>🟡 <b>Jogada 2 · atenção</b>…<br>🎓 <b>Por quê:</b> você arma a próxima e não deixa nada pro adversário.</div>
</div></div></div></header>

<section><div class="wrap">
<h2>Como funciona</h2><p class="sub">Simples como mandar mensagem pra um amigo que joga muito.</p>
<div class="steps">
<div class="step"><b>1</b><h3>Tire a foto</h3><p>De cima, pegando a mesa inteira.</p></div>
<div class="step"><b>2</b><h3>Explique a situação</h3><p>Por áudio ou texto: qual o jogo, quantas bolas cada um tem e o que você está pensando.</p></div>
<div class="step"><b>3</b><h3>Receba as jogadas</h3><p>Até 3 opções desenhadas na foto, com as caçapas numeradas de 1 a 6.</p>
<p class="legend"><span>🟢 tranquila</span><span>🟡 atenção</span><span>🔴 arriscada</span></p></div>
</div></div></section>

<section id="planos" style="background:#eef3ef"><div class="wrap">
<h2>Planos</h2><p class="sub">Escolha como quer treinar.</p>
<div class="plans">
${plans}
</div></div></section>

<footer><div class="wrap">
<span>© ${new Date().getFullYear()} Sinuca AI</span>
<span><a href="/privacidade">Política de Privacidade</a> · <a href="/exclusao-de-dados">Exclusão de dados</a></span>
</div></footer>
</body></html>`;
}

export function createSiteRouter(): Router {
  const router = Router();
  router.get('/', (_req, res) => {
    res.type('html').send(siteHtml());
  });
  return router;
}
