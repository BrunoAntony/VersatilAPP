# Webhook uazapi → Gemini — Auto-responder 24/7

Backend serverless que faz o agente **responder automaticamente no WhatsApp mesmo com o painel fechado**. Recebe os eventos da uazapi, gera a resposta com o Gemini usando o **prompt do agente** e responde pelo WhatsApp.

Responde a **texto, áudio, imagem e documento**. Só responde em modo IA — se alguém enviar `#humano`, o bot pausa (atendimento humano).

## Como funciona

```
Cliente manda mensagem no WhatsApp
        │
        ▼
   uazapi ──(webhook POST)──► /api/webhook
                                 │ 1. lê a mensagem (texto/mídia)
                                 │ 2. Gemini gera a resposta (prompt do agente)
                                 │ 3. responde pelo WhatsApp (uazapi /send/text)
                                 ▼
                          resposta enviada
```

## Deploy na Vercel

1. Faça deploy da pasta `webhook/` (contém `api/webhook.js` e `vercel.json`).
2. Em **Settings → Environment Variables**, defina:

   | Variável | Obrigatória | Valor |
   |---|---|---|
   | `GEMINI_API_KEY` | ✅ | chave do Google AI (Gemini) |
   | `UAZAPI_BASE_URL` | ✅ | `https://versatil.uazapi.com` |
   | `UAZAPI_INSTANCE_TOKEN` | ✅ | token da instância (após conectar) |
   | `AGENT_PROMPT` | recomendado | o prompt de sistema do agente (copie da aba **Personalidade** do agente no painel) |
   | `GEMINI_MODEL` | opcional | `gemini-1.5-flash` (padrão) ou `gemini-1.5-pro` |
   | `AGENT_TEMPERATURE` | opcional | ex: `0.5` |
   | `STOP_KEYWORD` | opcional | padrão `#humano` — pausa o bot |
   | `AUTO_REPLY` | opcional | `false` para não enviar (só logar a resposta) |

3. **Deploy**. A URL será `https://SEU-APP.vercel.app/api/webhook`.

## Ligar na uazapi

No painel da uazapi, configure o **webhook da instância** apontando para a URL acima, habilitando **mensagens recebidas**.

Teste: abra `https://SEU-APP.vercel.app/api/webhook` no navegador — deve responder `{ "ok": true, "service": "uazapi→gemini auto-responder", "autoReply": true }`.

## Dicas

- **Copie o `AGENT_PROMPT` do painel:** abra o agente → aba **Personalidade** → copie o "Prompt de Sistema" e cole na variável. Assim o webhook responde exatamente como o agente configurado.
- **Pausar o bot numa conversa:** envie `#humano` — útil quando um humano vai assumir.
- **Loop:** o webhook ignora mensagens `fromMe`, então não responde a si mesmo.
- **Estrutura do payload:** varia entre versões da uazapi; o código normaliza os campos mais comuns. Se algo não for reconhecido, me mande um exemplo do JSON recebido para ajustar.
- **Custo:** cada resposta consome tokens do Gemini na sua conta Google AI.
