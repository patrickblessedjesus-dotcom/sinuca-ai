import express, { type NextFunction, type Request, type Response } from 'express';
import { createWebhookRouter, type RawBodyRequest, type WebhookOptions } from './routes/webhook.js';
import { errorInfo, logger } from './utils/logger.js';

export function createApp(webhook: WebhookOptions) {
  const app = express();
  app.disable('x-powered-by');

  // Guarda o corpo bruto para validar a assinatura HMAC da Meta. Limite de tamanho do corpo.
  app.use(
    express.json({
      limit: '1mb',
      verify: (req, _res, buf) => {
        (req as RawBodyRequest).rawBody = Buffer.from(buf);
      },
    }),
  );

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.use(createWebhookRouter(webhook));

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
