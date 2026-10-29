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

const MAX_CHARS = 700;

export function createVoice(opts: VoiceOptions): Voice {
  const doFetch = opts.fetchImpl ?? fetch;
  const cache = new Map<string, Uint8Array>();

  return {
    async speak(text, { cache: useCache = false } = {}) {
      const clean = text.trim().slice(0, MAX_CHARS);
      if (!clean) throw new Error('Texto vazio para a voz.');
      const hit = useCache ? cache.get(clean) : undefined;
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

export const SPOKEN_PHOTO_WAIT =
  'Recebi a mesa! Agora me manda um áudio contando a situação: qual é o jogo, par ou ímpar ou bolinho, quantas bolas cada um tem, e o que você tá pensando. Se quiser só a leitura da mesa, escreve analisa.';
