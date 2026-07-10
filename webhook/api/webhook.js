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
//  Também pode enviar fotos de modelos do Catálogo de Produtos quando
//  o cliente pede exemplos/fotos e uma subcategoria bate com o pedido.
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
const SUPA_URL = 'https://kvxsqbfwakfqdxzilvix.supabase.co';
const SUPA_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt2eHNxYmZ3YWtmcWR4emlsdml4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODExNzQ0MjYsImV4cCI6MjA5Njc1MDQyNn0.PQads0GXVlNqr11K5co65XbWYoZJWu4V-4h4AR5DdpU';
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
    const cfg = (await readConfig()) || {};
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

    // busca o histórico recente da conversa — sem isso, cada mensagem chegava
    // "zerada" pro Gemini e ele cumprimentava/se apresentava de novo toda vez.
    const msgId = msg.id || msg.messageid || msg.messageId || (msg.key && msg.key.id) || '';
    const history = await fetchHistory(from, msgId);
    const historyNote = history ? ('\n\nHistórico recente da conversa (mais antigas primeiro):\n' + history) : '';

    // catálogo de produtos (categorias > subcategorias com fotos de modelos)
    const catalogo = await fetchCatalogo();
    const catalogoText = buildCatalogoPrompt(catalogo);

    const jsonFormatNote = '\n\n== FORMATO DE RESPOSTA (OBRIGATÓRIO) ==\n'
      + 'Responda SOMENTE com um JSON válido (sem texto fora do JSON), no formato exato:\n'
      + '{"reply": "sua resposta em português do Brasil, curta e cordial, como mensagem de WhatsApp", "sendImages": true ou false, "subcategoriaId": "id da subcategoria escolhida, ou null", "estilo": "tag do estilo pedido pelo cliente (ex: floral, clássico), ou null"}\n'
      + (catalogoText
        ? ('Marque "sendImages": true e escolha o "subcategoriaId" SOMENTE quando o cliente pedir explicitamente para ver fotos, exemplos ou modelos de produtos, E uma das subcategorias abaixo corresponder claramente ao que ele pediu na conversa. Se o cliente mencionar um estilo específico (ex: "quero algo floral", "tem modelo minimalista?") e essa tag aparecer na lista de tags da subcategoria, preencha "estilo" com essa tag (copie exatamente como está listado); caso contrário deixe "estilo": null e será enviada uma foto geral da subcategoria. Preste atenção ao contexto: nunca envie fotos de uma categoria/subcategoria diferente da que o cliente está perguntando. Se o cliente não pediu fotos/exemplos, ou nenhuma subcategoria bate com o pedido, use "sendImages": false e "subcategoriaId": null.\n\n== CATÁLOGO DE PRODUTOS DISPONÍVEL (categoria > subcategoria [id]: descrição (tags de estilo disponíveis, se houver)) ==\n' + catalogoText)
        : 'Não há catálogo de imagens cadastrado — sempre responda "sendImages": false e "subcategoriaId": null.');

    const system = (cfg.prompt || process.env.AGENT_PROMPT || DEFAULT_PROMPT)
      + '\nResponda SEMPRE em português do Brasil, curto e cordial, como mensagem de WhatsApp.'
      + (history ? '\n\nIMPORTANTE: há histórico de mensagens anteriores desta conversa abaixo. Se a Empresa já cumprimentou ou se apresentou antes, NÃO cumprimente nem se reapresente de novo — apenas continue a conversa naturalmente a partir de onde parou.' : '')
      + jsonFormatNote;

    let userContent;      // partes para o Gemini

    if (isAudio || isImage || isDoc) {
      if (!mediaUrl) return res.status(200).json({ ignored: true, reason: 'mídia sem URL' });
      const bin = await downloadMedia(mediaUrl);
      const b64 = Buffer.from(bin.buffer).toString('base64');
      const mime = mimetype || bin.contentType || (isAudio ? 'audio/ogg' : isImage ? 'image/jpeg' : 'application/pdf');
      const guia = isAudio ? 'O cliente enviou um ÁUDIO. Entenda o que ele diz e responda diretamente.'
        : isImage ? 'O cliente enviou uma IMAGEM. Interprete e responda.'
        : 'O cliente enviou um DOCUMENTO. Entenda e responda.';
      userContent = [{ text: guia + (text ? (' Legenda: "' + text + '".') : '') + historyNote }, { inline_data: { mime_type: mime, data: b64 } }];
    } else {
      if (!text) return res.status(200).json({ ignored: true, reason: 'sem texto' });
      userContent = [{ text: 'Mensagem do cliente: "' + text + '"' + historyNote + '\n\nEscreva a resposta da empresa.' }];
    }

    // gera a resposta com o prompt do agente (JSON estruturado: texto + decisão de enviar fotos)
    const raw = await geminiGenerate(system, userContent, geminiKey, model, temperature, true);
    const parsed = parseAgentJson(raw);
    const reply = (parsed && typeof parsed.reply === 'string' && parsed.reply.trim()) ? parsed.reply.trim() : raw.trim();
    const wantsImages = !!(parsed && parsed.sendImages && parsed.subcategoriaId);

    let replied = false;
    let imagesSent = 0;
    if (AUTO_REPLY && reply && process.env.UAZAPI_BASE_URL && process.env.UAZAPI_INSTANCE_TOKEN) {
      await uazapiSendText(from, reply);
      replied = true;
      if (wantsImages) {
        const sub = findSubcategoria(catalogo, parsed.subcategoriaId);
        let imgs = [];
        if (sub) {
          const pool = Array.isArray(sub.imagens) ? sub.imagens : [];
          let matched = pool;
          if (parsed.estilo) {
            const wanted = String(parsed.estilo).trim().toLowerCase();
            const filtered = pool.filter((im) => imgTag(im).toLowerCase().includes(wanted));
            if (filtered.length) matched = filtered;
          }
          if (matched.length) {
            imgs = matched.slice(0, 3).map(imgUrl).filter(Boolean);
          } else if (sub.driveFolderId && cfg.driveApiKey) {
            const files = await fetchDriveFolderImages(sub.driveFolderId, cfg.driveApiKey);
            for (const f of files.slice(0, 3)) {
              try { imgs.push(await downloadDriveFile(f.id)); } catch (e) { console.error('[drive] falha ao baixar arquivo:', f.id, e.message || e); }
            }
          }
        }
        for (const dataUrl of imgs) {
          await uazapiSendImage(from, dataUrl);
          imagesSent++;
          await new Promise((r) => setTimeout(r, 500)); // evita rajada/flood na uazapi
        }
      }
    }
    return res.status(200).json({ ok: true, type: type || 'text', reply, replied, imagesSent });
  } catch (e) {
    console.error('[webhook] erro:', e);
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
};

// -------- helpers --------
function parseAgentJson(raw) {
  const cleaned = (raw || '').replace(/```json|```/g, '').trim();
  try { return JSON.parse(cleaned); } catch (e) {}
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch (e2) {} }
  return null;
}

// imagens do catálogo podem vir como string (dataURL antigo) ou { url, tag } (formato atual)
function imgUrl(im) { return (im && typeof im === 'object') ? (im.url || '') : (im || ''); }
function imgTag(im) { return (im && typeof im === 'object' && im.tag) ? String(im.tag) : ''; }
function hasPhotos(sub) {
  return (Array.isArray(sub.imagens) && sub.imagens.length > 0) || !!sub.driveFolderId;
}

function buildCatalogoPrompt(catalogo) {
  if (!Array.isArray(catalogo) || !catalogo.length) return '';
  const lines = [];
  for (const cat of catalogo) {
    const subs = (cat.subcategorias || []).filter(hasPhotos);
    if (!subs.length) continue;
    lines.push('- ' + (cat.nome || 'Categoria'));
    for (const sub of subs) {
      const imgs = Array.isArray(sub.imagens) ? sub.imagens : [];
      const qtd = imgs.length ? (imgs.length + ' foto(s))') : 'fotos no Google Drive)';
      const tags = [...new Set(imgs.map(imgTag).filter(Boolean))];
      const tagsNote = tags.length ? (' [tags: ' + tags.join(', ') + ']') : '';
      lines.push('  - ' + (sub.nome || 'Subcategoria') + ' [id: ' + sub.id + ']: ' + (sub.descricao || 'sem descrição') + ' (' + qtd + tagsNote);
    }
  }
  return lines.join('\n');
}

// busca as imagens de uma pasta pública do Google Drive (compartilhada como "Qualquer pessoa com o link")
async function fetchDriveFolderImages(folderId, apiKey) {
  if (!folderId || !apiKey) return [];
  try {
    const q = encodeURIComponent("'" + folderId + "' in parents and mimeType contains 'image/' and trashed = false");
    const url = 'https://www.googleapis.com/drive/v3/files?q=' + q + '&fields=files(id,name)&pageSize=10&key=' + encodeURIComponent(apiKey);
    const r = await fetch(url);
    if (!r.ok) { console.error('[drive] falha ao listar pasta:', r.status, await r.text()); return []; }
    const data = await r.json();
    return Array.isArray(data.files) ? data.files : [];
  } catch (e) { console.error('[drive] erro ao listar pasta:', e.message || e); return []; }
}

async function downloadDriveFile(fileId) {
  const url = 'https://drive.google.com/uc?export=download&id=' + encodeURIComponent(fileId);
  const r = await fetch(url);
  if (!r.ok) throw new Error('Falha ao baixar do Drive: ' + r.status);
  const buf = await r.arrayBuffer();
  const contentType = r.headers.get('content-type') || 'image/jpeg';
  return 'data:' + contentType + ';base64,' + Buffer.from(buf).toString('base64');
}

function findSubcategoria(catalogo, subId) {
  const target = String(subId);
  for (const cat of (catalogo || [])) {
    const sub = (cat.subcategorias || []).find((s) => String(s.id) === target);
    if (sub) return sub;
  }
  return null;
}

async function fetchCatalogo() {
  try {
    const r = await fetch(SUPA_URL + '/rest/v1/app_config?id=eq.produtos_catalogo&select=data', {
      headers: { apikey: SUPA_KEY, Authorization: 'Bearer ' + SUPA_KEY },
    });
    if (!r.ok) return [];
    const rows = await r.json();
    const data = rows && rows[0] && rows[0].data;
    return (data && Array.isArray(data.catalogo)) ? data.catalogo : [];
  } catch (e) { return []; }
}

async function fetchHistory(chatid, excludeId) {
  const base = String(process.env.UAZAPI_BASE_URL || '').replace(/\/+$/, '');
  const token = process.env.UAZAPI_INSTANCE_TOKEN;
  if (!base || !token || !chatid) return '';
  try {
    const r = await fetch(base + '/message/find', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', token: token },
      body: JSON.stringify({ chatid: chatid, limit: 20, offset: 0 }),
    });
    if (!r.ok) return '';
    const data = await r.json();
    const arr = data.messages || data.data || (Array.isArray(data) ? data : []) || [];
    const ordered = arr.slice().sort((a, b) => Number(a.messageTimestamp || 0) - Number(b.messageTimestamp || 0));
    const lines = [];
    for (const m of ordered) {
      const id = m.id || m.messageid || m.messageId || (m.key && m.key.id) || '';
      if (excludeId && id === excludeId) continue;
      let txt = m.text || m.content || m.caption || (m.message && (m.message.conversation || (m.message.extendedTextMessage && m.message.extendedTextMessage.text))) || '';
      if (txt && typeof txt === 'object') txt = txt.text || txt.caption || txt.body || '';
      if (typeof txt !== 'string') txt = String(txt == null ? '' : txt);
      if (!txt) txt = '[mídia]';
      lines.push((m.fromMe ? 'Empresa' : 'Cliente') + ': ' + txt);
    }
    return lines.slice(-20).join('\n');
  } catch (e) { return ''; }
}

async function downloadMedia(url) {
  const headers = {};
  if (process.env.UAZAPI_INSTANCE_TOKEN) headers.token = process.env.UAZAPI_INSTANCE_TOKEN;
  let r = await fetch(url, { headers });
  if (!r.ok) r = await fetch(url);
  if (!r.ok) throw new Error('Falha ao baixar mídia: ' + r.status);
  return { buffer: await r.arrayBuffer(), contentType: r.headers.get('content-type') || '' };
}

async function geminiGenerate(system, parts, key, model, temperature, jsonMode) {
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + (model || GEMINI_MODEL) + ':generateContent?key=' + encodeURIComponent(key || process.env.GEMINI_API_KEY);
  const generationConfig = { temperature: (temperature != null ? temperature : TEMPERATURE) };
  if (jsonMode) {
    generationConfig.responseMimeType = 'application/json';
    generationConfig.responseSchema = {
      type: 'OBJECT',
      properties: {
        reply: { type: 'STRING' },
        sendImages: { type: 'BOOLEAN' },
        subcategoriaId: { type: 'STRING', nullable: true },
        estilo: { type: 'STRING', nullable: true },
      },
      required: ['reply', 'sendImages'],
    };
  }
  const payload = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: parts }],
    generationConfig: generationConfig,
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

async function uazapiSendImage(to, dataUrl) {
  const base = String(process.env.UAZAPI_BASE_URL || '').replace(/\/+$/, '');
  const r = await fetch(base + '/send/media', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', token: process.env.UAZAPI_INSTANCE_TOKEN },
    body: JSON.stringify({ number: to, type: 'image', file: dataUrl }),
  });
  if (!r.ok) console.error('[uazapi send image] falhou:', r.status, await r.text());
}
