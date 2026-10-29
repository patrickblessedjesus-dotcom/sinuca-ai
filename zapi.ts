import { logger, maskPhone } from '../utils/logger.js';
import { MAX_IMAGE_BYTES, MediaError } from './media.js';
import type { MediaInfo, WhatsAppClient } from './whatsapp.js';

/**
 * Cliente Z-API (API NÃO OFICIAL do WhatsApp, via WhatsApp Web).
 * Uso apenas para demonstração: o número conectado pode ser banido pelo WhatsApp.
 */
const BASE = 'https://api.z-api.io';
const TIMEOUT_MS = 15_000;

export interface ZapiOptions {
  instanceId: string;
  token: string;
  clientToken?: string;
  fetchImpl?: typeof fetch;
}

/** URL de mídia aceitável: https, sem credenciais, sem porta e sem IP literal/host interno. */
export function isSafePublicUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return false;
  const host = u.hostname.toLowerCase();
  if (!host.includes('.') || host.endsWith('.local') || host.endsWith('.internal') || host === 'localhost') return false;
  if (/^[\d.]+$/.test(host) || host.startsWith('[') || host.includes(':')) return false; // IP literal
  return true;
}

export function createZapiClient(opts: ZapiOptions): WhatsAppClient {
  const doFetch = opts.fetchImpl ?? fetch;
  const base = `${BASE}/instances/${encodeURIComponent(opts.instanceId)}/token/${encodeURIComponent(opts.token)}`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.clientToken) headers['Client-Token'] = opts.clientToken;

  return {
    async sendText(to, body) {
      const res = await doFetch(`${base}/send-text`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ phone: to, message: body }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) {
        let detail = '';
        try {
          detail = JSON.stringify(await res.json()).slice(0, 200);
        } catch {
          /* corpo não-JSON */
        }
        logger.warn('Z-API recusou o envio', { to: maskPhone(to), status: res.status });
        throw new Error(`Z-API send-text falhou (HTTP ${res.status})${detail ? `: ${detail}` : ''}`);
      }
      logger.info('Z-API aceitou a mensagem', { to: maskPhone(to) });
    },

    async sendAudio(to, mp3) {
      const audio = 'data:audio/mpeg;base64,' + Buffer.from(mp3).toString('base64');
      const res = await doFetch(`${base}/send-audio`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ phone: to, audio, waveform: true }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        logger.warn('Z-API recusou o áudio', { to: maskPhone(to), status: res.status });
        throw new Error(`Z-API send-audio falhou (HTTP ${res.status})`);
      }
    },

    async sendImage(to, png, caption) {
      const image = 'data:image/png;base64,' + Buffer.from(png).toString('base64');
      const res = await doFetch(`${base}/send-image`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ phone: to, image, ...(caption ? { caption: caption.slice(0, 1000) } : {}) }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        logger.warn('Z-API recusou a imagem', { to: maskPhone(to), status: res.status });
        throw new Error(`Z-API send-image falhou (HTTP ${res.status})`);
      }
    },

    // Na Z-API a URL da imagem já vem no webhook; o "id" é a própria URL.
    async getMediaInfo(url): Promise<MediaInfo> {
      if (!isSafePublicUrl(url)) throw new MediaError('URL de mídia não permitida.');
      return { url };
    },

    async downloadMedia(info, maxBytes = MAX_IMAGE_BYTES) {
      if (!isSafePublicUrl(info.url)) throw new MediaError('URL de mídia não permitida.');
      const res = await doFetch(info.url, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new MediaError(`Download de mídia falhou (HTTP ${res.status}).`);
      if (res.url && !isSafePublicUrl(res.url)) throw new MediaError('Redirecionamento de mídia não permitido.');
      const declared = Number(res.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > maxBytes) throw new MediaError('Imagem maior que o limite.');
      if (!res.body) throw new MediaError('Resposta de mídia vazia.');
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          throw new MediaError('Imagem maior que o limite.');
        }
        chunks.push(value);
      }
      const out = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) {
        out.set(c, off);
        off += c.byteLength;
      }
      return out;
    },
  };
}
