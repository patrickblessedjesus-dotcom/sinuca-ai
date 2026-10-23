import { logger, maskPhone } from '../utils/logger.js';
import { MAX_IMAGE_BYTES, MediaError } from './media.js';

const GRAPH_HOST = 'https://graph.facebook.com';
const REQUEST_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 20_000;

/** Hosts dos quais a Meta serve arquivos de mídia. A URL só é aceita se vier da Graph API E bater aqui. */
const MEDIA_HOST_SUFFIXES = ['.fbsbx.com', '.facebook.com', '.fbcdn.net', '.whatsapp.net'];

export class WhatsAppApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: number,
  ) {
    super(message);
    this.name = 'WhatsAppApiError';
  }
}

export interface MediaInfo {
  url: string;
  mimeType?: string;
  fileSize?: number;
}

export interface WhatsAppClient {
  sendText(to: string, body: string): Promise<void>;
  getMediaInfo(mediaId: string): Promise<MediaInfo>;
  downloadMedia(info: MediaInfo): Promise<Uint8Array>;
}

export interface WhatsAppOptions {
  token: string;
  phoneNumberId: string;
  graphApiVersion: string;
  fetchImpl?: typeof fetch;
}

export function isAllowedMediaUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return false;
  const host = u.hostname.toLowerCase();
  return MEDIA_HOST_SUFFIXES.some((s) => host.endsWith(s));
}

/** Lê o erro da Graph API sem incluir cabeçalhos nem token. */
async function toApiError(res: Response, context: string): Promise<WhatsAppApiError> {
  let code: number | undefined;
  let detail = '';
  try {
    const data = (await res.json()) as { error?: { code?: number; message?: string } };
    code = data.error?.code;
    detail = (data.error?.message ?? '').slice(0, 200);
  } catch {
    /* corpo não-JSON */
  }
  return new WhatsAppApiError(`${context} falhou (HTTP ${res.status}${code ? `, código ${code}` : ''})${detail ? `: ${detail}` : ''}`, res.status, code);
}

export function createWhatsAppClient(opts: WhatsAppOptions): WhatsAppClient {
  const doFetch = opts.fetchImpl ?? fetch;
  const auth = { Authorization: `Bearer ${opts.token}` };
  const base = `${GRAPH_HOST}/${opts.graphApiVersion}`;

  return {
    async sendText(to, body) {
      const res = await doFetch(`${base}/${opts.phoneNumberId}/messages`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { preview_url: false, body } }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) {
        const err = await toApiError(res, 'Envio de mensagem');
        if (err.code === 131030) {
          logger.warn('Destinatário fora da lista permitida do número de teste. Em números brasileiros, cadastre o número também sem o 9º dígito.', { to: maskPhone(to) });
        }
        throw err;
      }
    },

    async getMediaInfo(mediaId) {
      if (!/^\d{1,40}$/.test(mediaId)) throw new MediaError('ID de mídia inválido.');
      const res = await doFetch(`${base}/${mediaId}`, { headers: auth, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (!res.ok) throw await toApiError(res, 'Consulta de mídia');
      const data = (await res.json()) as { url?: unknown; mime_type?: unknown; file_size?: unknown };
      if (typeof data.url !== 'string' || !isAllowedMediaUrl(data.url)) throw new MediaError('URL de mídia ausente ou fora dos domínios da Meta.');
      const fileSize = typeof data.file_size === 'number' ? data.file_size : Number(data.file_size);
      return {
        url: data.url,
        mimeType: typeof data.mime_type === 'string' ? data.mime_type : undefined,
        fileSize: Number.isFinite(fileSize) ? fileSize : undefined,
      };
    },

    async downloadMedia(info) {
      if (!isAllowedMediaUrl(info.url)) throw new MediaError('URL de mídia não permitida.');
      if (info.fileSize !== undefined && info.fileSize > MAX_IMAGE_BYTES) throw new MediaError('Imagem maior que o limite.');

      const res = await doFetch(info.url, {
        headers: { ...auth, 'User-Agent': 'sinuca-ai/0.1' },
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      });
      if (!res.ok) throw await toApiError(res, 'Download de mídia');
      // Se houve redirecionamento, o destino final também precisa ser da Meta.
      if (res.url && !isAllowedMediaUrl(res.url)) throw new MediaError('Redirecionamento de mídia para domínio não permitido.');

      const declared = Number(res.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) throw new MediaError('Imagem maior que o limite.');
      if (!res.body) throw new MediaError('Resposta de mídia vazia.');

      // Lê em partes e aborta se passar do limite, sem confiar no content-length.
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
      let offset = 0;
      for (const c of chunks) {
        out.set(c, offset);
        offset += c.byteLength;
      }
      return out;
    },
  };
}
