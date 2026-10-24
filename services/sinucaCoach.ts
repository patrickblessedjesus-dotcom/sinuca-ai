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

export const SITUATION_PROMPT = `Você é um treinador assistente de sinuca. O jogador mandou uma foto da mesa e explicou a situação dele (o jogo, quantas bolas ele e o adversário têm, o que está pensando em fazer). Responda em português brasileiro, linguagem de mesa de bar, direta e prática, no máximo cerca de 320 palavras. É WhatsApp: sem markdown, sem asteriscos duplos, sem títulos com #.

${POCKETS}

Antes de tudo, responda à situação que o jogador DESCREVEU (no áudio ou no texto). Se ele disse que está travado, a resposta é sobre como sair do travado; se disse que vai matar a última bola, é sobre a disputa do ás; e assim por diante. Use o "Conhecimento do treinador" para identificar a situação. Não puxe assunto que ele não perguntou.

Regras de honestidade:
- Identifique só o que está visível na foto. Não invente bolas, posições nem regras.
- Você NÃO mede ângulos nem calcula trajetórias de verdade. As porcentagens são uma ESTIMATIVA visual de jogador experiente, baseada na distância, no ângulo aparente do corte e nos obstáculos. Escreva "chance estimada" e nunca garanta uma tacada.
- Quando houver "Conhecimento do treinador", siga exatamente as regras dele (por exemplo, quantas bolas saem em cada falta da regra suja) ao avaliar o risco.
- Se a foto não permitir avaliar (desfocada, cortada, bolas escondidas), diga o que faltou e peça outra foto em vez de inventar jogadas.

Como escolher as jogadas:
- A 1ª jogada é a MELHOR pra ganhar o jogo, não a mais fácil. Pense como jogador profissional: sequência, posição da branca pra próxima bola, e a estratégia do jogo (no par ou ímpar: armar as maiores e executar as menores primeiro).
- As 3 jogadas devem ser realmente diferentes entre si (bola, caçapa, efeito ou ideia).
- Em cada jogada diga o efeito na branca (puxada, efeito direito/esquerdo, descolar bola, sem efeito), a força e onde a branca deve parar.

Formato exato:

🎱 Leitura da mesa:
<o que dá pra ver: branca, bolas relevantes, caçapas próximas>

1️⃣ <nome curto da jogada> — caçapa <n> (ou "saída de X tabelas na bola <n>", ou "defesa")
Chance estimada: <x>%
Efeito: <tipo de efeito>, força <fraca/média/forte>
Branca para: <onde> → próxima: <bola que vai buscar>
Risco: <o que pode dar errado e qual falta pode acontecer>

2️⃣ <outra jogada diferente>
Chance estimada: <x>%
Efeito: <...>
Branca para: <...>
Risco: <...>

3️⃣ <outra jogada diferente>
Chance estimada: <x>%
Efeito: <...>
Branca para: <...>
Risco: <...>

✅ Minha escolha: <qual das três>
🎓 Por quê: <explique a estratégia como um professor, em 2 ou 3 frases simples>`;

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

/** Traçados desenhados em cima da própria foto: coordenadas normalizadas da IMAGEM, x 0 (esquerda) a 1 (direita), y 0 (topo) a 1 (base). */
export interface Point { x: number; y: number }
export interface DiagramPocket extends Point { n: number }
export interface DiagramPlay { name: string; level: 'verde' | 'amarelo' | 'vermelho'; chance: number; pocket: number | null; spin: string; path: Point[]; cueEnd: Point | null }
export interface Diagram { pockets: DiagramPocket[]; plays: DiagramPlay[] }
export interface Plan { text: string; diagram: Diagram | null }

const POINT_SCHEMA = { type: 'object', additionalProperties: false, required: ['x', 'y'], properties: { x: { type: 'number' }, y: { type: 'number' } } };
export const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['text', 'pockets', 'plays'],
  properties: {
    text: { type: 'string' },
    pockets: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['n', 'x', 'y'], properties: { n: { type: 'integer' }, x: { type: 'number' }, y: { type: 'number' } } },
    },
    plays: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'level', 'chance', 'pocket', 'spin', 'path', 'cueEnd'],
        properties: {
          name: { type: 'string' },
          level: { type: 'string', enum: ['verde', 'amarelo', 'vermelho'] },
          chance: { type: 'integer' },
          pocket: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
          spin: { type: 'string' },
          path: { type: 'array', items: POINT_SCHEMA },
          cueEnd: { anyOf: [POINT_SCHEMA, { type: 'null' }] },
        },
      },
    },
  },
} as const;

const DIAGRAM_INSTRUCTIONS = `

Além do texto, devolva os traçados para serem desenhados EM CIMA DA PRÓPRIA FOTO. Responda SOMENTE no JSON pedido.
As coordenadas são da IMAGEM (não da mesa): x de 0 (borda esquerda da foto) a 1 (borda direita); y de 0 (topo da foto) a 1 (base da foto). Marque os pontos exatamente onde as coisas aparecem na foto. Não mova nenhuma bola: o traçado tem que sair do centro da branca de verdade e passar pelo centro da bola alvo de verdade.
- "text": a resposta completa no formato acima (é ela que o jogador lê).
- "pockets": a posição de cada caçapa VISÍVEL na foto, com "n" de 1 a 6 conforme a numeração padrão.
- "plays": as mesmas 3 jogadas do texto, na mesma ordem.
  - "level": verde = tranquila, amarelo = atenção, vermelho = arriscada (pelo risco, não pela ordem).
  - "chance": a chance estimada em % (inteiro 0 a 100). "pocket": a caçapa (1 a 6) ou null para defesa/saída de tabela sem caçapa.
  - "spin": o efeito em poucas palavras (ex.: "puxada média", "efeito direito, força fraca").
  - "path": começa no centro da branca, inclui um ponto em cada tabela onde a branca bate antes da bola (se houver), passa pelo centro da bola alvo e termina na caçapa.
  - "cueEnd": onde a branca deve parar depois da tacada (ou null).
- São estimativas visuais: não finja precisão.
- Se a foto não permitir avaliar, devolva "plays" e "pockets" vazios e explique no "text".`;

const clamp01 = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : null);
function toPoint(v: unknown): Point | null {
  if (!v || typeof v !== 'object') return null;
  const x = clamp01((v as Point).x);
  const y = clamp01((v as Point).y);
  return x === null || y === null ? null : { x, y };
}

/** Valida e normaliza os traçados devolvidos pelo modelo; descarta o que estiver fora do formato. */
export function sanitizeDiagram(raw: unknown): Diagram | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const seen = new Set<number>();
  const pockets = (Array.isArray(r.pockets) ? r.pockets : []).flatMap((pk) => {
    const p = toPoint(pk);
    const n = (pk as { n?: unknown })?.n;
    if (!p || !Number.isInteger(n) || (n as number) < 1 || (n as number) > 6 || seen.has(n as number)) return [];
    seen.add(n as number);
    return [{ n: n as number, ...p }];
  });
  const plays = (Array.isArray(r.plays) ? r.plays : []).slice(0, 3).flatMap((pl) => {
    const o = pl as Record<string, unknown>;
    const path = (Array.isArray(o.path) ? o.path : []).slice(0, 8).map(toPoint).filter((p): p is Point => p !== null);
    if (path.length < 2) return [];
    const level = ['verde', 'amarelo', 'vermelho'].includes(o.level as string) ? (o.level as DiagramPlay['level']) : 'amarelo';
    const chance = Math.round(Math.min(100, Math.max(0, Number(o.chance) || 0)));
    const pocket = Number.isInteger(o.pocket) && (o.pocket as number) >= 1 && (o.pocket as number) <= 6 ? (o.pocket as number) : null;
    return [{ name: String(o.name ?? '').slice(0, 60), level, chance, pocket, spin: String(o.spin ?? '').slice(0, 60), path, cueEnd: toPoint(o.cueEnd) }];
  });
  if (!plays.length) return null;
  return { pockets, plays };
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
  /** Modelo reserva, usado se o principal falhar (ex.: modelo indisponível na conta). */
  fallbackModel?: string;
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
  const fallbackModel = opts.fallbackModel ?? process.env.OPENAI_FALLBACK_MODEL?.trim() ?? 'gpt-4o-mini';
  type CreateParams = Parameters<typeof client.chat.completions.create>[0];
  // Tenta o modelo principal; se a API recusar (400/403/404), tenta o reserva uma vez.
  const complete = async (params: Omit<CreateParams, 'model'>) => {
    try {
      return (await client.chat.completions.create({ ...params, model: opts.model } as CreateParams)) as OpenAI.Chat.Completions.ChatCompletion;
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (fallbackModel && fallbackModel !== opts.model && (status === 400 || status === 403 || status === 404)) {
        return (await client.chat.completions.create({ ...params, model: fallbackModel } as CreateParams)) as OpenAI.Chat.Completions.ChatCompletion;
      }
      throw err;
    }
  };
  const clip = (t: string) => (t.length > MAX_REPLY_CHARS ? `${t.slice(0, MAX_REPLY_CHARS - 1)}…` : t);

  return {
    async analyze(image, mime, situation) {
      const ctx = situation?.trim().slice(0, 2000);
      const completion = await complete({
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
      const completion = await complete({
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
      const completion = await complete({
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
