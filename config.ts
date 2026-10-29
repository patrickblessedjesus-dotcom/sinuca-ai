import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface Config {
  port: number;
  whatsappEnabled: boolean;
  demoCode: string | undefined;
  zapiEnabled: boolean;
  zapiInstanceId: string;
  zapiToken: string;
  zapiClientToken: string | undefined;
  zapiWebhookSecret: string;
  twilioEnabled: boolean;
  twilioAccountSid: string;
  twilioAuthToken: string;
  twilioFrom: string;
  twilioPublicUrl: string | undefined;
  verifyToken: string;
  whatsappToken: string;
  phoneNumberId: string;
  graphApiVersion: string;
  appSecret: string | undefined;
  skipSignatureVerification: boolean;
  allowedNumbers: string[];
  openaiApiKey: string;
  openaiModel: string;
  knowledge: string;
  voice: { apiKey: string; voiceId: string; model: string } | null;
  asaas: {
    apiKey: string;
    sandbox: boolean;
    webhookToken: string;
    planName: string;
    price: number;
    accessDays: number;
    freeAnalyses: number;
    exempt: string[];
    siteUrl: string;
  } | null;
}

export const DEFAULT_GRAPH_API_VERSION = 'v25.0';
export const DEFAULT_OPENAI_MODEL = 'gpt-4o-mini';
const MAX_KNOWLEDGE_CHARS = 60_000;

export class ConfigError extends Error {}

/** Lê knowledge/conhecimento.md, ignorando comentários HTML. Vazio se não houver conteúdo. */
export function loadKnowledge(path = resolve(process.cwd(), 'knowledge', 'conhecimento.md')): string {
  if (!existsSync(path)) return '';
  const text = readFileSync(path, 'utf8').replace(/<!--[\s\S]*?-->/g, '').trim();
  return text.slice(0, MAX_KNOWLEDGE_CHARS);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, knowledge = loadKnowledge()): Config {
  const missing: string[] = [];
  const req = (name: string): string => {
    const v = env[name]?.trim();
    if (!v) missing.push(name);
    return v ?? '';
  };

  const openaiApiKey = req('OPENAI_API_KEY');
  const demoCode = env.DEMO_CODE?.trim() || undefined;

  // WhatsApp é opcional: se qualquer variável dele estiver definida, todas passam a ser obrigatórias.
  const waVars = ['VERIFY_TOKEN', 'WHATSAPP_TOKEN', 'PHONE_NUMBER_ID'];
  const whatsappEnabled = waVars.some((n) => env[n]?.trim());
  let verifyToken = '';
  let whatsappToken = '';
  let phoneNumberId = '';
  const appSecret = env.APP_SECRET?.trim() || undefined;
  const skipSignatureVerification = env.SKIP_SIGNATURE_VERIFICATION?.trim().toLowerCase() === 'true';
  if (whatsappEnabled) {
    verifyToken = req('VERIFY_TOKEN');
    whatsappToken = req('WHATSAPP_TOKEN');
    phoneNumberId = req('PHONE_NUMBER_ID');
    if (!appSecret && !skipSignatureVerification) missing.push('APP_SECRET (ou SKIP_SIGNATURE_VERIFICATION=true só em desenvolvimento)');
  }

  // Z-API (não oficial) é opcional: ativa quando ZAPI_INSTANCE_ID estiver definido.
  const zapiEnabled = Boolean(env.ZAPI_INSTANCE_ID?.trim());
  let zapiInstanceId = '';
  let zapiToken = '';
  let zapiWebhookSecret = '';
  const zapiClientToken = env.ZAPI_CLIENT_TOKEN?.trim() || undefined;
  if (zapiEnabled) {
    zapiInstanceId = req('ZAPI_INSTANCE_ID');
    zapiToken = req('ZAPI_TOKEN');
    zapiWebhookSecret = req('ZAPI_WEBHOOK_SECRET');
    if (zapiWebhookSecret && !/^[A-Za-z0-9_-]{12,100}$/.test(zapiWebhookSecret)) {
      missing.push('ZAPI_WEBHOOK_SECRET com 12+ caracteres (só letras, números, - e _)');
    }
  }

  // Twilio é opcional: ativa quando TWILIO_ACCOUNT_SID estiver definido.
  const twilioEnabled = Boolean(env.TWILIO_ACCOUNT_SID?.trim());
  let twilioAccountSid = '';
  let twilioAuthToken = '';
  const twilioFrom = env.TWILIO_WHATSAPP_FROM?.trim() || 'whatsapp:+14155238886';
  const twilioPublicUrl = env.TWILIO_WEBHOOK_URL?.trim() || undefined;
  if (twilioEnabled) {
    twilioAccountSid = req('TWILIO_ACCOUNT_SID');
    twilioAuthToken = req('TWILIO_AUTH_TOKEN');
    if (!/^whatsapp:\+\d{6,20}$/.test(twilioFrom)) missing.push('TWILIO_WHATSAPP_FROM no formato whatsapp:+14155238886');
  }

  if (!whatsappEnabled && !zapiEnabled && !twilioEnabled && !demoCode) {
    missing.push('VERIFY_TOKEN, WHATSAPP_TOKEN, PHONE_NUMBER_ID (WhatsApp), TWILIO_ACCOUNT_SID (Twilio), ZAPI_INSTANCE_ID (Z-API) ou DEMO_CODE (página de demonstração)');
  }

  if (demoCode && demoCode.length < 6) missing.push('DEMO_CODE com pelo menos 6 caracteres');

  // Cobrança (Asaas) é opcional: ativa quando ASAAS_API_KEY estiver definido.
  let asaas: Config['asaas'] = null;
  if (env.ASAAS_API_KEY?.trim()) {
    const webhookToken = req('ASAAS_WEBHOOK_TOKEN');
    if (webhookToken && !/^[A-Za-z0-9_-]{16,255}$/.test(webhookToken)) missing.push('ASAAS_WEBHOOK_TOKEN com 16+ caracteres (só letras, números, - e _)');
    const num = (name: string, def: number) => {
      const raw = env[name]?.trim().replace(',', '.');
      const v = raw ? Number(raw) : def;
      if (!Number.isFinite(v) || v < 0) missing.push(`${name} numérico`);
      return v;
    };
    asaas = {
      apiKey: env.ASAAS_API_KEY.trim(),
      sandbox: (env.ASAAS_ENV?.trim().toLowerCase() || 'sandbox') !== 'production',
      webhookToken,
      planName: env.PLAN_NAME?.trim() || 'Sinuca AI Mensal',
      price: num('PLAN_PRICE', 29.9),
      accessDays: num('ACCESS_DAYS', 30),
      freeAnalyses: num('FREE_ANALYSES', 1),
      exempt: (env.FREE_NUMBERS ?? '').split(',').map((n) => n.replace(/\D/g, '')).filter(Boolean),
      siteUrl: env.SITE_URL?.trim() || 'https://sinuca-ai.onrender.com',
    };
    if (asaas.price < 5) missing.push('PLAN_PRICE de pelo menos 5 (mínimo do Asaas)');
  }

  // Voz (ElevenLabs) é opcional: ativa quando ELEVENLABS_API_KEY estiver definido.
  const voice = env.ELEVENLABS_API_KEY?.trim()
    ? {
        apiKey: env.ELEVENLABS_API_KEY.trim(),
        voiceId: env.ELEVENLABS_VOICE_ID?.trim() || 'JBFqnCBsd6RMkjVDRZzb',
        model: env.ELEVENLABS_MODEL?.trim() || 'eleven_multilingual_v2',
      }
    : null;
  if (voice && !/^[A-Za-z0-9]{10,40}$/.test(voice.voiceId)) missing.push('ELEVENLABS_VOICE_ID só com letras e números');

  if (missing.length) {
    throw new ConfigError(`Variáveis de ambiente obrigatórias ausentes: ${missing.join(', ')}. Veja o .env.example.`);
  }

  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new ConfigError('PORT inválida.');

  const graphApiVersion = env.GRAPH_API_VERSION?.trim() || DEFAULT_GRAPH_API_VERSION;
  if (!/^v\d+\.\d+$/.test(graphApiVersion)) throw new ConfigError('GRAPH_API_VERSION deve ter o formato v23.0.');
  if (whatsappEnabled && !/^\d+$/.test(phoneNumberId)) throw new ConfigError('PHONE_NUMBER_ID deve conter só dígitos.');

  const allowedNumbers = (env.ALLOWED_NUMBERS ?? '')
    .split(',')
    .map((n) => n.replace(/\D/g, ''))
    .filter(Boolean);

  return {
    port,
    whatsappEnabled,
    demoCode,
    zapiEnabled,
    zapiInstanceId,
    zapiToken,
    zapiClientToken,
    zapiWebhookSecret,
    twilioEnabled,
    twilioAccountSid,
    twilioAuthToken,
    twilioFrom,
    twilioPublicUrl,
    verifyToken,
    whatsappToken,
    phoneNumberId,
    graphApiVersion,
    appSecret,
    skipSignatureVerification,
    allowedNumbers,
    openaiApiKey,
    openaiModel: env.OPENAI_MODEL?.trim() || DEFAULT_OPENAI_MODEL,
    knowledge,
    asaas,
    voice,
  };
}
