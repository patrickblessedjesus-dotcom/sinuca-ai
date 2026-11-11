import 'dotenv/config';
import { createApp } from './app.js';
import { ConfigError, loadConfig } from './config.js';
import { createConversations, loadExamplePhoto, MSG_EXAMPLE_CAPTION, type RenderPlan } from './handler.js';
import { planCaption, renderPlanImage } from './services/drawPlan.js';
import { createCoach } from './services/sinucaCoach.js';
import { createWhatsAppClient } from './services/whatsapp.js';
import { createZapiClient } from './services/zapi.js';
import { createTwilioClient } from './services/twilio.js';
import { createPaywall, createHotmartPaywall, createMemoryStore, createPgStore, loadHotmartConfig, createHotmartRouter } from './services/paywall.js';
import express from 'express';
import { createVoice, toSpeech, SPOKEN_HOW_TO_PHOTO, SPOKEN_PAID, type Voice } from './services/voice.js';
import type { Paywall } from './services/paywall.js';
import type { WhatsAppClient } from './services/whatsapp.js';
import { timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { errorInfo, logger, maskPhone } from './utils/logger.js';

// ============================================================================
// REMARKETING: mensagem pra quem conversou com o bot e ainda não pagou.
// Abre no navegador: /admin/remarketing?token=SEU_TOKEN
//   (só olha)            → mostra quantas pessoas vão receber
//   &teste=5511999999999 → manda só pra esse número (pra conferir)
//   &enviar=sim          → começa o envio, devagar (1 a cada 30-60 s)
//   &parar=sim           → para o envio
// ============================================================================
const REMARKETING_TEXT =
  'Bom dia, parceiro! 🎱 Aqui é o Felipinho. Vi que você passou aqui e ainda não liberou teu acesso. Hoje é o dia: manda a foto da tua mesa que eu te mostro a jogada certa, com a minha voz, na hora.';
/** Só quem falou com o bot a partir do lançamento. */
const REMARKETING_SINCE = Date.parse('2026-11-09T00:00:00-03:00');

interface RemarketingOptions {
  secret: string;
  instanceId: string;
  token: string;
  clientToken?: string;
  client: WhatsAppClient;
  paywall: Paywall;
  voice?: Voice;
}

function createRemarketingRouter(o: RemarketingOptions) {
  const router = express.Router();
  const zapiBase = `https://api.z-api.io/instances/${encodeURIComponent(o.instanceId)}/token/${encodeURIComponent(o.token)}`;
  const zapiHeaders: Record<string, string> = o.clientToken ? { 'Client-Token': o.clientToken } : {};
  const state = { running: false, stop: false, total: 0, done: 0, skipped: 0, failed: 0, startedAt: 0 };
  const sent = new Set<string>();
  const recorded = (() => {
    const path = resolve(process.cwd(), 'remarketing.mp3');
    try {
      if (existsSync(path)) {
        const b = new Uint8Array(readFileSync(path));
        if (b.byteLength > 1000) return b;
      }
    } catch {
      /* sem arquivo: usa a voz clonada */
    }
    return null;
  })();

  const okToken = (given: unknown) => {
    const a = Buffer.from(String(given ?? ''));
    const b = Buffer.from(o.secret);
    return a.length === b.length && timingSafeEqual(a, b);
  };

  /** Todas as conversas individuais do número na Z-API (sem grupos). */
  async function listChats(): Promise<{ phone: string; at: number }[]> {
    const out = new Map<string, number>();
    for (let page = 1; page <= 50; page++) {
      const res = await fetch(`${zapiBase}/chats?page=${page}&pageSize=100`, { headers: zapiHeaders, signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`Z-API /chats falhou (HTTP ${res.status})`);
      const data: unknown = await res.json();
      const rows = Array.isArray(data) ? data : [];
      for (const r of rows) {
        if (typeof r !== 'object' || r === null) continue;
        const c = r as Record<string, unknown>;
        if (c.isGroup === true || c.isNewsletter === true) continue;
        const raw = String(c.phone ?? '');
        if (/[-@]/.test(raw)) continue;
        const phone = raw.replace(/\D/g, '');
        if (!/^55\d{10,11}$/.test(phone)) continue;
        let at = Number(c.lastMessageTime ?? c.lastMessageTimestamp ?? 0);
        if (!Number.isFinite(at)) at = 0;
        if (at > 0 && at < 1e12) at *= 1000;
        out.set(phone, Math.max(out.get(phone) ?? 0, at));
      }
      if (rows.length < 100) break;
    }
    return [...out].map(([phone, at]) => ({ phone, at }));
  }

  /** Quem conversou desde o lançamento, sem quem já pagou. */
  async function candidates() {
    const chats = (await listChats()).filter((c) => c.at === 0 || c.at >= REMARKETING_SINCE);
    const pending: string[] = [];
    let paid = 0;
    for (let i = 0; i < chats.length; i += 5) {
      const batch = chats.slice(i, i + 5);
      const access = await Promise.all(batch.map((c) => o.paywall.check(c.phone).catch(() => 'free' as const)));
      batch.forEach((c, j) => {
        if (access[j] === 'paid') paid++;
        else if (!sent.has(c.phone)) pending.push(c.phone);
      });
    }
    return { conversas: chats.length, jaPagaram: paid, jaReceberam: chats.length - paid - pending.length, pending };
  }

  async function sendOne(phone: string) {
    if (o.client.sendAudio) {
      try {
        const mp3 = recorded ?? (o.voice ? await o.voice.speak(toSpeech(REMARKETING_TEXT), { cache: true }) : null);
        if (mp3) await o.client.sendAudio(phone, mp3);
      } catch (err) {
        logger.warn('Remarketing: não consegui mandar o áudio', { to: maskPhone(phone), ...errorInfo(err) });
      }
    }
    await o.client.sendText(phone, `${REMARKETING_TEXT}\n\n${await o.paywall.payMessage(phone)}`);
  }

  async function run(list: string[]) {
    state.running = true;
    state.stop = false;
    state.total = list.length;
    state.done = state.skipped = state.failed = 0;
    state.startedAt = Date.now();
    logger.info('Remarketing começou', { total: list.length });
    for (const phone of list) {
      if (state.stop) break;
      if (sent.has(phone) || (await o.paywall.check(phone).catch(() => 'free')) === 'paid') {
        state.skipped++;
        continue;
      }
      try {
        await sendOne(phone);
        sent.add(phone);
        state.done++;
        logger.info('Remarketing enviado', { to: maskPhone(phone), n: state.done, total: state.total });
      } catch (err) {
        state.failed++;
        logger.error('Remarketing: falha ao enviar', { to: maskPhone(phone), ...errorInfo(err) });
      }
      await new Promise((r) => setTimeout(r, 30_000 + Math.random() * 30_000));
    }
    logger.info('Remarketing terminou', { enviados: state.done, pulados: state.skipped, falhas: state.failed, parado: state.stop });
    state.running = false;
  }

  const page = (title: string, lines: string[]) =>
    `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>body{font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;padding:20px 16px;line-height:1.5;font-size:17px}h1{font-size:22px}p{margin:8px 0}</style></head><body><h1>${title}</h1>${lines.map((l) => `<p>${l}</p>`).join('')}</body></html>`;
  const status = () =>
    state.running
      ? `🚀 Enviando: ${state.done} de ${state.total} (pulados ${state.skipped}, falhas ${state.failed}).`
      : state.startedAt
        ? `✅ Último envio terminou: ${state.done} enviados, ${state.skipped} pulados, ${state.failed} falhas.`
        : 'Nenhum envio feito ainda.';

  router.get('/admin/remarketing', async (req, res) => {
    if (!okToken(req.query.token)) {
      res.sendStatus(404);
      return;
    }
    try {
      if (req.query.parar === 'sim') {
        state.stop = true;
        res.type('html').send(page('Remarketing', ['⏹️ Pedido de parada enviado. Para depois da mensagem atual.', status()]));
        return;
      }
      const teste = String(req.query.teste ?? '').replace(/\D/g, '');
      if (teste) {
        await sendOne(teste);
        logger.info('Remarketing de teste enviado', { to: maskPhone(teste) });
        res.type('html').send(page('Remarketing', [`✅ Teste enviado pro número final ${teste.slice(-4)}. Confere no WhatsApp.`]));
        return;
      }
      if (req.query.enviar === 'sim') {
        if (state.running) {
          res.type('html').send(page('Remarketing', ['Já tem um envio rodando.', status()]));
          return;
        }
        const c = await candidates();
        void run(c.pending);
        const min = Math.round((c.pending.length * 45) / 60);
        res.type('html').send(page('Remarketing', [`🚀 Começou! ${c.pending.length} pessoas vão receber.`, `Leva uns ${min} minutos (1 mensagem a cada 30-60 s).`, 'Atualiza esta página sem o "&enviar=sim" pra ver o andamento.']));
        return;
      }
      const c = await candidates();
      res.type('html').send(
        page('Remarketing', [
          `💬 Conversas desde o lançamento: <b>${c.conversas}</b>`,
          `✅ Já pagaram (não recebem): <b>${c.jaPagaram}</b>`,
          `📨 Já receberam o remarketing: <b>${c.jaReceberam}</b>`,
          `🎯 Vão receber agora: <b>${c.pending.length}</b>`,
          status(),
          `<b>Mensagem:</b> ${REMARKETING_TEXT} + link de pagamento`,
          'Pra testar no teu número: some no fim do endereço <code>&teste=55DDDNUMERO</code>. Pra enviar pra todo mundo: <code>&enviar=sim</code>.',
        ]),
      );
    } catch (err) {
      logger.error('Remarketing: erro', errorInfo(err));
      res.status(500).type('html').send(page('Remarketing', ['❌ Deu erro: ' + String((err as Error).message ?? err).slice(0, 200)]));
    }
  });

  return router;
}

let config;
try {
  config = loadConfig();
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(`[config] ${err.message}`);
    process.exit(1);
  }
  throw err;
}

if (config.whatsappEnabled && config.skipSignatureVerification) {
  logger.warn('SKIP_SIGNATURE_VERIFICATION=true: assinatura do webhook NÃO será verificada. Use só em desenvolvimento.');
}

const coach = createCoach({ apiKey: config.openaiApiKey, model: config.openaiModel, knowledge: config.knowledge });
const conversations = createConversations();
const render: RenderPlan = (d, photo, mime) => {
  const png = renderPlanImage(d, photo, mime);
  return png ? { png, caption: planCaption(d) } : null;
};

const whatsapp = config.whatsappEnabled
  ? createWhatsAppClient({ token: config.whatsappToken, phoneNumberId: config.phoneNumberId, graphApiVersion: config.graphApiVersion })
  : undefined;
const zapiClient = config.zapiEnabled
  ? createZapiClient({ instanceId: config.zapiInstanceId, token: config.zapiToken, clientToken: config.zapiClientToken })
  : undefined;
const voice = config.voice ? createVoice(config.voice) : undefined;
let hotmartConfig;
try {
  hotmartConfig = loadHotmartConfig();
} catch (err) {
  console.error(`[config] ${(err as Error).message}`);
  process.exit(1);
}
let paywall = config.asaas ? createPaywall(config.asaas) : undefined;
let dbOk = false;
if (hotmartConfig) {
  let store = hotmartConfig.databaseUrl ? createPgStore(hotmartConfig.databaseUrl) : createMemoryStore();
  try {
    await store.init();
    dbOk = store.persistent;
  } catch (err) {
    logger.error('Não consegui abrir o banco: usando memória (quem pagou some se o servidor reiniciar)', errorInfo(err));
    store = createMemoryStore();
  }
  if (!store.persistent) logger.warn('Hotmart SEM banco (DATABASE_URL): quem pagou some quando o servidor reinicia.');
  paywall = createHotmartPaywall({ ...hotmartConfig, store });
}
// O aviso de "pagamento confirmado" sai pela Z-API se ela estiver ligada; senão pela API oficial.
const notifier = zapiClient ?? whatsapp;
const examplePhoto = loadExamplePhoto();
/** Aviso de pagamento: texto + áudio com a voz (se der). */
const notifyPaid = async (phone: string, text: string) => {
  if (!notifier) return;
  await notifier.sendText(phone, text);
  if (voice && notifier.sendAudio) {
    try {
      await notifier.sendAudio(phone, await voice.speak(SPOKEN_PAID, { cache: true }));
    } catch (err) {
      logger.warn('Não consegui mandar o áudio de pagamento confirmado', errorInfo(err));
    }
  }
  // Depois de pagar: como tirar a foto + foto de exemplo.
  if (examplePhoto && notifier.sendImage) {
    try {
      if (voice && notifier.sendAudio) await notifier.sendAudio(phone, await voice.speak(SPOKEN_HOW_TO_PHOTO, { cache: true }));
      await notifier.sendImage(phone, examplePhoto, MSG_EXAMPLE_CAPTION);
    } catch (err) {
      logger.warn('Não consegui mandar a foto de exemplo depois do pagamento', errorInfo(err));
    }
  }
};

const hotmartPaywall = hotmartConfig ? paywall : undefined;
const inner = createApp({
  webhook: whatsapp
    ? {
        verifyToken: config.verifyToken,
        appSecret: config.appSecret,
        skipSignatureVerification: config.skipSignatureVerification,
        allowedNumbers: config.allowedNumbers,
        onMessage: (msg) => conversations.handle(msg, { whatsapp, coach, render, paywall, voice }),
      }
    : undefined,
  demo: config.demoCode ? { code: config.demoCode, coach } : undefined,
  zapi: zapiClient
    ? {
        secret: config.zapiWebhookSecret,
        allowedNumbers: config.allowedNumbers,
        onMessage: (msg) => conversations.handle(msg, { whatsapp: zapiClient, coach, render, paywall, voice }),
      }
    : undefined,
  asaas:
    !hotmartConfig && paywall && config.asaas && notifier
      ? { token: config.asaas.webhookToken, paywall, notify: notifyPaid }
      : undefined,
  twilio: config.twilioEnabled
    ? (() => {
        const twilioClient = createTwilioClient({ accountSid: config.twilioAccountSid, authToken: config.twilioAuthToken, from: config.twilioFrom });
        return {
          authToken: config.twilioAuthToken,
          publicUrl: config.twilioPublicUrl,
          allowedNumbers: config.allowedNumbers,
          client: twilioClient,
          handle: (msg, wa) => conversations.handle(msg, { whatsapp: wa, coach }),
        };
      })()
    : undefined,
});

// Webhook da Hotmart fica na frente do resto do app.
const app = express();
app.disable('x-powered-by');
if (hotmartConfig && hotmartPaywall && notifier) {
  app.use(createHotmartRouter({ hottok: hotmartConfig.hottok, paywall: hotmartPaywall, notify: notifyPaid }));
}
const remarketingToken = process.env.REMARKETING_TOKEN?.trim();
if (remarketingToken && remarketingToken.length >= 16 && zapiClient && paywall) {
  app.use(
    createRemarketingRouter({
      secret: remarketingToken,
      instanceId: config.zapiInstanceId,
      token: config.zapiToken,
      clientToken: config.zapiClientToken,
      client: zapiClient,
      paywall,
      voice,
    }),
  );
  logger.info('Remarketing ligado em /admin/remarketing');
}
app.use(inner);

const server = app.listen(config.port, () => {
  logger.info('Sinuca AI no ar', {
    port: config.port,
    model: config.openaiModel,
    whatsapp: config.whatsappEnabled,
    demo: Boolean(config.demoCode),
    zapi: config.zapiEnabled,
    twilio: config.twilioEnabled,
    voz: Boolean(config.voice),
    cobranca: hotmartConfig ? 'hotmart' : config.asaas ? (config.asaas.sandbox ? 'asaas-sandbox' : 'asaas-producao') : false,
    banco: dbOk,
    graphApiVersion: config.graphApiVersion,
    knowledgeLoaded: config.knowledge.length > 0,
    allowedNumbers: config.allowedNumbers.length,
  });
});

function shutdown(signal: string) {
  logger.info('Encerrando servidor', { signal });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (err) => logger.error('Promise rejeitada sem tratamento', errorInfo(err)));
