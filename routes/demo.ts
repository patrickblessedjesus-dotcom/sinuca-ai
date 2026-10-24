import { timingSafeEqual } from 'node:crypto';
import express, { Router } from 'express';
import { MediaError, validateImage } from '../services/media.js';
import type { Coach } from '../services/sinucaCoach.js';
import { errorInfo, logger } from '../utils/logger.js';

export interface DemoOptions {
  code: string;
  coach: Coach;
  /** Máximo de análises por hora (protege os créditos da OpenAI). */
  maxPerHour?: number;
}

const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const AUDIO_EXT: Record<string, string> = { webm: 'webm', ogg: 'ogg', mp4: 'mp4', 'x-m4a': 'm4a', m4a: 'm4a', mpeg: 'mp3', mp3: 'mp3', wav: 'wav', 'x-wav': 'wav', aac: 'm4a' };

function sameCode(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Página web de demonstração: tira/escolhe a foto no celular e recebe a análise. */
export function createDemoRouter(opts: DemoOptions): Router {
  const router = Router();
  const maxPerHour = opts.maxPerHour ?? 60;
  let windowStart = Date.now();
  let count = 0;

  router.get('/demo', (_req, res) => {
    res.type('html').send(DEMO_HTML);
  });

  router.post('/demo/ask', express.json({ limit: '16kb' }), async (req, res) => {
    const code = req.get('x-demo-code') ?? '';
    if (!sameCode(code, opts.code)) {
      res.status(401).json({ error: 'Código de acesso inválido.' });
      return;
    }
    if (Date.now() - windowStart > 3_600_000) {
      windowStart = Date.now();
      count = 0;
    }
    if (++count > maxPerHour) {
      res.status(429).json({ error: 'Limite de perguntas por hora atingido. Tente mais tarde.' });
      return;
    }
    const q = (req.body as { question?: unknown } | undefined)?.question;
    if (typeof q !== 'string' || !q.trim() || q.length > 1000 || !opts.coach.ask) {
      res.status(400).json({ error: 'Escreva uma pergunta (até 1000 caracteres).' });
      return;
    }
    const started = Date.now();
    try {
      const text = await opts.coach.ask(q);
      logger.info('Pergunta da demo respondida', { ms: Date.now() - started });
      res.json({ text });
    } catch (err) {
      logger.error('Falha na pergunta da demo', { ms: Date.now() - started, ...errorInfo(err) });
      res.status(502).json({ error: 'Não consegui responder agora. Tenta de novo.' });
    }
  });

  router.post('/demo/analyze', express.json({ limit: '20mb' }), async (req, res) => {
    const code = req.get('x-demo-code') ?? '';
    if (!sameCode(code, opts.code)) {
      res.status(401).json({ error: 'Código de acesso inválido.' });
      return;
    }

    if (Date.now() - windowStart > 3_600_000) {
      windowStart = Date.now();
      count = 0;
    }
    if (++count > maxPerHour) {
      res.status(429).json({ error: 'Limite de análises por hora atingido. Tente mais tarde.' });
      return;
    }

    const body = (req.body ?? {}) as { image?: unknown; situation?: unknown; audio?: unknown };
    const match = typeof body.image === 'string' ? /^data:image\/[a-z+]+;base64,([A-Za-z0-9+/=]+)$/.exec(body.image) : null;
    if (!match) {
      res.status(400).json({ error: 'Envie uma foto.' });
      return;
    }
    let situation = typeof body.situation === 'string' ? body.situation.trim().slice(0, 2000) : '';
    const audioMatch = typeof body.audio === 'string' ? /^data:audio\/([a-z0-9.+-]+)(?:;[^,]*)?;base64,([A-Za-z0-9+/=]+)$/.exec(body.audio) : null;

    const started = Date.now();
    try {
      let heard = '';
      if (audioMatch) {
        if (!opts.coach.transcribe) throw new MediaError('Áudio não suportado.');
        const audioBytes = new Uint8Array(Buffer.from(audioMatch[2], 'base64'));
        if (audioBytes.length > MAX_AUDIO_BYTES) throw new MediaError('Áudio grande demais (máx. ~2 min).');
        const ext = AUDIO_EXT[audioMatch[1]] ?? 'webm';
        heard = await opts.coach.transcribe(audioBytes, `situacao.${ext}`);
        situation = [heard, situation].filter(Boolean).join('\n');
      }
      const bytes = new Uint8Array(Buffer.from(match[1], 'base64'));
      const mime = validateImage(bytes);
      let text: string;
      let diagram: unknown = null;
      if (opts.coach.plan) {
        const plan = await opts.coach.plan(bytes, mime, situation || undefined);
        text = plan.text;
        diagram = plan.diagram;
      } else {
        text = await opts.coach.analyze(bytes, mime, situation || undefined);
      }
      logger.info('Análise da demo concluída', { ms: Date.now() - started, bytes: bytes.length, situation: Boolean(situation), audio: Boolean(audioMatch), diagram: Boolean(diagram) });
      res.json({ text, heard, diagram });
    } catch (err) {
      logger.error('Falha na análise da demo', { ms: Date.now() - started, ...errorInfo(err) });
      const msg = err instanceof MediaError ? err.message : 'Não consegui analisar agora. Tenta de novo, com a mesa inteira e as bolas bem visíveis.';
      res.status(err instanceof MediaError ? 400 : 502).json({ error: msg });
    }
  });

  return router;
}

const DEMO_HTML = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sinuca AI</title>
<style>
  :root { --bg:#0b3d2e; --card:#0f4d3a; --fg:#f4f1e8; --muted:#b9d3c6; --accent:#f2c14e; }
  * { box-sizing: border-box; }
  body { margin:0; font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; background: var(--bg); color: var(--fg); }
  main { max-width: 520px; margin: 0 auto; padding: 24px 16px 48px; }
  h1 { font-size: 28px; margin: 8px 0 4px; }
  p.sub { color: var(--muted); margin: 0 0 20px; }
  .card { background: var(--card); border-radius: 16px; padding: 16px; margin-bottom: 16px; }
  label { display:block; font-size: 14px; color: var(--muted); margin-bottom: 6px; }
  textarea { width:100%; padding: 12px; border-radius: 10px; border: 1px solid #2f6b55; background:#0b3d2e; color: var(--fg); font-size:16px; font-family: inherit; resize: vertical; }
  input[type=password] { width:100%; padding: 12px; border-radius: 10px; border: 1px solid #2f6b55; background:#0b3d2e; color: var(--fg); font-size:16px; }
  .btn { display:block; width:100%; text-align:center; padding: 16px; border-radius: 12px; border: 0; font-size: 18px; font-weight: 700; background: var(--accent); color: #1d1d1d; cursor: pointer; }
  .btn[disabled] { opacity: .6; }
  #preview { width:100%; border-radius: 12px; margin-top: 12px; display:none; }
  #result { white-space: pre-wrap; line-height: 1.5; font-size: 16px; }
  .err { color: #ffb4a8; }
  .hidden { display:none; }
  .btn.ghost { background: transparent; color: var(--fg); border: 2px solid var(--accent); }
  .btn.ghost.on { background: #c0392b; border-color: #c0392b; }
  .muted { color: var(--muted); font-size: 14px; margin-top: 8px; }
  #diagram { margin-bottom: 14px; }
  #diagram svg { width: 100%; max-width: 360px; display: block; margin: 0 auto; }
  .legend { display: flex; gap: 10px; flex-wrap: wrap; justify-content: center; font-size: 14px; margin-top: 8px; }
  .legend span { white-space: nowrap; }
</style>
</head>
<body>
<main>
  <h1>🎱 Sinuca AI</h1>
  <p class="sub">Tire a foto da mesa, explique a situação por áudio ou texto e receba 3 jogadas com a chance estimada de cada uma. Ou pergunte uma regra.</p>

  <div class="card" id="codeBox">
    <label for="code">Código de acesso</label>
    <input id="code" type="password" autocomplete="off" placeholder="Digite o código">
  </div>

  <div class="card">
    <label>1. Foto da mesa (padrão: caçapas de baixo 1 e 2, do meio 3 e 4, de cima 5 e 6)</label>
    <input id="file" type="file" accept="image/*" capture="environment" class="hidden">
    <button class="btn" id="pick">📸 Tirar foto da mesa</button>
    <img id="preview" alt="Foto da mesa">
  </div>

  <div class="card">
    <label for="sit">2. Explique a situação (fale ou escreva)</label>
    <button class="btn ghost" id="rec">🎤 Gravar áudio</button>
    <div id="recInfo" class="muted hidden"></div>
    <textarea id="sit" rows="3" maxlength="2000" style="margin-top:10px" placeholder="Ex.: Par ou ímpar. Tenho 1 bola par, ele tem 2 ímpar. Tô pensando em matar a 4 na caçapa 3."></textarea>
    <button class="btn" id="go" style="margin-top:10px">🎯 Analisar jogada</button>
  </div>

  <div class="card">
    <label for="q">Ou só pergunte algo de sinuca</label>
    <textarea id="q" rows="3" maxlength="1000" placeholder="Ex.: Como funciona o par ou ímpar na regra suja?"></textarea>
    <button class="btn" id="askBtn" style="margin-top:10px">💬 Perguntar</button>
  </div>

  <div class="card hidden" id="out">
    <div id="diagram" class="hidden"></div>
    <div id="result"></div>
  </div>
</main>
<script>
  const $ = (id) => document.getElementById(id);
  const store = { get(k){ try { return localStorage.getItem(k); } catch { return null; } }, set(k,v){ try { localStorage.setItem(k,v); } catch {} } };
  const saved = store.get('sinuca_code'); if (saved) { $('code').value = saved; }

  $('pick').onclick = () => $('file').click();

  $('askBtn').onclick = async () => {
    const q = $('q').value.trim(); if (!q) return;
    const code = $('code').value.trim();
    if (!code) { show('Digite o código de acesso primeiro.', true); return; }
    store.set('sinuca_code', code);
    $('askBtn').disabled = true; $('askBtn').textContent = 'Pensando… 🎱';
    drawDiagram(null);
    show('Pensando na resposta…', false);
    try {
      const r = await fetch('/demo/ask', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-demo-code': code }, body: JSON.stringify({ question: q }) });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || 'Erro ao responder.');
      show(data.text, false);
    } catch (e) {
      show(e.message || 'Erro ao responder.', true);
    } finally {
      $('askBtn').disabled = false; $('askBtn').textContent = '💬 Perguntar';
    }
  };

  function resize(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const max = 1600; let w = img.naturalWidth, h = img.naturalHeight;
        const s = Math.min(1, max / Math.max(w, h)); w = Math.round(w * s); h = Math.round(h * s);
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(img.src);
        resolve(c.toDataURL('image/jpeg', 0.85));
      };
      img.onerror = () => reject(new Error('Não consegui abrir essa imagem.'));
      img.src = URL.createObjectURL(file);
    });
  }

  function esc(t) { return String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  const COLORS = { verde: '#2ecc71', amarelo: '#f1c40f', vermelho: '#e74c3c' };
  const BALL = { par: '#3498db', impar: '#e67e22', as: '#f4f1e8', outra: '#95a5a6' };
  function drawDiagram(d) {
    const box = $('diagram');
    if (!d || !d.plays || !d.plays.length) { box.classList.add('hidden'); box.innerHTML = ''; return; }
    const W = 200, H = 400, P = 16; // mesa em pé
    const X = (x) => P + x * (W - 2 * P), Y = (y) => H - P - y * (H - 2 * P);
    const pockets = [[0,0,1],[1,0,2],[0,0.5,3],[1,0.5,4],[0,1,5],[1,1,6]];
    let svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Esquema da mesa">';
    svg += '<rect x="2" y="2" width="' + (W-4) + '" height="' + (H-4) + '" rx="12" fill="#5b3a1e"/>';
    svg += '<rect x="' + P + '" y="' + P + '" width="' + (W-2*P) + '" height="' + (H-2*P) + '" fill="#127a4a"/>';
    pockets.forEach(([x, y, n]) => {
      svg += '<circle cx="' + X(x) + '" cy="' + Y(y) + '" r="9" fill="#111"/>';
      const lx = x === 0 ? X(x) + 16 : X(x) - 16, ly = y === 0 ? Y(y) - 12 : y === 1 ? Y(y) + 20 : Y(y) + 5;
      svg += '<text x="' + lx + '" y="' + ly + '" fill="#fff" font-size="13" font-weight="700" text-anchor="middle">' + n + '</text>';
    });
    const labels = [];
    d.plays.slice().reverse().forEach((pl, iRev) => {
      const i = d.plays.length - 1 - iRev;
      const pts = pl.path.map((p) => X(p.x) + ',' + Y(p.y)).join(' ');
      const c = COLORS[pl.level] || '#fff';
      svg += '<polyline points="' + pts + '" fill="none" stroke="' + c + '" stroke-width="3" stroke-linejoin="round" stroke-linecap="round" stroke-dasharray="' + (i === 0 ? '0' : '6 4') + '" opacity="0.95"/>';
      const last = pl.path[pl.path.length - 1];
      svg += '<circle cx="' + X(last.x) + '" cy="' + Y(last.y) + '" r="4" fill="' + c + '"/>';
      labels.push({ i, c, pl });
    });
    // Selos de %: no meio do último trecho de cada traçado, afastados entre si
    const placed = [];
    labels.sort((a, b) => a.i - b.i).forEach(({ i, c, pl }) => {
      const a = pl.path[pl.path.length - 2], b = pl.path[pl.path.length - 1];
      let lx = Math.min(W - 26, Math.max(26, X(a.x + (b.x - a.x) * 0.55)));
      let ly = Math.min(H - 12, Math.max(24, Y(a.y + (b.y - a.y) * 0.55)));
      for (let k = 0; k < 6 && placed.some((p) => Math.abs(p.x - lx) < 44 && Math.abs(p.y - ly) < 18); k++) ly += 20;
      placed.push({ x: lx, y: ly });
      svg += '<rect x="' + (lx - 22) + '" y="' + (ly - 12) + '" width="44" height="17" rx="8" fill="' + c + '" stroke="#111" stroke-width="0.5"/>';
      svg += '<text x="' + lx + '" y="' + (ly + 1) + '" fill="#111" font-size="11" font-weight="700" text-anchor="middle">' + (i + 1) + ' · ' + pl.chance + '%</text>';
    });
    (d.balls || []).forEach((b) => {
      svg += '<circle cx="' + X(b.x) + '" cy="' + Y(b.y) + '" r="7" fill="' + (BALL[b.group] || BALL.outra) + '" stroke="#111" stroke-width="1"/>';
      svg += '<text x="' + X(b.x) + '" y="' + (Y(b.y) + 3.5) + '" fill="#111" font-size="8" font-weight="700" text-anchor="middle">' + esc(b.label) + '</text>';
    });
    if (d.cue) svg += '<circle cx="' + X(d.cue.x) + '" cy="' + Y(d.cue.y) + '" r="7" fill="#fff" stroke="#111" stroke-width="1.5"/>';
    svg += '</svg>';
    const names = { verde: '🟢', amarelo: '🟡', vermelho: '🔴' };
    let legend = '<div class="legend">' + d.plays.map((pl, i) => '<span>' + (names[pl.level] || '') + ' ' + (i + 1) + ') ' + esc(pl.name) + ' — ' + pl.chance + '%</span>').join('') + '</div>';
    legend += '<div class="muted" style="text-align:center">⚪ branca · 🔵 par · 🟠 ímpar · Ás em bege. Esquema aproximado, feito a partir da foto.</div>';
    box.innerHTML = svg + legend;
    box.classList.remove('hidden');
  }

  function show(text, isErr) {
    $('out').classList.remove('hidden');
    $('result').className = isErr ? 'err' : '';
    $('result').textContent = text;
  }

  let photo = null;
  $('file').onchange = async () => {
    const file = $('file').files[0]; if (!file) return;
    try {
      photo = await resize(file);
      $('preview').src = photo; $('preview').style.display = 'block';
      $('pick').textContent = '📸 Trocar foto';
    } catch (e) { show(e.message, true); }
    $('file').value = '';
  };

  // Gravação de áudio (opcional)
  let rec = null, chunks = [], audio = null;
  const blobToDataUrl = (b) => new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = no; r.readAsDataURL(b); });
  $('rec').onclick = async () => {
    if (rec && rec.state === 'recording') { rec.stop(); return; }
    if (!navigator.mediaDevices || !window.MediaRecorder) { show('Seu navegador não grava áudio aqui. Escreva a situação.', true); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      chunks = []; audio = null;
      rec = new MediaRecorder(stream);
      rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
        audio = await blobToDataUrl(blob);
        $('rec').classList.remove('on'); $('rec').textContent = '🎤 Gravar de novo';
        $('recInfo').textContent = '✅ Áudio gravado (' + Math.round(blob.size / 1024) + ' KB). Vai junto com a foto.';
        $('recInfo').classList.remove('hidden');
      };
      rec.start();
      $('rec').classList.add('on'); $('rec').textContent = '⏹️ Parar gravação';
      $('recInfo').classList.add('hidden');
      setTimeout(() => { if (rec && rec.state === 'recording') rec.stop(); }, 120000);
    } catch (e) { show('Não consegui acessar o microfone. Escreva a situação.', true); }
  };

  $('go').onclick = async () => {
    const code = $('code').value.trim();
    if (!code) { show('Digite o código de acesso primeiro.', true); return; }
    if (!photo) { show('Tire a foto da mesa primeiro.', true); return; }
    store.set('sinuca_code', code);
    $('go').disabled = true; $('go').textContent = 'Analisando… 🎱';
    drawDiagram(null);
    show(audio ? 'Ouvindo o áudio e analisando a mesa…' : 'Analisando a mesa…', false);
    try {
      const r = await fetch('/demo/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-demo-code': code }, body: JSON.stringify({ image: photo, situation: $('sit').value.trim(), audio }) });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || 'Erro ao analisar.');
      show((data.heard ? '🗣️ Entendi: "' + data.heard + '"\\n\\n' : '') + data.text, false);
      drawDiagram(data.diagram);
    } catch (e) {
      show(e.message || 'Erro ao analisar.', true);
    } finally {
      $('go').disabled = false; $('go').textContent = '🎯 Analisar jogada';
    }
  };
</script>
</body>
</html>`;
