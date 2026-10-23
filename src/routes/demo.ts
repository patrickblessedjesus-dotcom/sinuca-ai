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

  router.post('/demo/analyze', express.json({ limit: '8mb' }), async (req, res) => {
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

    const image = (req.body as { image?: unknown } | undefined)?.image;
    const match = typeof image === 'string' ? /^data:image\/[a-z+]+;base64,([A-Za-z0-9+/=]+)$/.exec(image) : null;
    if (!match) {
      res.status(400).json({ error: 'Envie uma foto.' });
      return;
    }

    const started = Date.now();
    try {
      const bytes = new Uint8Array(Buffer.from(match[1], 'base64'));
      const mime = validateImage(bytes);
      const text = await opts.coach.analyze(bytes, mime);
      logger.info('Análise da demo concluída', { ms: Date.now() - started, bytes: bytes.length });
      res.json({ text });
    } catch (err) {
      logger.error('Falha na análise da demo', { ms: Date.now() - started, ...errorInfo(err) });
      const msg = err instanceof MediaError ? 'Arquivo de imagem inválido ou grande demais.' : 'Não consegui analisar essa foto agora. Tenta de novo, com a mesa inteira e as bolas bem visíveis.';
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
  input[type=password] { width:100%; padding: 12px; border-radius: 10px; border: 1px solid #2f6b55; background:#0b3d2e; color: var(--fg); font-size:16px; }
  .btn { display:block; width:100%; text-align:center; padding: 16px; border-radius: 12px; border: 0; font-size: 18px; font-weight: 700; background: var(--accent); color: #1d1d1d; cursor: pointer; }
  .btn[disabled] { opacity: .6; }
  #preview { width:100%; border-radius: 12px; margin-top: 12px; display:none; }
  #result { white-space: pre-wrap; line-height: 1.5; font-size: 16px; }
  .err { color: #ffb4a8; }
  .hidden { display:none; }
</style>
</head>
<body>
<main>
  <h1>🎱 Sinuca AI</h1>
  <p class="sub">Tira uma foto da mesa (de cima, mesa inteira) e receba uma sugestão de jogada.</p>

  <div class="card" id="codeBox">
    <label for="code">Código de acesso</label>
    <input id="code" type="password" autocomplete="off" placeholder="Digite o código">
  </div>

  <div class="card">
    <input id="file" type="file" accept="image/*" capture="environment" class="hidden">
    <button class="btn" id="pick">📸 Tirar foto da mesa</button>
    <img id="preview" alt="Foto da mesa">
  </div>

  <div class="card hidden" id="out"><div id="result"></div></div>
</main>
<script>
  const $ = (id) => document.getElementById(id);
  const store = { get(k){ try { return localStorage.getItem(k); } catch { return null; } }, set(k,v){ try { localStorage.setItem(k,v); } catch {} } };
  const saved = store.get('sinuca_code'); if (saved) { $('code').value = saved; }

  $('pick').onclick = () => $('file').click();

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

  function show(text, isErr) {
    $('out').classList.remove('hidden');
    $('result').className = isErr ? 'err' : '';
    $('result').textContent = text;
  }

  $('file').onchange = async () => {
    const file = $('file').files[0]; if (!file) return;
    const code = $('code').value.trim();
    if (!code) { show('Digite o código de acesso primeiro.', true); return; }
    store.set('sinuca_code', code);
    $('pick').disabled = true; $('pick').textContent = 'Analisando a mesa… 🎱';
    show('Recebi a foto! Analisando a mesa agora…', false);
    try {
      const dataUrl = await resize(file);
      $('preview').src = dataUrl; $('preview').style.display = 'block';
      const r = await fetch('/demo/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-demo-code': code }, body: JSON.stringify({ image: dataUrl }) });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || 'Erro ao analisar.');
      show(data.text, false);
    } catch (e) {
      show(e.message || 'Erro ao analisar.', true);
    } finally {
      $('pick').disabled = false; $('pick').textContent = '📸 Tirar outra foto'; $('file').value = '';
    }
  };
</script>
</body>
</html>`;
