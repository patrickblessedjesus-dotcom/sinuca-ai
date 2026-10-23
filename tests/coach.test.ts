import { describe, expect, it, vi } from 'vitest';
import { loadConfig, ConfigError } from '../src/config.js';
import { handleMessage, MSG_ANALYSIS_ERROR, MSG_OTHER, MSG_RECEIVED, MSG_TEXT } from '../src/handler.js';
import { validateImage, MediaError } from '../src/services/media.js';
import { buildSystemPrompt, createCoach, type Coach } from '../src/services/sinucaCoach.js';
import { createWhatsAppClient, isAllowedMediaUrl, type WhatsAppClient } from '../src/services/whatsapp.js';

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const MEDIA_URL = 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1';

function fakeWhatsApp(over: Partial<WhatsAppClient> = {}) {
  const sent: string[] = [];
  const client: WhatsAppClient = {
    sendText: vi.fn(async (_to: string, body: string) => {
      sent.push(body);
    }),
    getMediaInfo: vi.fn(async () => ({ url: MEDIA_URL, mimeType: 'image/jpeg', fileSize: JPEG.length })),
    downloadMedia: vi.fn(async () => JPEG),
    ...over,
  };
  return { client, sent };
}

const okCoach = (): Coach => ({ analyze: vi.fn(async () => '🎱 Leitura da mesa:\nOk.') });
const image = { id: 'w1', from: '5511999998888', type: 'image', imageId: '999', imageMime: 'image/jpeg' };

describe('handleMessage', () => {
  it('responde texto pedindo uma foto', async () => {
    const { client, sent } = fakeWhatsApp();
    await handleMessage({ id: 't', from: '5511999998888', type: 'text' }, { whatsapp: client, coach: okCoach() });
    expect(sent).toEqual([MSG_TEXT]);
  });

  it('responde outros tipos dizendo que só aceita foto', async () => {
    const { client, sent } = fakeWhatsApp();
    await handleMessage({ id: 'a', from: '5511999998888', type: 'audio' }, { whatsapp: client, coach: okCoach() });
    expect(sent).toEqual([MSG_OTHER]);
  });

  it('fluxo de foto: aviso, análise e resposta', async () => {
    const { client, sent } = fakeWhatsApp();
    const coach = okCoach();
    await handleMessage(image, { whatsapp: client, coach });
    expect(sent).toEqual([MSG_RECEIVED, '🎱 Leitura da mesa:\nOk.']);
    expect(coach.analyze).toHaveBeenCalledWith(JPEG, 'image/jpeg');
  });

  it('falha no download da imagem gera mensagem amigável', async () => {
    const { client, sent } = fakeWhatsApp({ downloadMedia: vi.fn(async () => { throw new Error('HTTP 500'); }) });
    const coach = okCoach();
    await handleMessage(image, { whatsapp: client, coach });
    expect(sent).toEqual([MSG_RECEIVED, MSG_ANALYSIS_ERROR]);
    expect(coach.analyze).not.toHaveBeenCalled();
  });

  it('falha na OpenAI gera mensagem amigável', async () => {
    const { client, sent } = fakeWhatsApp();
    const coach: Coach = { analyze: vi.fn(async () => { throw Object.assign(new Error('rate limit'), { status: 429 }); }) };
    await handleMessage(image, { whatsapp: client, coach });
    expect(sent).toEqual([MSG_RECEIVED, MSG_ANALYSIS_ERROR]);
  });

  it('arquivo que não é imagem de verdade é rejeitado', async () => {
    const { client, sent } = fakeWhatsApp({ downloadMedia: vi.fn(async () => new TextEncoder().encode('<html>oi</html>')) });
    await handleMessage(image, { whatsapp: client, coach: okCoach() });
    expect(sent).toEqual([MSG_RECEIVED, MSG_ANALYSIS_ERROR]);
  });

  it('não lança se o envio pelo WhatsApp falhar', async () => {
    const { client } = fakeWhatsApp({ sendText: vi.fn(async () => { throw new Error('131030'); }) });
    await expect(handleMessage(image, { whatsapp: client, coach: okCoach() })).resolves.toBeUndefined();
  });
});

describe('sinucaCoach', () => {
  function fakeOpenAI(impl: () => Promise<unknown>) {
    const create = vi.fn(impl);
    return { create, client: { chat: { completions: { create } } } as never };
  }

  it('envia imagem como data URL e devolve o texto', async () => {
    const { create, client } = fakeOpenAI(async () => ({ choices: [{ message: { content: '  resposta  ' } }] }));
    const coach = createCoach({ apiKey: 'x', model: 'modelo-teste', client });
    expect(await coach.analyze(JPEG, 'image/jpeg')).toBe('resposta');
    const arg = create.mock.calls[0][0] as { model: string; messages: { content: unknown }[] };
    expect(arg.model).toBe('modelo-teste');
    expect(JSON.stringify(arg.messages[1].content)).toContain('data:image/jpeg;base64,');
  });

  it('propaga falha da API da OpenAI', async () => {
    const { client } = fakeOpenAI(async () => { throw new Error('500'); });
    await expect(createCoach({ apiKey: 'x', model: 'm', client }).analyze(JPEG, 'image/jpeg')).rejects.toThrow();
  });

  it('erro quando o modelo não retorna texto', async () => {
    const { client } = fakeOpenAI(async () => ({ choices: [{ message: { content: '' } }] }));
    await expect(createCoach({ apiKey: 'x', model: 'm', client }).analyze(JPEG, 'image/jpeg')).rejects.toThrow('não retornou');
  });

  it('inclui o conhecimento do treinador só quando existe', () => {
    expect(buildSystemPrompt('')).not.toContain('Conhecimento do treinador');
    expect(buildSystemPrompt('Jogue no seguro.')).toContain('Jogue no seguro.');
  });
});

describe('mídia e WhatsApp', () => {
  it('valida bytes reais e não só o MIME declarado', () => {
    expect(validateImage(JPEG, 'image/jpeg')).toBe('image/jpeg');
    expect(validateImage(PNG)).toBe('image/png');
    expect(() => validateImage(PNG, 'image/jpeg')).toThrow(MediaError);
    expect(() => validateImage(new Uint8Array(6 * 1024 * 1024).fill(0xff))).toThrow('limite');
  });

  it('aceita só URLs de mídia da Meta via https', () => {
    expect(isAllowedMediaUrl(MEDIA_URL)).toBe(true);
    expect(isAllowedMediaUrl('http://lookaside.fbsbx.com/x')).toBe(false);
    expect(isAllowedMediaUrl('https://evil.com/?x=fbsbx.com')).toBe(false);
    expect(isAllowedMediaUrl('https://fbsbx.com.evil.com/x')).toBe(false);
    expect(isAllowedMediaUrl('https://169.254.169.254/latest')).toBe(false);
  });

  it('getMediaInfo recusa URL fora da Meta e não loga o token', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ url: 'https://evil.com/a.jpg', mime_type: 'image/jpeg' })));
    const wa = createWhatsAppClient({ token: 'SEGREDO', phoneNumberId: '1', graphApiVersion: 'v23.0', fetchImpl: fetchImpl as never });
    await expect(wa.getMediaInfo('123')).rejects.toThrow(MediaError);
    await expect(wa.getMediaInfo('../etc')).rejects.toThrow('inválido');
  });

  it('downloadMedia aborta arquivo grande demais', async () => {
    const big = new Uint8Array(6 * 1024 * 1024);
    const fetchImpl = vi.fn(async () => new Response(big));
    const wa = createWhatsAppClient({ token: 't', phoneNumberId: '1', graphApiVersion: 'v23.0', fetchImpl: fetchImpl as never });
    await expect(wa.downloadMedia({ url: MEDIA_URL })).rejects.toThrow('limite');
  });

  it('sendText expõe código de erro da Meta sem o token', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: { code: 131030, message: 'Recipient not in allowed list' } }), { status: 400 }));
    const wa = createWhatsAppClient({ token: 'SEGREDO', phoneNumberId: '1', graphApiVersion: 'v23.0', fetchImpl: fetchImpl as never });
    const err = await wa.sendText('5511999998888', 'oi').catch((e: Error) => e);
    expect(String(err)).toContain('131030');
    expect(String(err)).not.toContain('SEGREDO');
  });
});

describe('config', () => {
  const base = { VERIFY_TOKEN: 'v', WHATSAPP_TOKEN: 'w', PHONE_NUMBER_ID: '123', OPENAI_API_KEY: 'k', APP_SECRET: 's' };

  it('carrega padrões', () => {
    const c = loadConfig(base, '');
    expect(c.graphApiVersion).toBe('v25.0');
    expect(c.openaiModel).toBeTruthy();
  });

  it('erro claro sem revelar valores', () => {
    try {
      loadConfig({ WHATSAPP_TOKEN: 'segredo-123' }, '');
      throw new Error('deveria falhar');
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as Error).message).toContain('VERIFY_TOKEN');
      expect((e as Error).message).not.toContain('segredo-123');
    }
  });

  it('exige APP_SECRET a menos que a verificação seja desligada explicitamente', () => {
    const { APP_SECRET: _omit, ...semSecret } = base;
    expect(() => loadConfig(semSecret, '')).toThrow('APP_SECRET');
    expect(loadConfig({ ...semSecret, SKIP_SIGNATURE_VERIFICATION: 'true' }, '').skipSignatureVerification).toBe(true);
  });
});
