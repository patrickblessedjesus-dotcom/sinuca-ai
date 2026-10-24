import OpenAI from 'openai';
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

export interface Coach {
  analyze(image: Uint8Array, mime: SupportedMime): Promise<string>;
  /** Responde uma pergunta em texto usando o conhecimento do treinador. */
  ask?(question: string): Promise<string>;
}

export interface CoachOptions {
  apiKey: string;
  model: string;
  knowledge?: string;
  /** Para testes: injeta um cliente OpenAI falso. */
  client?: Pick<OpenAI, 'chat'>;
}

const MAX_REPLY_CHARS = 1500;

export function createCoach(opts: CoachOptions): Coach {
  const client = opts.client ?? new OpenAI({ apiKey: opts.apiKey, timeout: 60_000, maxRetries: 1 });
  const systemPrompt = buildSystemPrompt(opts.knowledge ?? '');
  const textPrompt = buildTextPrompt(opts.knowledge ?? '');
  const clip = (t: string) => (t.length > MAX_REPLY_CHARS ? `${t.slice(0, MAX_REPLY_CHARS - 1)}…` : t);

  return {
    async analyze(image, mime) {
      const completion = await client.chat.completions.create({
        model: opts.model,
        max_completion_tokens: 2000,
        messages: [
          { role: 'system', content: systemPrompt },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Analise esta foto da mesa e sugira a jogada.' },
              { type: 'image_url', image_url: { url: toDataUrl(image, mime), detail: 'high' } },
            ],
          },
        ],
      });
      const text = completion.choices[0]?.message?.content?.trim();
      if (!text) throw new CoachError('O modelo não retornou texto.');
      return clip(text);
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
