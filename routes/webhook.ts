import { createHmac, timingSafeEqual } from 'node:crypto';
import { Router, type Request } from 'express';
import type { IncomingMessage } from '../handler.js';
import { Deduplicator } from '../services/dedup.js';
import { errorInfo, logger, maskPhone } from '../utils/logger.js';

export interface WebhookOptions {
  verifyToken: string;
  appSecret?: string;
  skipSignatureVerification: boolean;
  allowedNumbers: string[];
  dedup?: Deduplicator;
  /** Chamado em segundo plano para cada mensagem nova e autorizada. */
  onMessage: (msg: IncomingMessage) => Promise<void>;
}

export type RawBodyRequest = Request & { rawBody?: Buffer };

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function verifySignature(rawBody: Buffer | undefined, header: string | undefined, appSecret: string): boolean {
  if (!rawBody || !header?.startsWith('sha256=')) return false;
  const expected = 'sha256=' + createHmac('sha256', appSecret).update(rawBody).digest('hex');
  return safeEqual(expected, header);
}

/**
 * Variantes de um número para comparação. Números móveis brasileiros às vezes chegam
 * no webhook sem o 9º dígito (55 + DDD + 8 dígitos), então comparamos as duas formas.
 */
export function phoneVariants(phone: string): string[] {
  const d = phone.replace(/\D/g, '');
  const out = new Set([d]);
  if (d.startsWith('55') && d.length === 13 && d[4] === '9') out.add(d.slice(0, 4) + d.slice(5));
  if (d.startsWith('55') && d.length === 12 && /[6-9]/.test(d[4])) out.add(d.slice(0, 4) + '9' + d.slice(4));
  return [...out];
}

export function isAllowed(from: string, allowed: string[]): boolean {
  if (allowed.length === 0) return true;
  const allowedSet = new Set(allowed.flatMap(phoneVariants));
  return phoneVariants(from).some((v) => allowedSet.has(v));
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 && v.length <= 256 ? v : undefined);

/** Extrai mensagens recebidas de um payload da Cloud API, ignorando status e campos malformados. */
export function extractMessages(body: unknown): IncomingMessage[] {
  const out: IncomingMessage[] = [];
  if (!isObj(body) || body.object !== 'whatsapp_business_account' || !Array.isArray(body.entry)) return out;

  for (const entry of body.entry) {
    if (!isObj(entry) || !Array.isArray(entry.changes)) continue;
    for (const change of entry.changes) {
      if (!isObj(change) || change.field !== 'messages' || !isObj(change.value)) continue;
      const messages = change.value.messages;
      if (!Array.isArray(messages)) continue; // eventos só de "statuses" caem aqui
      for (const m of messages) {
        if (!isObj(m)) continue;
        const id = str(m.id);
        const from = str(m.from);
        const type = str(m.type);
        if (!id || !from || !type || !/^\d{6,20}$/.test(from)) continue;
        const msg: IncomingMessage = { id, from, type };
        if (type === 'text' && isObj(m.text) && typeof m.text.body === 'string') msg.text = m.text.body.slice(0, 2000);
        if (type === 'image' && isObj(m.image)) {
          msg.imageId = str(m.image.id);
          msg.imageMime = str(m.image.mime_type);
        }
        out.push(msg);
      }
    }
  }
  return out;
}

export function createWebhookRouter(opts: WebhookOptions): Router {
  const router = Router();
  const dedup = opts.dedup ?? new Deduplicator();

  router.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && typeof token === 'string' && safeEqual(token, opts.verifyToken) && typeof challenge === 'string') {
      logger.info('Webhook verificado pela Meta');
      res.status(200).type('text/plain').send(challenge);
      return;
    }
    logger.warn('Falha na verificação do webhook');
    res.sendStatus(403);
  });

  router.post('/webhook', (req: RawBodyRequest, res) => {
    if (!opts.skipSignatureVerification) {
      if (!opts.appSecret || !verifySignature(req.rawBody, req.get('x-hub-signature-256'), opts.appSecret)) {
        logger.warn('Assinatura do webhook inválida ou ausente');
        res.sendStatus(401);
        return;
      }
    }

    // Responde rápido à Meta; o processamento segue em segundo plano.
    res.sendStatus(200);

    let messages: IncomingMessage[];
    try {
      messages = extractMessages(req.body);
    } catch (err) {
      logger.error('Payload inesperado do webhook', errorInfo(err));
      return;
    }

    for (const msg of messages) {
      if (!dedup.firstTime(msg.id)) {
        logger.info('Mensagem duplicada ignorada', { from: maskPhone(msg.from) });
        continue;
      }
      if (!isAllowed(msg.from, opts.allowedNumbers)) {
        logger.warn('Remetente fora de ALLOWED_NUMBERS ignorado', { from: maskPhone(msg.from) });
        continue;
      }
      logger.info('Mensagem recebida', { from: maskPhone(msg.from), type: msg.type });
      opts.onMessage(msg).catch((err) => logger.error('Erro ao processar mensagem', errorInfo(err)));
    }
  });

  return router;
}
