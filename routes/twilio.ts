import express, { Router } from 'express';
import type { IncomingMessage } from '../handler.js';
import { Deduplicator } from '../services/dedup.js';
import { validTwilioSignature } from '../services/twilio.js';
import type { WhatsAppClient } from '../services/whatsapp.js';
import { errorInfo, logger, maskPhone } from '../utils/logger.js';
import { isAllowed } from './webhook.js';

export interface TwilioWebhookOptions {
  authToken: string;
  /** URL pública exata configurada na Twilio (usada na assinatura). Se vazia, é deduzida da requisição. */
  publicUrl?: string;
  allowedNumbers: string[];
  dedup?: Deduplicator;
  /** Cliente real da Twilio (usado só se a resposta não couber no tempo do webhook). */
  client: WhatsAppClient;
  /** Processa a mensagem enviando as respostas pelo cliente recebido. */
  handle: (msg: IncomingMessage, wa: WhatsAppClient) => Promise<void>;
  /** Tempo máximo para responder dentro do próprio webhook (a Twilio espera até ~15 s). */
  replyBudgetMs?: number;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function twiml(messages: string[]): string {
  return '<?xml version="1.0" encoding="UTF-8"?><Response>' + messages.map((m) => `<Message>${escapeXml(m)}</Message>`).join('') + '</Response>';
}


/** Converte o POST da Twilio numa mensagem interna. Retorna null se faltar algo essencial. */
export function parseTwilioMessage(p: Record<string, string>): IncomingMessage | null {
  const id = p.MessageSid;
  const fromRaw = p.From ?? '';
  if (!id || !/^[A-Za-z0-9]{10,64}$/.test(id) || !fromRaw.startsWith('whatsapp:')) return null;
  const from = fromRaw.replace(/\D/g, '');
  if (!/^\d{6,20}$/.test(from)) return null;

  const numMedia = Number(p.NumMedia ?? '0');
  if (numMedia > 0 && p.MediaUrl0 && (p.MediaContentType0 ?? '').startsWith('image/')) {
    const caption = (p.Body ?? '').trim();
    return { id, from, type: 'image', imageId: p.MediaUrl0, imageMime: p.MediaContentType0, ...(caption ? { text: caption.slice(0, 2000) } : {}) };
  }
  if (numMedia > 0 && p.MediaUrl0 && (p.MediaContentType0 ?? '').startsWith('audio/')) {
    return { id, from, type: 'audio', audioId: p.MediaUrl0, audioMime: p.MediaContentType0 };
  }
  if (numMedia === 0 && typeof p.Body === 'string' && p.Body.length > 0) return { id, from, type: 'text', text: p.Body.slice(0, 2000) };
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

    let msg: IncomingMessage | null = null;
    try {
      msg = parseTwilioMessage(params);
    } catch (err) {
      logger.error('Payload inesperado da Twilio', errorInfo(err));
    }
    if (!msg || !dedup.firstTime(msg.id)) {
      res.type('text/xml').send(twiml([]));
      return;
    }
    if (!isAllowed(msg.from, opts.allowedNumbers)) {
      logger.warn('Remetente fora de ALLOWED_NUMBERS ignorado', { from: maskPhone(msg.from) });
      res.type('text/xml').send(twiml([]));
      return;
    }
    logger.info('Mensagem recebida (Twilio)', { from: maskPhone(msg.from), type: msg.type });

    // As respostas vão no próprio retorno do webhook (TwiML), que não exige template.
    // Se o processamento passar do tempo, o que vier depois tenta a API da Twilio.
    const pending: string[] = [];
    let responded = false;
    const finish = () => {
      if (responded) return;
      responded = true;
      clearTimeout(timer);
      res.type('text/xml').send(twiml(pending.splice(0)));
    };
    const collector: WhatsAppClient = {
      sendText: async (to, body) => {
        if (!responded) pending.push(body);
        else await opts.client.sendText(to, body);
      },
      getMediaInfo: (id) => opts.client.getMediaInfo(id),
      downloadMedia: (info) => opts.client.downloadMedia(info),
    };
    const timer = setTimeout(() => {
      logger.warn('Resposta passou do tempo do webhook; o restante vai pela API');
      finish();
    }, opts.replyBudgetMs ?? 13_000);

    opts
      .handle(msg, collector)
      .catch((err) => logger.error('Erro ao processar mensagem', errorInfo(err)))
      .finally(finish);
  });

  return router;
}
