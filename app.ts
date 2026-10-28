import express, { type NextFunction, type Request, type Response } from 'express';
import { createDemoRouter, type DemoOptions } from './routes/demo.js';
import { createSiteRouter } from './routes/site.js';
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

  // Páginas exigidas pela Meta para publicar o app.
  app.get(['/privacidade', '/privacy'], (_req, res) => {
    res.type('html').send(PRIVACY_HTML);
  });
  app.get(['/exclusao-de-dados', '/data-deletion'], (_req, res) => {
    res.type('html').send(DELETION_HTML);
  });

  app.use(createSiteRouter());
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

const PAGE = (title: string, body: string) => `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} · Sinuca AI</title><style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:720px;margin:0 auto;padding:24px 16px 48px;line-height:1.6;color:#1d1d1d;background:#fff}h1{font-size:26px}h2{font-size:18px;margin-top:28px}</style></head><body>${body}</body></html>`;

const PRIVACY_HTML = PAGE('Política de Privacidade', `
<h1>Política de Privacidade — Sinuca AI</h1>
<p>Última atualização: outubro de 2026.</p>
<p>O Sinuca AI é um assistente de dicas de sinuca que funciona pelo WhatsApp e por uma página web. Esta política explica quais dados usamos e por quê.</p>
<h2>Quais dados recebemos</h2>
<ul>
<li>Seu número de WhatsApp, para responder às suas mensagens.</li>
<li>O conteúdo que você nos envia: fotos da mesa de sinuca, áudios e textos.</li>
</ul>
<h2>Como usamos</h2>
<ul>
<li>Para analisar a foto e a situação de jogo que você descreveu e responder com sugestões de jogada.</li>
<li>Fotos, áudios e textos são enviados à OpenAI (provedora do modelo de inteligência artificial) apenas para gerar a resposta.</li>
<li>Não vendemos seus dados nem usamos para publicidade.</li>
</ul>
<h2>Armazenamento</h2>
<ul>
<li>Não salvamos suas fotos nem áudios em disco. Eles ficam na memória do servidor só durante a análise (no máximo alguns minutos, enquanto aguardamos a sua explicação).</li>
<li>Registros técnicos (logs) guardam apenas os 4 últimos dígitos do número e informações de funcionamento, sem conteúdo das mensagens.</li>
</ul>
<h2>Seus direitos</h2>
<p>Você pode pedir a exclusão dos seus dados a qualquer momento. Veja <a href="/exclusao-de-dados">como pedir a exclusão</a>.</p>
<h2>Contato</h2>
<p>Para dúvidas sobre privacidade, fale com o responsável pelo Sinuca AI pelo próprio WhatsApp do serviço.</p>
`);

const DELETION_HTML = PAGE('Exclusão de dados', `
<h1>Exclusão de dados — Sinuca AI</h1>
<p>O Sinuca AI não guarda fotos, áudios nem textos depois de responder. Mesmo assim, se quiser confirmar a exclusão de qualquer dado ligado ao seu número, mande a mensagem <b>"apagar meus dados"</b> para o WhatsApp do serviço, ou fale com o responsável pelo Sinuca AI. Atendemos o pedido em até 7 dias.</p>
<p><a href="/privacidade">Ver a Política de Privacidade</a></p>
`);
