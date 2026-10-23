# Sinuca AI — MVP

O usuário manda uma foto da mesa de sinuca no WhatsApp e recebe uma sugestão de jogada gerada por IA (OpenAI), em português.

Fluxo: WhatsApp → webhook (`POST /webhook`) → download da foto pela Graph API da Meta → modelo multimodal da OpenAI → resposta em texto pelo WhatsApp.

> Versão de demonstração para uma pessoa. Sem banco de dados, pagamentos ou painel.

## 1. Requisitos

- **Node.js 22.12 ou mais novo** (LTS). Confira com `node -v`. Instale em https://nodejs.org.
- Conta na **Meta for Developers** e na **OpenAI** (com crédito pré-pago).
- Um túnel HTTPS para expor o servidor local (ngrok ou cloudflared).

## 2. Instalação e comandos

```bash
npm install            # instala as dependências
cp .env.example .env   # cria o arquivo de configuração (preencha a seguir)

npm run dev            # desenvolvimento (recarrega ao salvar)
npm test               # testes automatizados (não usam credenciais reais)
npm run build          # compila TypeScript para dist/
npm start              # roda a versão compilada
```

## 3. Variáveis do `.env`

| Variável | Obrigatória | O que é |
|---|---|---|
| `PORT` | não | Porta local. Padrão `3000`. |
| `VERIFY_TOKEN` | sim | Senha que **você inventa** e cola igual no painel da Meta. |
| `WHATSAPP_TOKEN` | sim | Token de acesso da Cloud API (WhatsApp → API Setup). |
| `PHONE_NUMBER_ID` | sim | "Phone number ID" (é um ID, não o telefone). |
| `GRAPH_API_VERSION` | não | Ex.: `v23.0`. Confira a versão atual no painel da Meta. |
| `APP_SECRET` | sim* | App settings → Basic → App secret. Valida a assinatura do webhook. |
| `SKIP_SIGNATURE_VERIFICATION` | não | `true` desliga a validação (*só para teste local; nunca em produção*). |
| `ALLOWED_NUMBERS` | não | Números que podem usar o bot, só dígitos com DDI, separados por vírgula. Vazio = todos. |
| `OPENAI_API_KEY` | sim | Chave da API OpenAI. |
| `OPENAI_MODEL` | não | Modelo que aceita imagem e está habilitado na sua conta. Padrão `gpt-4o-mini`. |

\* Obrigatória, a não ser que `SKIP_SIGNATURE_VERIFICATION=true`.

Se faltar algo, o servidor não sobe e diz qual variável falta (sem mostrar valores).

## 4. Configurar a Meta (WhatsApp Cloud API)

1. Em https://developers.facebook.com → **My Apps → Create App** → tipo **Business**.
2. No app, adicione o produto **WhatsApp** → **API Setup**.
3. Copie o **token temporário** (`WHATSAPP_TOKEN`, dura 24h) e o **Phone number ID** (`PHONE_NUMBER_ID`).
4. Em **To**, adicione e verifique o número de quem vai testar (o número de teste só envia para até 5 números cadastrados).
5. Em **App settings → Basic**, copie o **App secret** (`APP_SECRET`).
6. Suba o servidor e o túnel (seção 5). Em **WhatsApp → Configuration → Webhook**:
   - **Callback URL**: `https://SEU-TUNEL/webhook`
   - **Verify token**: o mesmo `VERIFY_TOKEN` do `.env`
   - Clique **Verify and save**, depois em **Webhook fields** assine **messages**.

Para algo além de um dia de testes, gere um token permanente com um **System User** no Business Manager.

## 5. Expor o servidor com HTTPS (túnel)

Com `npm run dev` rodando, em outro terminal:

```bash
# opção A — cloudflared (sem conta)
npx cloudflared tunnel --url http://localhost:3000

# opção B — ngrok (precisa de conta gratuita)
ngrok http 3000
```

Use a URL `https://...` que aparecer + `/webhook` no painel da Meta. A URL do cloudflared rápido muda a cada execução: se reiniciar o túnel, atualize na Meta. O computador precisa ficar ligado e sem suspender enquanto o bot estiver em uso.

## 6. Conhecimento do treinador

Cole o material autorizado em `knowledge/conhecimento.md` (fora do comentário) e reinicie o servidor. O log de inicialização mostra `knowledgeLoaded: true` quando ele foi carregado.

## 7. Testar

1. Do celular cadastrado, mande "oi" para o número de teste → deve chegar o pedido de foto.
2. Mande uma foto da mesa (de cima, mesa inteira, bolas visíveis) → chega "Recebi a foto!" e, em alguns segundos, a análise.

## 8. Problemas comuns

| Sintoma | Causa provável |
|---|---|
| Meta não verifica o webhook | `VERIFY_TOKEN` diferente, túnel fora do ar ou URL sem `/webhook`. |
| Log `Assinatura do webhook inválida` | `APP_SECRET` errado (é o do app, não o token). |
| Erro **131030** ao responder | Número fora da lista do número de teste. **Brasil:** o webhook pode mandar o número sem o 9º dígito; cadastre também essa forma em **API Setup → To**. |
| Erro **190** / HTTP 401 da Meta | Token expirado (o temporário dura 24h). Gere outro. |
| Nada chega no servidor | Campo **messages** não assinado no webhook, ou remetente fora de `ALLOWED_NUMBERS` (veja o log). |
| "Não consegui analisar essa foto" | Veja o log: erro da OpenAI (chave, crédito, `OPENAI_MODEL` sem suporte a imagem) ou download da mídia. |

## 9. Limitações conhecidas

- **Deduplicação em memória**: evita responder duas vezes à mesma mensagem, mas é perdida ao reiniciar e não funciona com mais de uma instância. Em produção, use Redis ou banco.
- **Mídia**: a foto fica só na memória durante a análise e é enviada apenas à OpenAI. Nada é salvo em disco.
- **Análise visual**: o modelo não mede ângulos nem calcula trajetórias; ele faz uma leitura visual e pode errar posições, principalmente com a mesa cheia ou foto inclinada.
- O número de teste da Meta só atende números cadastrados; para o público é preciso um número próprio verificado.

## 10. Segurança

- Assinatura HMAC-SHA256 (`X-Hub-Signature-256`) validada sobre o corpo bruto.
- Corpo HTTP limitado a 1 MB; imagens limitadas a 5 MB e validadas pelos bytes (JPEG/PNG/WebP).
- Mídia baixada apenas de URLs devolvidas pela Graph API e em domínios da Meta, via HTTPS.
- Timeouts em todas as chamadas externas.
- Logs sem tokens, imagens ou telefones completos (só os 4 últimos dígitos).

## Estrutura

```
src/
  server.ts            inicialização e encerramento
  app.ts               Express, limite de corpo, erros
  config.ts            leitura e validação do .env
  handler.ts           regras de resposta (texto, foto, erro)
  routes/webhook.ts    GET/POST /webhook, assinatura, deduplicação
  services/whatsapp.ts envio de texto, metadados e download de mídia
  services/media.ts    validação de imagem
  services/sinucaCoach.ts chamada à OpenAI
  services/dedup.ts    deduplicação em memória
  utils/logger.ts      logs sem dados sensíveis
knowledge/conhecimento.md
tests/
```
