import { createHmac, timingSafeEqual } from 'node:crypto';
import { logger, maskPhone } from '../utils/logger.js';
import { MAX_IMAGE_BYTES, MediaError } from './media.js';
import type { MediaInfo, WhatsAppClient } from './whatsapp.js';
import { isSafePublicUrl } from './zapi.js';

/** Cliente Twilio (WhatsApp via Twilio, incluindo o Sandbox). */
export interface TwilioOptions {
  accountSid: string;
  authToken: string;
  /** Remetente, ex.: whatsapp:+14155238886 (número do Sandbox). */
  from: string;
  fetchImpl?: typeof fetch;
}

/**
 * Valida o header X-Twilio-Signature: HMAC-SHA1 (base64) da URL completa
 * seguida dos parâmetros POST ordenados por nome (nome + valor concatenados).
 */
export function validTwilioSignature(authToken: string, url: string, params: Record<string, string>, signature: string | undefined): boolean {
  if (!signature) return false;
  const data = Object.keys(params)
    .sort()
    .reduce((acc, k) => acc + k + params[k], url);
  const expected = createHmac('sha1', authToken).update(data, 'utf8').digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createTwilioClient(opts: TwilioOptions): WhatsAppClient {
  const doFetch = opts.fetchImpl ?? fetch;
  const auth = 'Basic ' + Buffer.from(`${opts.accountSid}:${opts.authToken}`).toString('base64');

  return {
    async sendText(to, body) {
      const form = new URLSearchParams({ From: opts.from, To: `whatsapp:+${to.replace(/\D/g, '')}`, Body: body });
      const res = await doFetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(opts.accountSid)}/Messages.json`, {
        method: 'POST',
        headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        let detail = '';
        try {
          const j = (await res.json()) as { code?: number; message?: string };
          detail = `código ${j.code ?? '?'}: ${(j.message ?? '').slice(0, 200)}`;
        } catch {
          /* corpo não-JSON */
        }
        logger.warn('Twilio recusou o envio', { to: maskPhone(to), status: res.status });
        throw new Error(`Twilio Messages falhou (HTTP ${res.status})${detail ? ` ${detail}` : ''}`);
      }
    },

    // A URL da mídia já vem no webhook; o "id" é a própria URL.
    async getMediaInfo(url): Promise<MediaInfo> {
      let u: URL;
      try {
        u = new URL(url);
      } catch {
        throw new MediaError('URL de mídia inválida.');
      }
      if (u.protocol !== 'https:' || u.hostname !== 'api.twilio.com') throw new MediaError('URL de mídia fora da Twilio.');
      return { url };
    },

    async downloadMedia(info) {
      const u = new URL(info.url);
      if (u.protocol !== 'https:' || u.hostname !== 'api.twilio.com') throw new MediaError('URL de mídia fora da Twilio.');
      // A Twilio redireciona para o armazenamento dela; o fetch remove o Authorization ao trocar de domínio.
      const res = await doFetch(info.url, { headers: { Authorization: auth }, signal: AbortSignal.timeout(20_000) });
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
