import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { logger } from '../utils/logger.js';

/** Voz do ElevenLabs: transforma um texto curto em MP3. */
export interface Voice {
  speak(text: string, opts?: { cache?: boolean }): Promise<Uint8Array>;
}

export interface VoiceOptions {
  apiKey: string;
  voiceId: string;
  model: string;
  fetchImpl?: typeof fetch;
}

const MAX_CHARS = 900;

/** Corta no fim de uma frase para o áudio não terminar no meio. */
function cutAtSentence(t: string, max: number): string {
  if (t.length <= max) return t;
  const part = t.slice(0, max);
  const end = Math.max(part.lastIndexOf('. '), part.lastIndexOf('! '), part.lastIndexOf('? '));
  return end > max * 0.5 ? part.slice(0, end + 1) : part;
}

export function createVoice(opts: VoiceOptions): Voice {
  const doFetch = opts.fetchImpl ?? fetch;
  const cache = new Map<string, Uint8Array>();
  // Áudios gravados de verdade pelo Felipinho (MP3 na raiz do projeto) substituem a voz clonada.
  for (const [file, text] of Object.entries(RECORDED)) {
    const path = resolve(process.cwd(), file);
    try {
      if (existsSync(path)) {
        const bytes = new Uint8Array(readFileSync(path));
        if (bytes.byteLength > 1000) {
          cache.set(text.trim(), bytes);
          logger.info('Áudio gravado carregado', { file, kb: Math.round(bytes.byteLength / 1024) });
        }
      }
    } catch {
      /* sem o arquivo: usa a voz clonada */
    }
  }

  return {
    async speak(text, { cache: useCache = false } = {}) {
      const clean = cutAtSentence(text.trim(), MAX_CHARS);
      if (!clean) throw new Error('Texto vazio para a voz.');
      const hit = cache.get(text.trim()) ?? (useCache ? cache.get(clean) : undefined);
      if (hit) return hit;
      const res = await doFetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(opts.voiceId)}?output_format=mp3_44100_128`, {
        method: 'POST',
        headers: { 'xi-api-key': opts.apiKey, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
        body: JSON.stringify({ text: clean, model_id: opts.model, language_code: 'pt' }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        const detail = (await res.text().catch(() => '')).slice(0, 300);
        throw new Error(`ElevenLabs falhou (HTTP ${res.status}): ${detail}`);
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.byteLength < 100) throw new Error('ElevenLabs devolveu um áudio vazio.');
      if (useCache) cache.set(clean, bytes);
      logger.info('Áudio gerado', { chars: clean.length, cache: useCache });
      return bytes;
    },
  };
}

/** Tira emojis e símbolos de formatação para a voz não ler "asterisco". */
export function toSpeech(text: string): string {
  return text
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{20E3}]/gu, '')
    .replace(/[*_~`#>]/g, '')
    .replace(/\s*\n+\s*/g, '. ')
    .replace(/\.\s*\./g, '.')
    .replace(/:\s*\./g, ':')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** Recorta da análise só a parte "Minha escolha" + "Por quê". */
export function choicePart(analysis: string): string | null {
  const i = analysis.search(/minha escolha/i);
  if (i < 0) return null;
  const start = analysis.lastIndexOf('\n', i) + 1;
  const spoken = toSpeech(analysis.slice(start));
  return spoken.length >= 10 ? spoken : null;
}

/** Recorta só o bloco "Minha escolha" (texto, com emojis) para mandar depois da imagem. */
export function choiceText(analysis: string): string | null {
  const i = analysis.search(/minha escolha/i);
  if (i < 0) return null;
  const start = analysis.lastIndexOf('\n', i) + 1;
  const t = analysis.slice(start).trim();
  return t.length >= 10 ? t : null;
}

/** Mensagens faladas com a voz do Felipinho (ficam em cache: o ElevenLabs só cobra a primeira vez). */
export const SPOKEN_WELCOME =
  'E aí, meu parceiro! Aqui é o Felipinho, o rei da puxadinha. Manda a foto da mesa aí, que a gente vê o que tá acontecendo.';
export const SPOKEN_HOW_TO_PHOTO =
  'Ó, tira a foto assim: de cima, pegando a mesa inteira, com as seis caçapas aparecendo, igual essa aqui.';
export const SPOKEN_PHOTO_WAIT =
  'Boa, recebi a mesa! Agora me manda um áudio contando como tá o jogo: se é bolinho ou par ou ímpar, quantas bolas cada um tem, e o que você tá pensando em fazer.';
export const SPOKEN_AFTER_FREE =
  'E aí, curtiu? Essa foi tua análise grátis. Pra continuar comigo em todas as partidas, libera teu acesso no link aqui embaixo. Assim que pagar, eu te aviso e a gente segue jogando.';
export const SPOKEN_BLOCKED = 'Pra eu continuar te passando as jogadas, libera teu acesso no link aqui embaixo, que é rapidinho.';
export const SPOKEN_PAID = 'Pagamento confirmado, tá liberado! Agora manda a foto da mesa, que a gente vai pra cima.';

/** Arquivo gravado (na raiz do GitHub) → mensagem que ele substitui. */
const RECORDED: Record<string, string> = {
  'boas-vindas.mp3': SPOKEN_WELCOME,
  'como-tirar-foto.mp3': SPOKEN_HOW_TO_PHOTO,
  'foto-recebida.mp3': SPOKEN_PHOTO_WAIT,
  'analise-gratis.mp3': SPOKEN_AFTER_FREE,
  'acesso-bloqueado.mp3': SPOKEN_BLOCKED,
  'pagamento-confirmado.mp3': SPOKEN_PAID,
};
