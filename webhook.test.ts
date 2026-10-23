import { createHmac } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { extractMessages, isAllowed, phoneVariants } from '../src/routes/webhook.js';

const SECRET = 'app-secret-de-teste';

function makeApp(over: Partial<Parameters<typeof createApp>[0]> = {}) {
  const onMessage = vi.fn().mockResolvedValue(undefined);
  const app = createApp({
    verifyToken: 'token-certo',
    appSecret: SECRET,
    skipSignatureVerification: false,
    allowedNumbers: [],
    onMessage,
    ...over,
  });
  return { app, onMessage };
}

function sign(body: string, secret = SECRET) {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}

function payload(messages: unknown[] | undefined, extra: Record<string, unknown> = {}) {
  return {
    object: 'whatsapp_business_account',
    entry: [{ id: '1', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', ...(messages ? { messages } : {}), ...extra } }] }],
  };
}

async function post(app: ReturnType<typeof makeApp>['app'], body: unknown, signature?: string) {
  const raw = JSON.stringify(body);
  return request(app)
    .post('/webhook')
    .set('Content-Type', 'application/json')
    .set('X-Hub-Signature-256', signature ?? sign(raw))
    .send(raw);
}

const textMsg = (id = 'wamid.1', from = '5511999998888') => ({ id, from, type: 'text', timestamp: '1', text: { body: 'oi' } });

describe('GET /webhook (verificação)', () => {
  it('devolve o challenge com token correto', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/webhook').query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'token-certo', 'hub.challenge': '12345' });
    expect(res.status).toBe(200);
    expect(res.text).toBe('12345');
  });

  it('retorna 403 com token incorreto', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/webhook').query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'errado', 'hub.challenge': '12345' });
    expect(res.status).toBe(403);
  });

  it('retorna 403 sem parâmetros', async () => {
    const { app } = makeApp();
    expect((await request(app).get('/webhook')).status).toBe(403);
  });
});

describe('POST /webhook', () => {
  it('rejeita assinatura inválida', async () => {
    const { app, onMessage } = makeApp();
    const res = await post(app, payload([textMsg()]), sign('outro corpo'));
    expect(res.status).toBe(401);
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('aceita sem assinatura quando SKIP_SIGNATURE_VERIFICATION está ativo', async () => {
    const { app, onMessage } = makeApp({ appSecret: undefined, skipSignatureVerification: true });
    const res = await post(app, payload([textMsg()]), 'sha256=qualquer');
    expect(res.status).toBe(200);
    expect(onMessage).toHaveBeenCalledOnce();
  });

  it('trata mensagem de texto encaminhando ao processador', async () => {
    const { app, onMessage } = makeApp();
    const res = await post(app, payload([textMsg()]));
    expect(res.status).toBe(200);
    expect(onMessage).toHaveBeenCalledWith({ id: 'wamid.1', from: '5511999998888', type: 'text' });
  });

  it('ignora eventos só de status de entrega', async () => {
    const { app, onMessage } = makeApp();
    const res = await post(app, payload(undefined, { statuses: [{ id: 'wamid.x', status: 'delivered', recipient_id: '5511999998888' }] }));
    expect(res.status).toBe(200);
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('ignora mensagens sem campos obrigatórios sem quebrar', async () => {
    const { app, onMessage } = makeApp();
    const res = await post(app, payload([{ type: 'text' }, { id: 'x', type: 'text' }, null, 'lixo']));
    expect(res.status).toBe(200);
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('deduplica IDs repetidos', async () => {
    const { app, onMessage } = makeApp();
    await post(app, payload([textMsg('wamid.dup')]));
    await post(app, payload([textMsg('wamid.dup')]));
    expect(onMessage).toHaveBeenCalledOnce();
  });

  it('ignora remetentes fora de ALLOWED_NUMBERS', async () => {
    const { app, onMessage } = makeApp({ allowedNumbers: ['5521911112222'] });
    await post(app, payload([textMsg('a', '5511999998888')]));
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('rejeita JSON inválido com 400', async () => {
    const { app } = makeApp({ skipSignatureVerification: true });
    const res = await request(app).post('/webhook').set('Content-Type', 'application/json').send('{quebrado');
    expect(res.status).toBe(400);
  });
});

describe('utilitários', () => {
  it('extrai dados de imagem', () => {
    const msgs = extractMessages(payload([{ id: 'i1', from: '5511999998888', type: 'image', image: { id: '123', mime_type: 'image/jpeg' } }]));
    expect(msgs).toEqual([{ id: 'i1', from: '5511999998888', type: 'image', imageId: '123', imageMime: 'image/jpeg' }]);
  });

  it('casa números brasileiros com e sem o 9º dígito', () => {
    expect(phoneVariants('5511999998888')).toContain('551199998888');
    expect(isAllowed('551199998888', ['5511999998888'])).toBe(true);
    expect(isAllowed('5511999998888', ['551199998888'])).toBe(true);
    expect(isAllowed('5511999998888', [])).toBe(true);
  });
});
