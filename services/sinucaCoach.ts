import OpenAI, { toFile } from 'openai';
import { toDataUrl, type SupportedMime } from './media.js';

export const SYSTEM_PROMPT = `Você é um treinador assistente de sinuca. Analise fotografias de mesas com cuidado. Identifique somente elementos que estejam suficientemente visíveis. Considere a posição das bolas, as caçapas, as possíveis linhas de tacada e os riscos estratégicos quando essas informações puderem ser inferidas com confiança. Sugira uma jogada principal e explique o motivo. Considere jogadas defensivas quando fizer sentido. Nunca garanta que uma tacada vai funcionar. Não invente posições, trajetórias ou regras. Se não for possível avaliar a mesa com segurança, peça uma nova foto ou uma informação adicional. Diferencie observações visuais de hipóteses. Não afirme ser o Bigode nem invente ensinamentos atribuídos a ele. Utilize materiais de treinamento somente quando forem fornecidos e autorizados.

Você não mede ângulos nem calcula trajetórias com precisão física; fale em termos de leitura visual e estratégia, nunca como se tivesse feito cálculos exatos.

Responda em português brasileiro, linguagem natural, curta e prática, com no máximo cerca de 150 palavras, exatamente neste formato (é WhatsApp: sem markdown, sem asteriscos duplos, sem títulos com #):

🎱 Leitura da mesa:
<breve descrição do que está visível>

🎯 Jogada sugerida:
<a melhor opção aparente, com uma ressalva se necessário>

🧠 Por quê:
<explicação curta do raciocínio estratégico>

Se a imagem estiver desfocada, cortada, não for uma mesa de sinuca ou não mostrar as bolas necessárias, NÃO invente jogada: explique em uma ou duas frases o que faltou e peça uma foto melhor (de cima, mesa inteira, bolas visíveis).`;

/** Numeração padrão das caçapas na foto (mesa na vertical, foto tirada de cima). */
export const POCKETS = `Numeração padrão das caçapas (a foto é sempre tirada no mesmo padrão, com a mesa na vertical): as duas caçapas de baixo são 1 (esquerda) e 2 (direita); as do meio são 3 (esquerda) e 4 (direita); as de cima são 5 (esquerda) e 6 (direita). Sempre se refira às caçapas por esses números.`;

export const SITUATION_PROMPT = `Você é um treinador assistente de sinuca. O jogador mandou uma foto da mesa e explicou a situação dele (o jogo, quantas bolas ele e o adversário têm, o que está pensando em fazer). Responda em português brasileiro, linguagem de mesa de bar, direta e prática, no máximo cerca de 250 palavras. É WhatsApp: sem markdown, sem asteriscos duplos, sem títulos com #.

${POCKETS}

Regras de honestidade:
- Identifique só o que está visível na foto. Não invente bolas, posições nem regras.
- Você NÃO mede ângulos nem calcula trajetórias de verdade. As porcentagens são uma ESTIMATIVA visual de jogador experiente, baseada na distância, no ângulo aparente do corte e nos obstáculos. Escreva "chance estimada" e nunca garanta uma tacada.
- Quando houver "Conhecimento do treinador", siga exatamente as regras dele (por exemplo, quantas bolas saem em cada falta da regra suja) ao avaliar o risco.
- Se a foto não permitir avaliar (desfocada, cortada, bolas escondidas), diga o que faltou e peça outra foto em vez de inventar jogadas.

Formato exato:

🎱 Leitura da mesa:
<o que dá pra ver: branca, bolas relevantes, caçapas próximas>

1️⃣ <nome curto da jogada> — caçapa <n>
Chance estimada: <x>%
Risco: <o que pode dar errado e qual falta da regra suja pode acontecer, com quantas bolas saem>

2️⃣ <outra jogada diferente> — caçapa <n> (ou "defesa")
Chance estimada: <x>%
Risco: <...>

3️⃣ <outra jogada diferente, de preferência uma opção segura/defensiva>
Chance estimada: <x>%
Risco: <...>

✅ Minha escolha: <qual das três e por quê, em uma ou duas frases, levando em conta o placar e o que ele disse que estava pensando>`;

export function buildSituationPrompt(knowledge: string): string {
  if (!knowledge.trim()) return SITUATION_PROMPT;
  return `${SITUATION_PROMPT}

Conhecimento do treinador (material fornecido e autorizado):
"""
${knowledge.trim()}
"""`;
}

export function buildSystemPrompt(knowledge: string): string {
  if (!knowledge.trim()) return SYSTEM_PROMPT;
  return `${SYSTEM_PROMPT}

Conhecimento do treinador (material fornecido e autorizado — use como base para o estilo e a estratégia, sem inventar nada além dele):
"""
${knowledge.trim()}
"""`;
}

export const TEXT_PROMPT = `Você é um treinador assistente de sinuca conversando pelo WhatsApp, em português brasileiro, com linguagem natural, curta e prática (no máximo cerca de 150 palavras, sem markdown, sem asteriscos duplos, sem títulos com #).

Responda dúvidas sobre sinuca: regras, faltas, estratégia e jogadas. Quando houver "Conhecimento do treinador" abaixo, ele é a fonte principal: siga exatamente as regras dele e não as contradiga. Se a pergunta não estiver coberta pelo conhecimento e você não tiver certeza, diga que não tem certeza em vez de inventar. Não afirme ser o Bigode nem invente ensinamentos atribuídos a ele.

Se a mensagem for só um cumprimento, cumprimente de volta, diga que você responde dúvidas de sinuca (por exemplo, a regra do par ou ímpar) e que também analisa fotos da mesa.

Se a pergunta não tiver nada a ver com sinuca, diga com educação que você só fala de sinuca.`;

export function buildTextPrompt(knowledge: string): string {
  if (!knowledge.trim()) return TEXT_PROMPT;
  return `${TEXT_PROMPT}

Conhecimento do treinador (material fornecido e autorizado):
"""
${knowledge.trim()}
"""`;
}

export class CoachError extends Error {}

/** Esquema da mesa para desenhar: coordenadas normalizadas, x 0 (esquerda) a 1 (direita), y 0 (baixo) a 1 (cima). */
export interface Point { x: number; y: number }
export interface DiagramBall extends Point { label: string; group: 'par' | 'impar' | 'as' | 'outra' }
export interface DiagramPlay { name: string; level: 'verde' | 'amarelo' | 'vermelho'; chance: number; pocket: number | null; path: Point[] }
export interface Diagram { cue: Point | null; balls: DiagramBall[]; plays: DiagramPlay[] }
export interface Plan { text: string; diagram: Diagram | null }

const POINT_SCHEMA = { type: 'object', additionalProperties: false, required: ['x', 'y'], properties: { x: { type: 'number' }, y: { type: 'number' } } };
export const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['text', 'cue', 'balls', 'plays'],
  properties: {
    text: { type: 'string' },
    cue: { anyOf: [POINT_SCHEMA, { type: 'null' }] },
    balls: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['x', 'y', 'label', 'group'],
        properties: { x: { type: 'number' }, y: { type: 'number' }, label: { type: 'string' }, group: { type: 'string', enum: ['par', 'impar', 'as', 'outra'] } },
      },
    },
    plays: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'level', 'chance', 'pocket', 'path'],
        properties: {
          name: { type: 'string' },
          level: { type: 'string', enum: ['verde', 'amarelo', 'vermelho'] },
          chance: { type: 'integer' },
          pocket: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
          path: { type: 'array', items: POINT_SCHEMA },
        },
      },
    },
  },
} as const;

const DIAGRAM_INSTRUCTIONS = `

Além do texto, devolva um esquema aproximado da mesa para ser desenhado. Responda SOMENTE no JSON pedido:
- "text": a resposta completa no formato acima (é ela que o jogador lê).
- Coordenadas normalizadas da mesa em pé: x de 0 (lado esquerdo) a 1 (lado direito); y de 0 (borda de baixo) a 1 (borda de cima). Caçapas: 1=(0,0), 2=(1,0), 3=(0,0.5), 4=(1,0.5), 5=(0,1), 6=(1,1).
- "cue": posição estimada da bola branca (ou null se não der para ver).
- "balls": só as bolas relevantes que dá para ver, com "label" curto (número da bola, ou "Ás") e "group" (par, impar, as ou outra).
- "plays": as mesmas 3 jogadas do texto, na mesma ordem. "level": verde = tranquila, amarelo = atenção, vermelho = arriscada (combine com a chance: verde a mais alta). "chance": a chance estimada em % (inteiro 0 a 100). "pocket": número da caçapa (1 a 6) ou null para defesa. "path": pontos do traçado, começando na branca, passando pela bola alvo (e tabela, se houver) e terminando na caçapa ou onde a branca deve parar.
- São estimativas visuais: não finja precisão.
- Se a foto não permitir avaliar, devolva "plays" e "balls" vazios, "cue" null, e explique no "text".`;

const clamp01 = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : null);
function toPoint(v: unknown): Point | null {
  if (!v || typeof v !== 'object') return null;
  const x = clamp01((v as Point).x);
  const y = clamp01((v as Point).y);
  return x === null || y === null ? null : { x, y };
}

/** Valida e normaliza o esquema devolvido pelo modelo; descarta o que estiver fora do formato. */
export function sanitizeDiagram(raw: unknown): Diagram | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const balls = (Array.isArray(r.balls) ? r.balls : []).slice(0, 16).flatMap((b) => {
    const p = toPoint(b);
    const o = b as Record<string, unknown>;
    if (!p) return [];
    const group = ['par', 'impar', 'as', 'outra'].includes(o.group as string) ? (o.group as DiagramBall['group']) : 'outra';
    return [{ ...p, label: String(o.label ?? '').slice(0, 3), group }];
  });
  const plays = (Array.isArray(r.plays) ? r.plays : []).slice(0, 3).flatMap((pl) => {
    const o = pl as Record<string, unknown>;
    const path = (Array.isArray(o.path) ? o.path : []).slice(0, 8).map(toPoint).filter((p): p is Point => p !== null);
    if (path.length < 2) return [];
    const level = ['verde', 'amarelo', 'vermelho'].includes(o.level as string) ? (o.level as DiagramPlay['level']) : 'amarelo';
    const chance = Math.round(Math.min(100, Math.max(0, Number(o.chance) || 0)));
    const pocket = Number.isInteger(o.pocket) && (o.pocket as number) >= 1 && (o.pocket as number) <= 6 ? (o.pocket as number) : null;
    return [{ name: String(o.name ?? '').slice(0, 60), level, chance, pocket, path }];
  });
  if (!plays.length && !balls.length) return null;
  return { cue: toPoint(r.cue), balls, plays };
}

export interface Coach {
  /** Analisa a foto. Com `situation`, responde com 3 jogadas, chance estimada e risco. */
  analyze(image: Uint8Array, mime: SupportedMime, situation?: string): Promise<string>;
  /** Como analyze com situação, mas devolve também o esquema da mesa para desenhar. */
  plan?(image: Uint8Array, mime: SupportedMime, situation?: string): Promise<Plan>;
  /** Transcreve um áudio curto (explicação da situação). */
  transcribe?(audio: Uint8Array, filename: string): Promise<string>;
  /** Responde uma pergunta em texto usando o conhecimento do treinador. */
  ask?(question: string): Promise<string>;
}

export interface CoachOptions {
  apiKey: string;
  model: string;
  knowledge?: string;
  /** Para testes: injeta um cliente OpenAI falso. */
  client?: Pick<OpenAI, 'chat' | 'audio'>;
  /** Modelo de transcrição de áudio. */
  transcribeModel?: string;
}

const MAX_REPLY_CHARS = 2500;

export function createCoach(opts: CoachOptions): Coach {
  const client = opts.client ?? new OpenAI({ apiKey: opts.apiKey, timeout: 60_000, maxRetries: 1 });
  const systemPrompt = buildSystemPrompt(opts.knowledge ?? '');
  const textPrompt = buildTextPrompt(opts.knowledge ?? '');
  const situationPrompt = buildSituationPrompt(opts.knowledge ?? '');
  const transcribeModel = opts.transcribeModel ?? process.env.OPENAI_TRANSCRIBE_MODEL?.trim() ?? 'gpt-4o-mini-transcribe';
  const clip = (t: string) => (t.length > MAX_REPLY_CHARS ? `${t.slice(0, MAX_REPLY_CHARS - 1)}…` : t);

  return {
    async analyze(image, mime, situation) {
      const ctx = situation?.trim().slice(0, 2000);
      const completion = await client.chat.completions.create({
        model: opts.model,
        max_completion_tokens: 3000,
        messages: [
          { role: 'system', content: ctx ? situationPrompt : systemPrompt },
          {
            role: 'user',
            content: [
              { type: 'text', text: ctx ? `Situação explicada pelo jogador: ${ctx}` : 'Analise esta foto da mesa e sugira a jogada.' },
              { type: 'image_url', image_url: { url: toDataUrl(image, mime), detail: 'high' } },
            ],
          },
        ],
      });
      const text = completion.choices[0]?.message?.content?.trim();
      if (!text) throw new CoachError('O modelo não retornou texto.');
      return clip(text);
    },

    async plan(image, mime, situation) {
      const ctx = situation?.trim().slice(0, 2000);
      const completion = await client.chat.completions.create({
        model: opts.model,
        max_completion_tokens: 4000,
        response_format: { type: 'json_schema', json_schema: { name: 'plano_de_jogada', strict: true, schema: PLAN_SCHEMA as unknown as Record<string, unknown> } },
        messages: [
          { role: 'system', content: situationPrompt + DIAGRAM_INSTRUCTIONS },
          {
            role: 'user',
            content: [
              { type: 'text', text: ctx ? `Situação explicada pelo jogador: ${ctx}` : 'O jogador não explicou a situação. Analise a mesa e sugira 3 jogadas.' },
              { type: 'image_url', image_url: { url: toDataUrl(image, mime), detail: 'high' } },
            ],
          },
        ],
      });
      const raw = completion.choices[0]?.message?.content?.trim();
      if (!raw) throw new CoachError('O modelo não retornou texto.');
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return { text: clip(raw), diagram: null };
      }
      const text = typeof (parsed as { text?: unknown }).text === 'string' ? ((parsed as { text: string }).text).trim() : '';
      if (!text) throw new CoachError('O modelo não retornou texto.');
      return { text: clip(text), diagram: sanitizeDiagram(parsed) };
    },

    async transcribe(audio, filename) {
      const file = await toFile(Buffer.from(audio), filename);
      const result = await client.audio.transcriptions.create({ file, model: transcribeModel, language: 'pt' });
      const text = (result as { text?: string }).text?.trim();
      if (!text) throw new CoachError('Não consegui entender o áudio.');
      return text.slice(0, 2000);
    },

    async ask(question) {
      const q = question.trim().slice(0, 1000);
      const completion = await client.chat.completions.create({
        model: opts.model,
        max_completion_tokens: 1500,
        messages: [
          { role: 'system', content: textPrompt },
          { role: 'user', content: q },
        ],
      });
      const text = completion.choices[0]?.message?.content?.trim();
      if (!text) throw new CoachError('O modelo não retornou texto.');
      return clip(text);
    },
  };
}
