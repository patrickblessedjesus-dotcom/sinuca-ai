import { timingSafeEqual } from 'node:crypto';
import express, { Router } from 'express';
import type { IncomingMessage } from '../handler.js';
import { Deduplicator } from '../services/dedup.js';
import { errorInfo, logger, maskPhone } from '../utils/logger.js';
import { isAllowed } from './webhook.js';

export interface ZapiWebhookOptions {
  /** Segredo na URL do webhook (a Z-API não assina as requisições). */
  secret: string;
  allowedNumbers: string[];
  dedup?: Deduplicator;
  onMessage: (msg: IncomingMessage) => Promise<void>;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, max = 2048): string | undefined => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : undefined);

/** Converte o payload "Ao receber" da Z-API numa mensagem interna. Retorna null para eventos ignorados. */
export function parseZapiMessage(body: unknown): IncomingMessage | null {
  if (!isObj(body)) return null;
  if (body.type !== 'ReceivedCallback') return null;
  if (body.fromMe === true || body.isGroup === true || body.broadcast === true || body.isNewsletter === true) return null;
  const id = str(body.messageId, 256);
  const from = str(body.phone, 64);
  if (!id || !from || !/^\d{6,20}$/.test(from)) return null;

  if (isObj(body.image) && str(body.image.imageUrl)) {
    return { id, from, type: 'image', imageId: str(body.image.imageUrl), imageMime: str(body.image.mimeType, 100) };
  }
  if (isObj(body.text) && typeof body.text.message === 'string') return { id, from, type: 'text', text: body.text.message.slice(0, 2000) };
  return { id, from, type: 'other' };
}

export function createZapiRouter(opts: ZapiWebhookOptions): Router {
  const router = Router();
  const dedup = opts.dedup ?? new Deduplicator();

  router.post('/zapi/:secret', express.json({ limit: '1mb' }), (req, res) => {
    const given = Buffer.from(String(req.params.secret ?? ''));
    const expected = Buffer.from(opts.secret);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      res.sendStatus(404);
      return;
    }
    res.sendStatus(200);

    let msg: IncomingMessage | null;
    try {
      msg = parseZapiMessage(req.body);
    } catch (err) {
      logger.error('Payload inesperado da Z-API', errorInfo(err));
      return;
    }
    if (!msg) return;
    if (!dedup.firstTime(msg.id)) return;
    if (!isAllowed(msg.from, opts.allowedNumbers)) {
      logger.warn('Remetente fora de ALLOWED_NUMBERS ignorado', { from: maskPhone(msg.from) });
      return;
    }
    logger.info('Mensagem recebida (Z-API)', { from: maskPhone(msg.from), type: msg.type });
    opts.onMessage(msg).catch((err) => logger.error('Erro ao processar mensagem', errorInfo(err)));
  });

  return router;
}
