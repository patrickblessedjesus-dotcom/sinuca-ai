import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface Config {
  port: number;
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
}

export const DEFAULT_GRAPH_API_VERSION = 'v23.0';
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

  const verifyToken = req('VERIFY_TOKEN');
  const whatsappToken = req('WHATSAPP_TOKEN');
  const phoneNumberId = req('PHONE_NUMBER_ID');
  const openaiApiKey = req('OPENAI_API_KEY');

  const appSecret = env.APP_SECRET?.trim() || undefined;
  const skipSignatureVerification = env.SKIP_SIGNATURE_VERIFICATION?.trim().toLowerCase() === 'true';
  if (!appSecret && !skipSignatureVerification) missing.push('APP_SECRET (ou SKIP_SIGNATURE_VERIFICATION=true só em desenvolvimento)');

  if (missing.length) {
    throw new ConfigError(`Variáveis de ambiente obrigatórias ausentes: ${missing.join(', ')}. Veja o .env.example.`);
  }

  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new ConfigError('PORT inválida.');

  const graphApiVersion = env.GRAPH_API_VERSION?.trim() || DEFAULT_GRAPH_API_VERSION;
  if (!/^v\d+\.\d+$/.test(graphApiVersion)) throw new ConfigError('GRAPH_API_VERSION deve ter o formato v23.0.');
  if (!/^\d+$/.test(phoneNumberId)) throw new ConfigError('PHONE_NUMBER_ID deve conter só dígitos.');

  const allowedNumbers = (env.ALLOWED_NUMBERS ?? '')
    .split(',')
    .map((n) => n.replace(/\D/g, ''))
    .filter(Boolean);

  return {
    port,
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
  };
}
