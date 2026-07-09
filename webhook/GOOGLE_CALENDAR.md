# Google Calendar Sync — sincronização automática dos agendamentos

Cria os eventos na sua **Google Agenda automaticamente** (sem clique) quando um
agendamento é registrado no APP VERSATIL.

## Como obter as credenciais Google (uma vez)

1. Acesse [Google Cloud Console](https://console.cloud.google.com) → crie/selecione um projeto.
2. **APIs e serviços → Biblioteca** → ative a **Google Calendar API**.
3. **APIs e serviços → Tela de consentimento OAuth** → configure (tipo Externo, adicione seu e-mail como usuário de teste).
4. **Credenciais → Criar credenciais → ID do cliente OAuth → Tipo: App para computador**. Anote o **Client ID** e **Client Secret**.
5. Gere um **refresh token** (uma vez):
   - Abra o [OAuth Playground](https://developers.google.com/oauthplayground).
   - Clique na engrenagem (canto sup. direito) → marque **Use your own OAuth credentials** → cole Client ID/Secret.
   - No passo 1, em "Input your own scopes", cole: `https://www.googleapis.com/auth/calendar.events` → **Authorize APIs** → faça login e autorize.
   - No passo 2, clique **Exchange authorization code for tokens** → copie o **Refresh token**.

## Deploy na Vercel

1. Suba a pasta `webhook/` (já contém `api/gcal.js`).
2. Em **Settings → Environment Variables**, defina:

   | Variável | Valor |
   |---|---|
   | `GOOGLE_CLIENT_ID` | seu Client ID |
   | `GOOGLE_CLIENT_SECRET` | seu Client Secret |
   | `GOOGLE_REFRESH_TOKEN` | o refresh token gerado |
   | `GOOGLE_CALENDAR_ID` | opcional — e-mail da agenda ou `primary` |
   | `SYNC_SECRET` | opcional — um segredo qualquer (cole igual no app) |

3. **Deploy**. Sua URL será `https://seu-backend.vercel.app/api/gcal`.

## Ligar no APP VERSATIL

No app → **Agendamentos → botão de configuração (⚙️)** → cole a URL do endpoint
(e o `SYNC_SECRET`, se usou). A partir daí, todo agendamento (manual ou criado
pela IA) é enviado ao backend e aparece sozinho na sua Google Agenda.

Teste: abra `https://seu-backend.vercel.app/api/gcal` no navegador → deve responder
`{ "ok": true, "service": "google-calendar-sync" }`.
