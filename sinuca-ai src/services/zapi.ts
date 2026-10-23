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
    },

    // Na Z-API a URL da imagem já vem no webhook; o "id" é a própria URL.
    async getMediaInfo(url): Promise<MediaInfo> {
      if (!isSafePublicUrl(url)) throw new MediaError('URL de mídia não permitida.');
      return { url };
    },

    async downloadMedia(info) {
      if (!isSafePublicUrl(info.url)) throw new MediaError('URL de mídia não permitida.');
      const res = await doFetch(info.url, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new MediaError(`Download de mídia falhou (HTTP ${res.status}).`);
      if (res.url && !isSafePublicUrl(res.url)) throw new MediaError('Redirecionamento de mídia não permitido.');
      const declared = Number(res.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) throw new MediaError('Imagem maior que o limite.');
      if (!res.body) throw new MediaError('Resposta de mídia vazia.');
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_IMAGE_BYTES) {
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
