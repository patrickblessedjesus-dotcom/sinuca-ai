import express, { Router } from 'express';
import type { IncomingMessage } from '../handler.js';
import { Deduplicator } from '../services/dedup.js';
import { validTwilioSignature } from '../services/twilio.js';
import { errorInfo, logger, maskPhone } from '../utils/logger.js';
import { isAllowed } from './webhook.js';

export interface TwilioWebhookOptions {
  authToken: string;
  /** URL pública exata configurada na Twilio (usada na assinatura). Se vazia, é deduzida da requisição. */
  publicUrl?: string;
  allowedNumbers: string[];
  dedup?: Deduplicator;
  onMessage: (msg: IncomingMessage) => Promise<void>;
}

const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

/** Converte o POST da Twilio numa mensagem interna. Retorna null se faltar algo essencial. */
export function parseTwilioMessage(p: Record<string, string>): IncomingMessage | null {
  const id = p.MessageSid;
  const fromRaw = p.From ?? '';
  if (!id || !/^[A-Za-z0-9]{10,64}$/.test(id) || !fromRaw.startsWith('whatsapp:')) return null;
  const from = fromRaw.replace(/\D/g, '');
  if (!/^\d{6,20}$/.test(from)) return null;

  const numMedia = Number(p.NumMedia ?? '0');
  if (numMedia > 0 && p.MediaUrl0 && (p.MediaContentType0 ?? '').startsWith('image/')) {
    return { id, from, type: 'image', imageId: p.MediaUrl0, imageMime: p.MediaContentType0 };
  }
  if (numMedia === 0 && typeof p.Body === 'string' && p.Body.length > 0) return { id, from, type: 'text' };
  return { id, from, type: 'other' };
}

export function createTwilioRouter(opts: TwilioWebhookOptions): Router {
  const router = Router();
  const dedup = opts.dedup ?? new Deduplicator();

  router.post('/twilio', express.urlencoded({ extended: false, limit: '100kb' }), (req, res) => {
    const params: Record<string, string> = {};
    for (const [k, v] of Object.entries((req.body ?? {}) as Record<string, unknown>)) {
      if (typeof v === 'string') params[k] = v;
    }
    const url = opts.publicUrl || `https://${req.get('host')}${req.originalUrl}`;
    if (!validTwilioSignature(opts.authToken, url, params, req.get('x-twilio-signature'))) {
      logger.warn('Assinatura da Twilio inválida ou ausente');
      res.sendStatus(403);
      return;
    }

    // Responde na hora (TwiML vazio) e envia a resposta depois pela API.
    res.type('text/xml').send(EMPTY_TWIML);

    let msg: IncomingMessage | null;
    try {
      msg = parseTwilioMessage(params);
    } catch (err) {
      logger.error('Payload inesperado da Twilio', errorInfo(err));
      return;
    }
    if (!msg || !dedup.firstTime(msg.id)) return;
    if (!isAllowed(msg.from, opts.allowedNumbers)) {
      logger.warn('Remetente fora de ALLOWED_NUMBERS ignorado', { from: maskPhone(msg.from) });
      return;
    }
    logger.info('Mensagem recebida (Twilio)', { from: maskPhone(msg.from), type: msg.type });
    opts.onMessage(msg).catch((err) => logger.error('Erro ao processar mensagem', errorInfo(err)));
  });

  return router;
}
