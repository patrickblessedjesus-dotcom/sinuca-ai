import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

const JPEG_URL = 'data:image/jpeg;base64,' + Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]).toString('base64');

function makeApp(analyze = vi.fn(async () => 'jogada')) {
  return { app: createApp({ demo: { code: 'codigo123', coach: { analyze } } }), analyze };
}

describe('página de demo', () => {
  it('serve a página', async () => {
    const res = await request(makeApp().app).get('/demo');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Sinuca AI');
  });

  it('exige o código de acesso', async () => {
    const { app, analyze } = makeApp();
    const res = await request(app).post('/demo/analyze').set('x-demo-code', 'errado').send({ image: JPEG_URL });
    expect(res.status).toBe(401);
    expect(analyze).not.toHaveBeenCalled();
  });

  it('analisa a foto com o código certo', async () => {
    const { app, analyze } = makeApp();
    const res = await request(app).post('/demo/analyze').set('x-demo-code', 'codigo123').send({ image: JPEG_URL });
    expect(res.status).toBe(200);
    expect(res.body.text).toBe('jogada');
    expect(analyze).toHaveBeenCalledOnce();
  });

  it('rejeita arquivo que não é imagem', async () => {
    const { app } = makeApp();
    const fake = 'data:image/jpeg;base64,' + Buffer.from('<html>').toString('base64');
    const res = await request(app).post('/demo/analyze').set('x-demo-code', 'codigo123').send({ image: fake });
    expect(res.status).toBe(400);
  });

  it('falha da OpenAI vira mensagem amigável', async () => {
    const { app } = makeApp(vi.fn(async () => { throw new Error('500'); }));
    const res = await request(app).post('/demo/analyze').set('x-demo-code', 'codigo123').send({ image: JPEG_URL });
    expect(res.status).toBe(502);
    expect(res.body.error).toContain('Não consegui analisar');
  });

  it('webhook fica desligado quando só a demo está configurada', async () => {
    const res = await request(makeApp().app).get('/webhook');
    expect(res.status).toBe(404);
  });

  it('config aceita só OPENAI_API_KEY + DEMO_CODE', () => {
    const c = loadConfig({ OPENAI_API_KEY: 'k', DEMO_CODE: 'codigo123' }, '');
    expect(c.whatsappEnabled).toBe(false);
    expect(c.demoCode).toBe('codigo123');
    expect(() => loadConfig({ OPENAI_API_KEY: 'k' }, '')).toThrow('DEMO_CODE');
  });
});
