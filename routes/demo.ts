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
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Sinuca AI</title>
<style>
  :root { --bg:#0b141a; --top:#1f2c33; --in:#202c33; --out:#005c4b; --fg:#e9edef; --muted:#8696a0; --accent:#00a884; --bar:#1f2c33; }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body { margin:0; font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; background: var(--bg); color: var(--fg); display:flex; flex-direction:column; }
  header { background: var(--top); padding: 12px 16px; display:flex; align-items:center; gap:10px; }
  header .av { width:36px; height:36px; border-radius:50%; background:#127a4a; display:grid; place-items:center; font-size:20px; }
  header b { display:block; font-size:16px; }
  header small { color: var(--muted); font-size:12px; }
  #code { margin-left:auto; width:110px; padding:6px 8px; border-radius:8px; border:1px solid #2a3942; background:#111b21; color:var(--fg); font-size:14px; }
  #chat { flex:1; overflow-y:auto; padding: 12px 10px 16px; display:flex; flex-direction:column; gap:8px; }
  .msg { max-width: 88%; padding: 8px 10px; border-radius: 10px; line-height: 1.45; font-size: 15px; white-space: pre-wrap; word-wrap: break-word; }
  .in { background: var(--in); align-self:flex-start; border-top-left-radius: 2px; }
  .out { background: var(--out); align-self:flex-end; border-top-right-radius: 2px; }
  .msg img.photo { display:block; max-width: 220px; width:100%; border-radius: 8px; margin-bottom: 6px; }
  .msg audio { display:block; width: 220px; margin-bottom: 6px; }
  .heard { color: #cfe9e3; font-style: italic; }
  .err { color: #ffb4a8; }
  .typing { color: var(--muted); font-style: italic; }
  .diagram svg { width: 100%; max-width: 210px; display:block; margin: 0 auto 6px; }
  .legend { font-size: 14px; margin: 4px 0 8px; display:flex; flex-direction:column; gap:2px; }
  .note { color: var(--muted); font-size: 12px; margin-bottom: 8px; }
  footer { background: var(--bar); padding: 8px; padding-bottom: max(8px, env(safe-area-inset-bottom)); }
  #attach { display:none; align-items:center; gap:8px; margin: 0 4px 8px; color: var(--muted); font-size: 13px; }
  #attach img { width: 52px; height: 52px; object-fit: cover; border-radius: 6px; }
  #attach .x { margin-left:auto; background:none; border:0; color:var(--muted); font-size:20px; }
  .row { display:flex; align-items:flex-end; gap:6px; }
  .ico { flex: 0 0 auto; width:44px; height:44px; border-radius:50%; border:0; background: transparent; color: var(--muted); font-size: 22px; }
  #send { background: var(--accent); color: #fff; }
  #send.rec { background: #e53935; }
  #text { flex:1; min-height:44px; max-height:120px; padding: 11px 14px; border-radius: 22px; border:0; background: #2a3942; color: var(--fg); font-size: 16px; font-family: inherit; resize:none; }
  #recbar { display:none; flex:1; align-items:center; gap:8px; padding: 0 14px; height:44px; border-radius:22px; background:#2a3942; color:#ff8a80; font-size:15px; }
  .hidden { display:none !important; }
</style>
</head>
<body>
<header>
  <div class="av">🎱</div>
  <div><b>Sinuca AI</b><small>treinador · versão de testes</small></div>
  <input id="code" type="password" autocomplete="off" placeholder="código">
</header>

<div id="chat">
  <div class="msg in">Fala! 🎱 Manda a <b>foto da mesa</b> (de cima, mesa inteira) e, junto, um <b>áudio</b> ou texto contando a situação. Ex.: "par ou ímpar, tenho uma par, ele duas ímpar, tô pensando em matar a 4 na caçapa 3".

Eu te devolvo 3 jogadas com a chance estimada de cada uma: 🟢 tranquila, 🟡 atenção, 🔴 arriscada.

Caçapas: embaixo 1 e 2, no meio 3 e 4, em cima 5 e 6.</div>
</div>

<footer>
  <div id="attach"><img id="thumb" alt=""><span id="attachTxt">Foto anexada</span><button class="x" id="unattach" aria-label="Remover foto">✕</button></div>
  <div class="row">
    <input id="file" type="file" accept="image/*" class="hidden">
    <button class="ico" id="cam" aria-label="Anexar foto">📷</button>
    <textarea id="text" rows="1" maxlength="2000" placeholder="Mensagem"></textarea>
    <div id="recbar">● Gravando… <span id="sec">0:00</span></div>
    <button class="ico" id="send" aria-label="Gravar ou enviar">🎤</button>
  </div>
</footer>

<script>
  const $ = (id) => document.getElementById(id);
  const store = { get(k){ try { return localStorage.getItem(k); } catch { return null; } }, set(k,v){ try { localStorage.setItem(k,v); } catch {} } };
  const saved = store.get('sinuca_code'); if (saved) { $('code').value = saved; $('code').classList.add('hidden'); }
  function esc(t) { return String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  // ---------- Chat ----------
  function bubble(cls, html) {
    const d = document.createElement('div'); d.className = 'msg ' + cls; d.innerHTML = html;
    $('chat').appendChild(d); $('chat').scrollTop = $('chat').scrollHeight; return d;
  }

  // ---------- Foto ----------
  let photo = null;
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
  $('cam').onclick = () => $('file').click();
  $('file').onchange = async () => {
    const f = $('file').files[0]; $('file').value = ''; if (!f) return;
    try { photo = await resize(f); $('thumb').src = photo; $('attach').style.display = 'flex'; $('attachTxt').textContent = 'Foto anexada. Agora grave o áudio 🎤 ou escreva.'; updateSend(); }
    catch (e) { bubble('in err', esc(e.message)); }
  };
  $('unattach').onclick = () => { photo = null; $('attach').style.display = 'none'; updateSend(); };

  // ---------- Botão: 🎤 (gravar) ou ➤ (enviar texto) ----------
  function updateSend() { if (!recording) $('send').textContent = $('text').value.trim() ? '➤' : '🎤'; }
  $('text').addEventListener('input', () => { $('text').style.height = 'auto'; $('text').style.height = Math.min(120, $('text').scrollHeight) + 'px'; updateSend(); });

  let rec = null, chunks = [], recording = false, timer = null, t0 = 0;
  const blobToDataUrl = (b) => new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = no; r.readAsDataURL(b); });

  async function startRec() {
    if (!navigator.mediaDevices || !window.MediaRecorder) { bubble('in err', 'Seu navegador não grava áudio aqui. Escreve a situação no campo de mensagem.'); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      chunks = []; rec = new MediaRecorder(stream);
      rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
        if (blob.size < 1000) { bubble('in err', 'Áudio muito curto. Segura um pouco mais.'); return; }
        send(await blobToDataUrl(blob), URL.createObjectURL(blob));
      };
      rec.start(); recording = true; t0 = Date.now();
      $('text').classList.add('hidden'); $('recbar').style.display = 'flex';
      $('send').classList.add('rec'); $('send').textContent = '➤';
      timer = setInterval(() => { const s = Math.floor((Date.now() - t0) / 1000); $('sec').textContent = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); if (s >= 120) stopRec(); }, 250);
    } catch (e) { bubble('in err', 'Não consegui acessar o microfone. Escreve a situação no campo de mensagem.'); }
  }
  function stopRec() {
    if (!recording) return; recording = false; clearInterval(timer);
    $('recbar').style.display = 'none'; $('text').classList.remove('hidden'); $('send').classList.remove('rec'); $('sec').textContent = '0:00';
    rec.stop(); updateSend();
  }

  $('send').onclick = () => {
    if (recording) { stopRec(); return; }
    if ($('text').value.trim()) { send(null, null); return; }
    startRec();
  };
  $('text').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && $('text').value.trim()) { e.preventDefault(); send(null, null); } });

  // ---------- Envio ----------
  let busy = false;
  async function send(audio, audioUrl) {
    if (busy) return;
    const code = $('code').value.trim();
    if (!code) { $('code').classList.remove('hidden'); $('code').focus(); bubble('in err', 'Digita o código de acesso lá em cima primeiro.'); return; }
    const text = $('text').value.trim();
    if (!photo && !text && audio) { bubble('in err', 'Anexa a foto da mesa 📷 antes de mandar o áudio.'); return; }
    if (!photo && !text) return;

    let html = '';
    if (photo) html += '<img class="photo" src="' + photo + '" alt="Foto da mesa">';
    if (audioUrl) html += '<audio controls src="' + audioUrl + '"></audio>';
    if (text) html += esc(text);
    bubble('out', html);

    const sentPhoto = photo;
    $('text').value = ''; $('text').style.height = 'auto'; photo = null; $('attach').style.display = 'none'; updateSend();
    busy = true;
    const wait = bubble('in typing', sentPhoto ? (audio ? 'Ouvindo o áudio e lendo a mesa… 🎱' : 'Lendo a mesa… 🎱') : 'Digitando…');
    try {
      const r = sentPhoto
        ? await fetch('/demo/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-demo-code': code }, body: JSON.stringify({ image: sentPhoto, situation: text, audio }) })
        : await fetch('/demo/ask', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-demo-code': code }, body: JSON.stringify({ question: text }) });
      const data = await r.json().catch(() => ({}));
      if (r.status === 401) { $('code').classList.remove('hidden'); throw new Error('Código de acesso inválido.'); }
      if (!r.ok) throw new Error(data.error || 'Deu erro. Tenta de novo.');
      store.set('sinuca_code', code); $('code').classList.add('hidden');
      let out = '';
      if (data.heard) out += '<div class="heard">🗣️ "' + esc(data.heard) + '"</div><br>';
      out += diagramHtml(data.diagram);
      out += esc(data.text);
      wait.className = 'msg in'; wait.innerHTML = out;
      wait.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) {
      wait.className = 'msg in err'; wait.textContent = e.message || 'Deu erro. Tenta de novo.';
      $('chat').scrollTop = $('chat').scrollHeight;
    } finally {
      busy = false;
    }
  }

  // ---------- Desenho da mesa ----------
  const COLORS = { verde: '#2ecc71', amarelo: '#f1c40f', vermelho: '#e74c3c' };
  const BALL = { par: '#3498db', impar: '#e67e22', as: '#f4f1e8', outra: '#95a5a6' };
  function diagramHtml(d) {
    if (!d || !d.plays || !d.plays.length) return '';
    const W = 200, H = 400, P = 16;
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
      svg += '<polyline points="' + pts + '" fill="none" stroke="' + c + '" stroke-width="3" stroke-linejoin="round" stroke-linecap="round" stroke-dasharray="' + (i === 0 ? '0' : '6 4') + '"/>';
      const last = pl.path[pl.path.length - 1];
      svg += '<circle cx="' + X(last.x) + '" cy="' + Y(last.y) + '" r="4" fill="' + c + '"/>';
      labels.push({ i, c, pl });
    });
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
    const dot = { verde: '🟢', amarelo: '🟡', vermelho: '🔴' };
    const legend = '<div class="legend">' + d.plays.map((pl, i) => '<span>' + (dot[pl.level] || '') + ' ' + (i + 1) + ') ' + esc(pl.name) + ' — ' + pl.chance + '%</span>').join('') + '</div>';
    return '<div class="diagram">' + svg + '</div>' + legend + '<div class="note">Esquema aproximado, feito a partir da foto. As % são estimativas.</div>';
  }
</script>
</body>
</html>
`;
