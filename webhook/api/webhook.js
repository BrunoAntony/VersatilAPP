// ============================================================
//  Webhook uazapi → Gemini — AUTO-RESPONDER 24/7 (Vercel/Node)
// ------------------------------------------------------------
//  Recebe os eventos da uazapi e responde AUTOMATICAMENTE com IA,
//  mesmo com o painel fechado:
//    • TEXTO   → gera resposta com o prompt do agente (Gemini) e envia
//    • ÁUDIO   → transcreve e responde com base na transcrição
//    • IMAGEM  → interpreta e responde
//    • DOC     → resume e responde
//
//  Só responde quando a conversa está em modo IA (não pausada por
//  humano). Se o cliente/atendente enviar #humano, o bot pausa.
//
//  Endpoint após deploy: https://SEU-APP.vercel.app/api/webhook
//  Configure essa URL no painel da uazapi como webhook da instância
//  (eventos de "mensagem recebida").
// ============================================================

// ----- Variáveis de ambiente (defina na Vercel) -----
//  GEMINI_API_KEY        chave do Google AI (Gemini)                [obrigatório]
//  UAZAPI_BASE_URL       ex: https://versatil.uazapi.com            [obrigatório]
//  UAZAPI_INSTANCE_TOKEN token da instância (enviar/baixar mídia)   [obrigatório]
//  AGENT_PROMPT          prompt de sistema do agente                [recomendado]
//  GEMINI_MODEL          opcional (default: gemini-1.5-flash)
//  AGENT_TEMPERATURE     opcional (default: 0.5)
//  STOP_KEYWORD          opcional (default: #humano) — pausa o bot
//  AUTO_REPLY            opcional 'false' desliga o envio automático

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-flash-latest';
const TEMPERATURE = process.env.AGENT_TEMPERATURE ? Number(process.env.AGENT_TEMPERATURE) : 0.5;
const STOP_KEYWORD = (process.env.STOP_KEYWORD || '#humano').toLowerCase();
const AUTO_REPLY = process.env.AUTO_REPLY !== 'false';
const DEFAULT_PROMPT = 'Você é um assistente de atendimento da empresa Versatil (gestão para salões e comércio). Responda em português do Brasil, de forma curta, cordial e útil, como uma mensagem de WhatsApp.';
const { readConfig } = require('./_configStore');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, token, admintoken');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method === 'GET') return res.status(200).json({ ok: true, service: 'uazapi→gemini auto-responder', autoReply: AUTO_REPLY });
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const msg = body.message || body.data || body;

    // ignora mensagens enviadas pela própria empresa (evita loop)
    if (msg.fromMe === true || msg.key && msg.key.fromMe === true) {
      return res.status(200).json({ ignored: true, reason: 'fromMe' });
    }

    const type = String(msg.type || msg.messageType || msg.mediaType || '').toLowerCase();
    const from = msg.sender || msg.from || msg.chatid || msg.jid || (msg.key && msg.key.remoteJid) || '';
    const mediaUrl = msg.fileURL || msg.mediaUrl || msg.url || (msg.file && msg.file.url) || '';
    const mimetype = msg.mimetype || msg.mediaType || '';
    const text = msg.text || msg.body || msg.caption || msg.content
      || (msg.message && (msg.message.conversation || (msg.message.extendedTextMessage && msg.message.extendedTextMessage.text))) || '';

    if (!from) return res.status(200).json({ ignored: true, reason: 'sem remetente' });
    // config enviada pelo app (tem prioridade sobre as variáveis de ambiente)
    const cfg = readConfig() || {};
    const geminiKey = cfg.geminiKey || process.env.GEMINI_API_KEY;
    const model = cfg.model || GEMINI_MODEL;
    const temperature = (cfg.temperature != null ? cfg.temperature : TEMPERATURE);
    if (cfg.enabled === false) return res.status(200).json({ ignored: true, reason: 'agente desativado no app' });
    if (!geminiKey) return res.status(500).json({ error: 'GEMINI_API_KEY ausente (defina na Vercel ou salve o agente no app)' });

    // palavra-chave para pausar o bot (atendimento humano)
    if (text && text.toLowerCase().includes(STOP_KEYWORD)) {
      return res.status(200).json({ ignored: true, reason: 'stop keyword — atendimento humano' });
    }

    const isAudio = /audio|ptt|voice/.test(type) || /audio\//.test(mimetype);
    const isImage = /image|photo|sticker/.test(type) || /image\//.test(mimetype);
    const isDoc   = /document|file/.test(type) || /(pdf|word|excel|sheet|text)/.test(mimetype);

    const system = (cfg.prompt || process.env.AGENT_PROMPT || DEFAULT_PROMPT)
      + '\nResponda SEMPRE em português do Brasil, curto e cordial, como mensagem de WhatsApp.';

    let userContent;      // partes para o Gemini
    let extractedNote = ''; // transcrição/descrição (retornada no JSON)

    if (isAudio || isImage || isDoc) {
      if (!mediaUrl) return res.status(200).json({ ignored: true, reason: 'mídia sem URL' });
      const bin = await downloadMedia(mediaUrl);
      const b64 = Buffer.from(bin.buffer).toString('base64');
      const mime = mimetype || bin.contentType || (isAudio ? 'audio/ogg' : isImage ? 'image/jpeg' : 'application/pdf');
      const guia = isAudio ? 'O cliente enviou um ÁUDIO. Entenda o que ele diz e responda diretamente.'
        : isImage ? 'O cliente enviou uma IMAGEM. Interprete e responda.'
        : 'O cliente enviou um DOCUMENTO. Entenda e responda.';
      userContent = [{ text: guia + (text ? (' Legenda: "' + text + '".') : '') }, { inline_data: { mime_type: mime, data: b64 } }];
    } else {
      if (!text) return res.status(200).json({ ignored: true, reason: 'sem texto' });
      userContent = [{ text: 'Mensagem do cliente: "' + text + '"\n\nEscreva a resposta da empresa.' }];
    }

    // gera a resposta com o prompt do agente
    const reply = await geminiGenerate(system, userContent, geminiKey, model, temperature);

    let replied = false;
    if (AUTO_REPLY && reply && process.env.UAZAPI_BASE_URL && process.env.UAZAPI_INSTANCE_TOKEN) {
      await uazapiSendText(from, reply);
      replied = true;
    }
    return res.status(200).json({ ok: true, type: type || 'text', reply, replied });
  } catch (e) {
    console.error('[webhook] erro:', e);
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
};

// -------- helpers --------
async function downloadMedia(url) {
  const headers = {};
  if (process.env.UAZAPI_INSTANCE_TOKEN) headers.token = process.env.UAZAPI_INSTANCE_TOKEN;
  let r = await fetch(url, { headers });
  if (!r.ok) r = await fetch(url);
  if (!r.ok) throw new Error('Falha ao baixar mídia: ' + r.status);
  return { buffer: await r.arrayBuffer(), contentType: r.headers.get('content-type') || '' };
}

async function geminiGenerate(system, parts, key, model, temperature) {
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + (model || GEMINI_MODEL) + ':generateContent?key=' + encodeURIComponent(key || process.env.GEMINI_API_KEY);
  const payload = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: parts }],
    generationConfig: { temperature: (temperature != null ? temperature : TEMPERATURE) },
  };
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const data = await r.json();
  if (!r.ok) throw new Error('Gemini: ' + (data.error && data.error.message || r.status));
  const out = data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts || [];
  return out.map(p => p.text || '').join('').trim();
}

async function uazapiSendText(to, text) {
  const base = String(process.env.UAZAPI_BASE_URL || '').replace(/\/+$/, '');
  const r = await fetch(base + '/send/text', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', token: process.env.UAZAPI_INSTANCE_TOKEN },
    body: JSON.stringify({ number: to, text: text }),
  });
  if (!r.ok) console.error('[uazapi send] falhou:', r.status, await r.text());
}
