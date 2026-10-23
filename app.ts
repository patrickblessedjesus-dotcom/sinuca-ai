import express, { type NextFunction, type Request, type Response } from 'express';
import { createDemoRouter, type DemoOptions } from './routes/demo.js';
import { createTwilioRouter, type TwilioWebhookOptions } from './routes/twilio.js';
import { createZapiRouter, type ZapiWebhookOptions } from './routes/zapi.js';
import { createWebhookRouter, type RawBodyRequest, type WebhookOptions } from './routes/webhook.js';
import { errorInfo, logger } from './utils/logger.js';

export interface AppOptions {
  webhook?: WebhookOptions;
  demo?: DemoOptions;
  zapi?: ZapiWebhookOptions;
  twilio?: TwilioWebhookOptions;
}

export function createApp(opts: AppOptions | WebhookOptions) {
  const { webhook, demo, zapi, twilio } = 'onMessage' in opts ? { webhook: opts, demo: undefined, zapi: undefined, twilio: undefined } : opts;
  const app = express();
  app.disable('x-powered-by');

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  if (demo) app.use(createDemoRouter(demo));
  if (zapi) app.use(createZapiRouter(zapi));
  if (twilio) app.use(createTwilioRouter(twilio));

  if (webhook) {
    // Guarda o corpo bruto para validar a assinatura HMAC da Meta. Limite de tamanho do corpo.
    app.use(
      '/webhook',
      express.json({
        limit: '1mb',
        verify: (req, _res, buf) => {
          (req as RawBodyRequest).rawBody = Buffer.from(buf);
        },
      }),
    );
    app.use(createWebhookRouter(webhook));
  }

  app.use((_req, res) => {
    res.sendStatus(404);
  });

  // Erros (ex.: JSON inválido, corpo grande demais) sem vazar detalhes.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = typeof (err as { status?: unknown }).status === 'number' ? (err as { status: number }).status : 500;
    logger.warn('Requisição rejeitada', { status, ...errorInfo(err) });
    res.sendStatus(status >= 400 && status < 600 ? status : 500);
  });

  return app;
}
