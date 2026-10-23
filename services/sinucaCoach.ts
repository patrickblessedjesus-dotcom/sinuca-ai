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

export class CoachError extends Error {}

export interface Coach {
  analyze(image: Uint8Array, mime: SupportedMime): Promise<string>;
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
      return text.length > MAX_REPLY_CHARS ? `${text.slice(0, MAX_REPLY_CHARS - 1)}…` : text;
    },
  };
}
