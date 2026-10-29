import { timingSafeEqual } from 'node:crypto';
import express, { Router } from 'express';
import { MSG_PAID, type Paywall } from '../services/paywall.js';
import { Deduplicator } from '../services/dedup.js';
import { errorInfo, logger, maskPhone } from '../utils/logger.js';

export interface AsaasWebhookOptions {
  /** O mesmo token configurado no webhook do Asaas (header asaas-access-token). */
  token: string;
  paywall: Paywall;
  /** Avisa o cliente no WhatsApp. */
  notify: (phone: string, text: string) => Promise<void>;
  dedup?: Deduplicator;
}

export function createAsaasRouter(opts: AsaasWebhookOptions): Router {
  const router = Router();
  const dedup = opts.dedup ?? new Deduplicator();

  router.post('/asaas/webhook', express.json({ limit: '1mb' }), (req, res) => {
    const given = Buffer.from(String(req.get('asaas-access-token') ?? ''));
    const expected = Buffer.from(opts.token);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      logger.warn('Webhook do Asaas com token inválido');
      res.sendStatus(401);
      return;
    }
    res.sendStatus(200);

    const body = req.body as { id?: unknown };
    if (typeof body?.id === 'string' && !dedup.firstTime(`asaas:${body.id}`)) return;

    void opts.paywall
      .onWebhook(req.body)
      .then(async (phone) => {
        if (!phone) return;
        try {
          await opts.notify(phone, MSG_PAID);
        } catch (err) {
          logger.error('Pago, mas não consegui avisar no WhatsApp', { to: maskPhone(phone), ...errorInfo(err) });
        }
      })
      .catch((err) => logger.error('Erro no webhook do Asaas', errorInfo(err)));
  });

  return router;
}
