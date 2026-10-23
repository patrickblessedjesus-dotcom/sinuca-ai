/** Validação de imagens recebidas: tamanho e tipo real pelos bytes (magic numbers). */

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // limite de imagem do WhatsApp
export const SUPPORTED_MIME = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type SupportedMime = (typeof SUPPORTED_MIME)[number];

export class MediaError extends Error {}

/** Detecta o tipo pelos primeiros bytes. Retorna null se não for um formato aceito. */
export function detectImageMime(bytes: Uint8Array): SupportedMime | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) return 'image/png';
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' &&
    String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP'
  ) return 'image/webp';
  return null;
}

/** Valida a imagem e devolve o MIME detectado pelos bytes. Lança MediaError se inválida. */
export function validateImage(bytes: Uint8Array, declaredMime?: string): SupportedMime {
  if (bytes.length === 0) throw new MediaError('Imagem vazia.');
  if (bytes.length > MAX_IMAGE_BYTES) throw new MediaError('Imagem maior que o limite.');
  const detected = detectImageMime(bytes);
  if (!detected) throw new MediaError('Formato de imagem não suportado.');
  const declared = declaredMime?.split(';')[0].trim().toLowerCase();
  if (declared && declared !== detected) throw new MediaError('MIME declarado não confere com o conteúdo.');
  return detected;
}

export function toDataUrl(bytes: Uint8Array, mime: SupportedMime): string {
  return `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
}
