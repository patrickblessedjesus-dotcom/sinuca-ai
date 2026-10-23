import type { Coach } from './services/sinucaCoach.js';
import type { WhatsAppClient } from './services/whatsapp.js';
import { validateImage } from './services/media.js';
import { errorInfo, logger, maskPhone } from './utils/logger.js';

export const MSG_TEXT =
  'Fala! 🎱 Sou o treinador de sinuca em fase de testes. Manda uma foto nítida da mesa que eu analiso a situação e sugiro uma jogada.';
export const MSG_OTHER =
  'Por enquanto, nesta versão de testes, eu só consigo analisar fotos da mesa. 📸 Manda uma foto nítida que eu te ajudo!';
export const MSG_RECEIVED = 'Recebi a foto! 🎱 Vou analisar a mesa agora.';
export const MSG_ANALYSIS_ERROR =
  'Não consegui analisar essa foto agora. Tenta mandar novamente, de preferência com a mesa inteira e as bolas bem visíveis.';

export interface IncomingMessage {
  id: string;
  from: string;
  type: string;
  imageId?: string;
  imageMime?: string;
}

export interface HandlerDeps {
  whatsapp: WhatsAppClient;
  coach: Coach;
}

async function safeSend(whatsapp: WhatsAppClient, to: string, body: string): Promise<boolean> {
  try {
    await whatsapp.sendText(to, body);
    return true;
  } catch (err) {
    logger.error('Falha ao enviar mensagem', { to: maskPhone(to), ...errorInfo(err) });
    return false;
  }
}

/** Processa uma mensagem recebida. Nunca lança: erros são registrados e, se possível, o usuário é avisado. */
export async function handleMessage(msg: IncomingMessage, deps: HandlerDeps): Promise<void> {
  const { whatsapp, coach } = deps;
  const to = msg.from;

  if (msg.type === 'text') {
    await safeSend(whatsapp, to, MSG_TEXT);
    return;
  }

  if (msg.type !== 'image' || !msg.imageId) {
    await safeSend(whatsapp, to, MSG_OTHER);
    return;
  }

  await safeSend(whatsapp, to, MSG_RECEIVED);

  const started = Date.now();
  let reply: string;
  try {
    const info = await whatsapp.getMediaInfo(msg.imageId);
    const bytes = await whatsapp.downloadMedia(info);
    const mime = validateImage(bytes, info.mimeType ?? msg.imageMime);
    reply = await coach.analyze(bytes, mime);
    logger.info('Análise concluída', { to: maskPhone(to), ms: Date.now() - started, bytes: bytes.length });
  } catch (err) {
    logger.error('Falha na análise da foto', { to: maskPhone(to), ms: Date.now() - started, ...errorInfo(err) });
    await safeSend(whatsapp, to, MSG_ANALYSIS_ERROR);
    return;
  }

  await safeSend(whatsapp, to, reply);
}
