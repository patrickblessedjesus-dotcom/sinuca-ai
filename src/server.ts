import 'dotenv/config';
import { createApp } from './app.js';
import { ConfigError, loadConfig } from './config.js';
import { handleMessage } from './handler.js';
import { createCoach } from './services/sinucaCoach.js';
import { createWhatsAppClient } from './services/whatsapp.js';
import { errorInfo, logger } from './utils/logger.js';

let config;
try {
  config = loadConfig();
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(`[config] ${err.message}`);
    process.exit(1);
  }
  throw err;
}

if (config.whatsappEnabled && config.skipSignatureVerification) {
  logger.warn('SKIP_SIGNATURE_VERIFICATION=true: assinatura do webhook NÃO será verificada. Use só em desenvolvimento.');
}

const coach = createCoach({ apiKey: config.openaiApiKey, model: config.openaiModel, knowledge: config.knowledge });

const whatsapp = config.whatsappEnabled
  ? createWhatsAppClient({ token: config.whatsappToken, phoneNumberId: config.phoneNumberId, graphApiVersion: config.graphApiVersion })
  : undefined;

const app = createApp({
  webhook: whatsapp
    ? {
        verifyToken: config.verifyToken,
        appSecret: config.appSecret,
        skipSignatureVerification: config.skipSignatureVerification,
        allowedNumbers: config.allowedNumbers,
        onMessage: (msg) => handleMessage(msg, { whatsapp, coach }),
      }
    : undefined,
  demo: config.demoCode ? { code: config.demoCode, coach } : undefined,
});

const server = app.listen(config.port, () => {
  logger.info('Sinuca AI no ar', {
    port: config.port,
    model: config.openaiModel,
    whatsapp: config.whatsappEnabled,
    demo: Boolean(config.demoCode),
    graphApiVersion: config.graphApiVersion,
    knowledgeLoaded: config.knowledge.length > 0,
    allowedNumbers: config.allowedNumbers.length,
  });
});

function shutdown(signal: string) {
  logger.info('Encerrando servidor', { signal });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (err) => logger.error('Promise rejeitada sem tratamento', errorInfo(err)));
