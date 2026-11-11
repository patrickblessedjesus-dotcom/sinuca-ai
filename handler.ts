import type { Coach, Diagram } from './services/sinucaCoach.js';
import type { WhatsAppClient } from './services/whatsapp.js';
import { MediaError, validateImage, type SupportedMime } from './services/media.js';
import { MSG_PAID, type Paywall } from './services/paywall.js';
import { choicePart, choiceText, toSpeech, SPOKEN_AFTER_FREE, SPOKEN_BLOCKED, SPOKEN_HOW_TO_PHOTO, SPOKEN_PHOTO_LOCKED, SPOKEN_QUESTION, SPOKEN_PHOTO_WAIT, SPOKEN_WELCOME, type Voice } from './services/voice.js';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { errorInfo, logger, maskPhone } from './utils/logger.js';

/** Foto de exemplo (foto-exemplo.png na raiz do GitHub): mostra como tirar a foto da mesa. */
export function loadExamplePhoto(): Uint8Array | null {
  try {
    const path = resolve(process.cwd(), 'foto-exemplo.png');
    if (!existsSync(path)) return null;
    const bytes = new Uint8Array(readFileSync(path));
    logger.info('Foto de exemplo carregada', { kb: Math.round(bytes.byteLength / 1024) });
    return bytes.byteLength > 1000 ? bytes : null;
  } catch {
    return null;
  }
}
export const MSG_EXAMPLE_CAPTION = '📸 Assim: de cima, mesa inteira, as 6 caçapas aparecendo.';

export const MSG_TEXT =
  'Fala! 🎱 Sou o treinador de sinuca em fase de testes. Manda uma foto da mesa (de cima, mesa inteira) e depois um áudio 🎤 ou texto contando a situação, que eu te passo as melhores jogadas.';
export const MSG_OTHER = 'Por enquanto eu entendo foto da mesa, áudio e texto. 📸🎤 Manda a foto da mesa e depois explica a situação!';
export const MSG_PHOTO_WAIT =
  '📸 Recebi a mesa! Agora me manda um áudio 🎤 ou texto contando a situação: qual o jogo (par ou ímpar, bolinho), quantas bolas cada um tem e o que você tá pensando. Se quiser só a leitura da mesa, manda "analisa".';
export const MSG_ANALYZING = '🎱 Analisando a mesa… já te mando as jogadas.';
export const MSG_ANALYSIS_ERROR =
  'Não consegui analisar essa foto agora. Tenta mandar novamente, de preferência com a mesa inteira e as bolas bem visíveis.';
export const MSG_AUDIO_ERROR = 'Não consegui entender o áudio. 🎤 Tenta de novo falando mais perto do celular, ou escreve a situação.';
export const MSG_BAD_IMAGE = 'Não consegui abrir essa foto. 📸 Manda de novo, em JPG ou PNG, com até 5 MB.';
/** Mantida por compatibilidade com a versão anterior. */
export const MSG_RECEIVED = MSG_ANALYZING;

const MAX_AUDIO_BYTES = 16 * 1024 * 1024;
/** Primeira mensagem tipo "oi": responde com as boas-vindas faladas. */
const GREETING = /^\s*(o+i+e*|ol[aá]+|opa+|ea[eií]+|e a[eií]+|salve+|fala+|bom dia|boa tarde|boa noite|hey|hello|tudo bem|beleza)(?![a-zà-ú])[\s!.,?]*\S{0,20}[\s!.,?]*$/i;
export const MSG_WELCOME =
  '🎱 Manda a foto da mesa (de cima, mesa inteira) e um áudio 🎤 contando como tá o jogo, que eu te passo as jogadas.\n\n💬 Ou manda qualquer pergunta de sinuca, por texto ou áudio, que a gente troca ideia: regra, ataque, efeito, como treinar, como sair de sinuca…';
export const MSG_WELCOME_FREE = `${MSG_WELCOME}\n\nSua 1ª análise é grátis! 🎁`;
export const MSG_QUESTION =
  '🎱 Qual é a tua maior dificuldade na sinuca? Matar a bola, controlar a branca, sair de sinuca… Me conta rapidinho (texto ou áudio) que eu te dou uma dica grátis.';
export const MSG_PHOTO_LOCKED =
  '📸 A leitura da mesa com as jogadas é só pra assinante. Antes, ganha uma dica grátis: me conta tua maior dificuldade na sinuca (texto ou áudio).';

/** Pergunta para a IA dar a dica grátis sobre a dificuldade que o jogador contou. */
function freeTipPrompt(text: string): string {
  return `O jogador ainda NÃO é assinante e está testando. Ele contou qual é a maior dificuldade dele na sinuca: "${text.slice(0, 1200)}".
Responda como o Felipinho, em primeira pessoa, falando com ele: dê UMA dica prática e certeira pra essa dificuldade (o que fazer na próxima partida), em no máximo cerca de 60 palavras. Se ele não falou de uma dificuldade de sinuca, dê uma dica rápida de controle da branca. Termine com uma frase curta dizendo que, assinando, é só mandar a foto da mesa que você mostra a jogada certa na hora.`;
}
const ONLY_TABLE = /^\s*(analisa|analise|analisar|vai|bora|s[oó] a mesa|l[eê] a mesa)\b/i;

export interface IncomingMessage {
  id: string;
  from: string;
  type: string;
  imageId?: string;
  imageMime?: string;
  audioId?: string;
  audioMime?: string;
  /** Texto da mensagem (ou legenda da foto). */
  text?: string;
}

export type RenderPlan = (d: Diagram, photo: Uint8Array, mime: SupportedMime) => { png: Uint8Array; caption: string } | null;

export interface HandlerDeps {
  whatsapp: WhatsAppClient;
  coach: Coach;
  /** Desenha os traçados em cima da foto (opcional). */
  render?: RenderPlan;
  /** Cobrança: sem ele, todo mundo usa à vontade. */
  paywall?: Paywall;
  /** Voz (ElevenLabs) para algumas mensagens. */
  voice?: Voice;
  /** Preenchido pelo próprio handler: este número está na análise grátis. */
  free?: boolean;
}

export interface ConversationOptions {
  /** Por quanto tempo a foto fica guardada esperando a explicação. */
  photoTtlMs?: number;
  /** Por quanto tempo uma explicação mandada ANTES da foto vale pra próxima foto. */
  situationTtlMs?: number;
  /** Espera antes de responder um texto/áudio sem foto (caso a foto chegue logo depois). 0 = responde na hora. */
  askDelayMs?: number;
  now?: () => number;
  /** Foto de exemplo (para testes). Padrão: foto-exemplo.png da raiz. */
  examplePhoto?: Uint8Array | null;
}

interface Session {
  /** Já recebeu as boas-vindas nesta sessão. */
  greeted?: boolean;
  /** Já recebeu a foto de exemplo nesta sessão. */
  exampleSent?: boolean;
  /** Já ouviu a pergunta da maior dificuldade. */
  questionSent?: boolean;
  photo?: { bytes: Uint8Array; mime: SupportedMime; at: number };
  situation?: { text: string; at: number };
  pendingAsk?: { timer: ReturnType<typeof setTimeout>; text: string; heard?: string };
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

/** Manda um áudio falado. Devolve false se não deu (aí quem chamou manda texto). */
async function safeVoice(deps: HandlerDeps, to: string, text: string | null, cache = false): Promise<boolean> {
  if (!text || !deps.voice || !deps.whatsapp.sendAudio) return false;
  try {
    const mp3 = await deps.voice.speak(text, { cache });
    await deps.whatsapp.sendAudio(to, mp3);
    return true;
  } catch (err) {
    logger.warn('Não consegui mandar o áudio; seguindo só com texto', { to: maskPhone(to), ...errorInfo(err) });
    return false;
  }
}

const heardPrefix = (heard?: string) => (heard ? `🗣️ "${heard}"\n\n` : '');

/**
 * Conversa no WhatsApp: o jogador manda a foto e o áudio/texto (em qualquer ordem) e recebe uma análise só.
 * As mensagens de cada remetente são processadas em fila, uma de cada vez.
 */
export function createConversations(opts: ConversationOptions = {}) {
  const photoTtl = opts.photoTtlMs ?? 10 * 60_000;
  const situationTtl = opts.situationTtlMs ?? 3 * 60_000;
  const askDelay = opts.askDelayMs ?? 5_000;
  const now = opts.now ?? Date.now;
  const sessions = new Map<string, Session>();
  const examplePhoto = opts.examplePhoto !== undefined ? opts.examplePhoto : loadExamplePhoto();
  const queues = new Map<string, Promise<void>>();

  const session = (from: string): Session => {
    let s = sessions.get(from);
    if (!s) {
      if (sessions.size > 5_000) {
        for (const [k, v] of sessions) if (!v.pendingAsk && (!v.photo || now() - v.photo.at > photoTtl)) sessions.delete(k);
      }
      s = {};
      sessions.set(from, s);
    }
    return s;
  };

  function enqueue(from: string, job: () => Promise<void>): Promise<void> {
    const prev = queues.get(from) ?? Promise.resolve();
    const next = prev.then(job, job).catch((err) => logger.error('Erro na fila de mensagens', errorInfo(err)));
    queues.set(from, next);
    void next.finally(() => {
      if (queues.get(from) === next) queues.delete(from);
    });
    return next;
  }

  async function analyze(to: string, photo: NonNullable<Session['photo']>, situation: string | undefined, heard: string | undefined, deps: HandlerDeps) {
    const { whatsapp, coach } = deps;
    await safeSend(whatsapp, to, MSG_ANALYZING);
    const started = now();
    try {
      if (coach.plan) {
        const plan = await coach.plan(photo.bytes, photo.mime, situation);
        let imageSent = false;
        if (plan.diagram && deps.render && whatsapp.sendImage) {
          try {
            const img = deps.render(plan.diagram, photo.bytes, photo.mime);
            if (img) {
              await whatsapp.sendImage(to, img.png, img.caption);
              imageSent = true;
            }
          } catch (err) {
            logger.warn('Não consegui mandar a imagem das jogadas; seguindo só com o texto', errorInfo(err));
          }
        }
        // Com a imagem (que já lista as 3 jogadas), o texto é só a melhor escolha.
        const text = (imageSent && choiceText(plan.text)) || plan.text;
        await safeSend(whatsapp, to, heardPrefix(heard) + text);
        await safeVoice(deps, to, plan.speech ? toSpeech(plan.speech) : choicePart(plan.text));
      } else {
        await safeSend(whatsapp, to, heardPrefix(heard) + (await coach.analyze(photo.bytes, photo.mime, situation)));
      }
      logger.info('Análise concluída', { to: maskPhone(to), ms: now() - started, situation: Boolean(situation), free: Boolean(deps.free) });
      if (deps.free && deps.paywall) {
        deps.paywall.useFree(to);
        await safeVoice(deps, to, SPOKEN_AFTER_FREE, true);
        await safeSend(whatsapp, to, await deps.paywall.payMessage(to));
      }
    } catch (err) {
      logger.error('Falha na análise da foto', { to: maskPhone(to), ms: now() - started, ...errorInfo(err) });
      await safeSend(whatsapp, to, MSG_ANALYSIS_ERROR);
    }
  }

  async function answer(to: string, text: string, heard: string | undefined, deps: HandlerDeps, welcome = false) {
    // Boas-vindas faladas no "oi" (e pra quem ainda está na análise grátis).
    // Teste grátis sem foto: a pessoa contou a dificuldade dela → uma dica em áudio, e aí o link.
    if (deps.free && !welcome && !GREETING.test(text) && deps.coach.ask && deps.paywall) {
      try {
        const started = now();
        const tip = await deps.coach.ask(freeTipPrompt(text));
        logger.info('Dica grátis respondida', { to: maskPhone(to), ms: now() - started });
        if (!(await safeVoice(deps, to, toSpeech(tip)))) await safeSend(deps.whatsapp, to, heardPrefix(heard) + tip);
        deps.paywall.useFree(to);
        await safeVoice(deps, to, SPOKEN_AFTER_FREE, true);
        await safeSend(deps.whatsapp, to, await deps.paywall.payMessage(to));
      } catch (err) {
        logger.error('Falha na dica grátis', { to: maskPhone(to), ...errorInfo(err) });
        await safeSend(deps.whatsapp, to, MSG_QUESTION);
      }
      return;
    }
    if (deps.free || welcome || GREETING.test(text)) {
      await safeVoice(deps, to, SPOKEN_WELCOME, true);
      if (deps.free) {
        // Quem ainda não pagou: pergunta a maior dificuldade (dá pra testar sem estar na mesa).
        const s = session(to);
        if (!s.questionSent) {
          s.questionSent = true;
          await safeVoice(deps, to, SPOKEN_QUESTION, true);
        }
        await safeSend(deps.whatsapp, to, MSG_QUESTION);
        return;
      }
      await safeSend(deps.whatsapp, to, MSG_WELCOME);
      // Uma vez por conversa: áudio explicando + foto de exemplo de como tirar a foto da mesa.
      const s = session(to);
      if (examplePhoto && !s.exampleSent && deps.whatsapp.sendImage) {
        s.exampleSent = true;
        await safeVoice(deps, to, SPOKEN_HOW_TO_PHOTO, true);
        try {
          await deps.whatsapp.sendImage(to, examplePhoto, MSG_EXAMPLE_CAPTION);
        } catch (err) {
          logger.warn('Não consegui mandar a foto de exemplo', { to: maskPhone(to), ...errorInfo(err) });
        }
      }
      return;
    }
    if (!deps.coach.ask) {
      await safeSend(deps.whatsapp, to, MSG_TEXT);
      return;
    }
    try {
      const started = now();
      const reply = await deps.coach.ask(text);
      logger.info('Pergunta respondida pela IA', { to: maskPhone(to), ms: now() - started });
      // Resposta em áudio com a voz; se a voz falhar, vai em texto.
      if (!(await safeVoice(deps, to, toSpeech(reply)))) await safeSend(deps.whatsapp, to, heardPrefix(heard) + reply);
    } catch (err) {
      logger.error('Falha ao responder texto', { to: maskPhone(to), ...errorInfo(err) });
      await safeSend(deps.whatsapp, to, MSG_TEXT);
    }
  }

  /** Texto ou áudio já transcrito. */
  async function onText(to: string, text: string, heard: string | undefined, deps: HandlerDeps) {
    const s = session(to);
    if (s.photo && now() - s.photo.at <= photoTtl) {
      const photo = s.photo;
      s.photo = undefined;
      await analyze(to, photo, ONLY_TABLE.test(text) ? undefined : text, heard, deps);
      return;
    }
    // "Oi" e afins não são a explicação da jogada: responde as boas-vindas e não guarda nada.
    const first = !s.greeted;
    s.greeted = true;
    if (GREETING.test(text) || (first && text.length <= 30 && !text.includes('?'))) {
      if (s.pendingAsk) clearTimeout(s.pendingAsk.timer);
      s.pendingAsk = undefined;
      s.situation = undefined;
      await answer(to, text, heard, deps, true);
      return;
    }
    // Sem foto: guarda como situação (se a foto vier logo depois, usa) e responde como pergunta.
    s.situation = { text, at: now() };
    if (askDelay <= 0) {
      await answer(to, text, heard, deps);
      return;
    }
    if (s.pendingAsk) clearTimeout(s.pendingAsk.timer);
    const timer = setTimeout(() => {
      const cur = sessions.get(to);
      if (cur?.pendingAsk?.timer !== timer) return;
      cur.pendingAsk = undefined;
      void enqueue(to, () => answer(to, text, heard, deps));
    }, askDelay);
    s.pendingAsk = { timer, text, heard };
  }

  async function process(msg: IncomingMessage, baseDeps: HandlerDeps) {
    const to = msg.from;
    let deps = baseDeps;
    if (baseDeps.paywall) {
      let access = await baseDeps.paywall.check(to);
      // Pagou pela Hotmart mas não foi reconhecido: manda o e-mail da compra pra liberar.
      const claim = (baseDeps.paywall as Paywall & { claim?: (phone: string, text: string) => Promise<string> }).claim;
      if (access !== 'paid' && claim && msg.type === 'text' && msg.text?.includes('@')) {
        try {
          const r = await claim(to, msg.text);
          if (r === 'ok') {
            await safeSend(baseDeps.whatsapp, to, MSG_PAID);
            return;
          }
          if (r === 'notfound') {
            await safeSend(
              baseDeps.whatsapp,
              to,
              'Não achei compra aprovada com esse e-mail. 🤔 Confere se é o mesmo e-mail da Hotmart. Se pagou no boleto ou o Pix ainda está processando, espera uns minutinhos e manda de novo.',
            );
            return;
          }
        } catch (err) {
          logger.error('Falha ao liberar pelo e-mail', { to: maskPhone(to), ...errorInfo(err) });
        }
        access = await baseDeps.paywall.check(to);
      }
      if (access === 'blocked') {
        // Sem teste grátis: na primeira mensagem, boas-vindas faladas antes do áudio do link.
        const s = session(to);
        if (!s.greeted) {
          s.greeted = true;
          await safeVoice(baseDeps, to, SPOKEN_WELCOME, true);
        }
        await safeVoice(baseDeps, to, SPOKEN_BLOCKED, true);
        await safeSend(baseDeps.whatsapp, to, await baseDeps.paywall.payMessage(to));
        return;
      }
      deps = { ...baseDeps, free: access === 'free' };
      // Teste grátis é só a dica: a leitura da mesa (foto) é só pra assinante.
      if (access === 'free' && msg.type === 'image') {
        await safeVoice(baseDeps, to, SPOKEN_PHOTO_LOCKED, true);
        await safeSend(baseDeps.whatsapp, to, MSG_PHOTO_LOCKED);
        const s = session(to);
        s.questionSent = true;
        s.greeted = true;
        return;
      }
      // Plano Só Texto: sem áudio com a voz.
      const planOf = (baseDeps.paywall as Paywall & { plan?: (phone: string) => Promise<string | null> }).plan;
      if (access === 'paid' && planOf && deps.voice) {
        try {
          if ((await planOf(to)) === 'texto') deps = { ...deps, voice: undefined };
        } catch (err) {
          logger.warn('Não consegui ler o plano', errorInfo(err));
        }
      }
    }
    const { whatsapp, coach } = deps;

    if (msg.type === 'text') {
      const text = msg.text?.trim();
      if (!text) {
        await safeSend(whatsapp, to, MSG_TEXT);
        return;
      }
      await onText(to, text, undefined, deps);
      return;
    }

    if (msg.type === 'audio' && msg.audioId) {
      if (!coach.transcribe) {
        await safeSend(whatsapp, to, MSG_OTHER);
        return;
      }
      let heard: string;
      try {
        const info = await whatsapp.getMediaInfo(msg.audioId);
        const bytes = await whatsapp.downloadMedia(info, MAX_AUDIO_BYTES);
        const mime = (info.mimeType ?? msg.audioMime ?? 'audio/ogg').split(';')[0].trim().toLowerCase();
        const ext = { 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'mp4', 'audio/aac': 'm4a', 'audio/amr': 'amr', 'audio/webm': 'webm', 'audio/wav': 'wav' }[mime] ?? 'ogg';
        heard = await coach.transcribe(bytes, `audio.${ext}`);
      } catch (err) {
        logger.error('Falha ao transcrever áudio', { to: maskPhone(to), ...errorInfo(err) });
        await safeSend(whatsapp, to, MSG_AUDIO_ERROR);
        return;
      }
      await onText(to, heard, heard, deps);
      return;
    }

    if (msg.type === 'image' && msg.imageId) {
      let photo: NonNullable<Session['photo']>;
      try {
        const info = await whatsapp.getMediaInfo(msg.imageId);
        const bytes = await whatsapp.downloadMedia(info);
        photo = { bytes, mime: validateImage(bytes, info.mimeType ?? msg.imageMime), at: now() };
      } catch (err) {
        logger.error('Falha ao baixar a foto', { to: maskPhone(to), ...errorInfo(err) });
        await safeSend(whatsapp, to, err instanceof MediaError ? MSG_BAD_IMAGE : MSG_ANALYSIS_ERROR);
        return;
      }
      const s = session(to);
      // Legenda da foto vale como explicação.
      const caption = msg.text?.trim();
      if (caption) {
        if (s.pendingAsk) clearTimeout(s.pendingAsk.timer);
        s.pendingAsk = undefined;
        s.situation = undefined;
        await analyze(to, photo, ONLY_TABLE.test(caption) ? undefined : caption, undefined, deps);
        return;
      }
      // Explicação que chegou antes da foto.
      if (s.pendingAsk) {
        clearTimeout(s.pendingAsk.timer);
        const { text, heard } = s.pendingAsk;
        s.pendingAsk = undefined;
        s.situation = undefined;
        await analyze(to, photo, text, heard, deps);
        return;
      }
      // Regra: foto sozinha nunca analisa direto. Pede o áudio contando a situação primeiro.
      s.situation = undefined;
      s.photo = photo;
      if (!(await safeVoice(deps, to, SPOKEN_PHOTO_WAIT, true))) await safeSend(whatsapp, to, MSG_PHOTO_WAIT);
      return;
    }

    await safeSend(whatsapp, to, MSG_OTHER);
  }

  return {
    /** Processa uma mensagem. Nunca lança. */
    handle(msg: IncomingMessage, deps: HandlerDeps): Promise<void> {
      return enqueue(msg.from, () => process(msg, deps));
    },
  };
}
