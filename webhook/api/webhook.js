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
//  A IA também transfere sozinha para um atendente humano quando o
//  cliente pede, quando ela não sabe responder, ou quando um
//  agendamento é fechado — nesses casos avisa por WhatsApp o número
//  configurado na aba Ferramentas do agente (ou NOTIFY_NUMBER, se
//  nenhum número for configurado no app) com os dados do cliente,
//  o resumo da conversa e a data do agendamento (se houver).
//
//  Endpoint após deploy: https://SEU-APP.vercel.app/api/webhook?canal=<webhook_key>
//  Cada empresa/canal tem seu próprio "webhook_key" (tabela "canais" no
//  Supabase) — é isso que identifica qual empresa recebeu a mensagem e
//  quais credenciais uazapi/config usar. Configure essa URL completa (com
//  o ?canal=) no painel da uazapi como webhook da instância daquela empresa
//  (eventos de "mensagem recebida").
// ============================================================

// ----- Variáveis de ambiente (defina na Vercel) -----
//  GEMINI_API_KEY        chave do Google AI (Gemini) — único lugar onde ela mora;
//                        o app não guarda/envia mais chave nenhuma            [obrigatório]
//  UAZAPI_BASE_URL       usado só como fallback se a URL não tiver ?canal=  [opcional]
//  UAZAPI_INSTANCE_TOKEN usado só como fallback se a URL não tiver ?canal=  [opcional]
//  AGENT_PROMPT          prompt de sistema do agente                [recomendado]
//  GEMINI_MODEL          opcional (default: gemini-1.5-flash)
//  AGENT_TEMPERATURE     opcional (default: 0.5)
//  STOP_KEYWORD          opcional (default: #humano) — pausa o bot
//  AUTO_REPLY            opcional 'false' desliga o envio automático
//  NOTIFY_NUMBER          opcional — só usado se nenhum número for salvo na aba
//                         Ferramentas do agente (campo "Número para receber os avisos")

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-flash-latest';
const TEMPERATURE = process.env.AGENT_TEMPERATURE ? Number(process.env.AGENT_TEMPERATURE) : 0.5;
const STOP_KEYWORD = (process.env.STOP_KEYWORD || '#humano').toLowerCase();
const AUTO_REPLY = process.env.AUTO_REPLY !== 'false';
const DEFAULT_PROMPT = 'Você é um assistente de atendimento da empresa Versatil (gestão para salões e comércio). Responda em português do Brasil, de forma curta, cordial e útil, como uma mensagem de WhatsApp.';
const FUNIL_ESTAGIOS = ['novo', 'qualificando', 'interessado', 'fechamento', 'ganho', 'perdido'];
const NOTIFY_NUMBER_ENV = process.env.NOTIFY_NUMBER || '';
const SUPA_URL = 'https://kvxsqbfwakfqdxzilvix.supabase.co';
const SUPA_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt2eHNxYmZ3YWtmcWR4emlsdml4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODExNzQ0MjYsImV4cCI6MjA5Njc1MDQyNn0.PQads0GXVlNqr11K5co65XbWYoZJWu4V-4h4AR5DdpU';
// service_role ignora RLS — o app agora exige login (RLS) nas tabelas do
// Supabase, mas o webhook precisa continuar lendo o catálogo sem login.
const SUPA_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || SUPA_ANON_KEY;
const { readConfig } = require('./_configStore');
const { resolveContext, resolveSegmento } = require('./_empresa');

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

    // resolve qual empresa/canal recebeu essa mensagem — vem do parâmetro
    // ?canal=<webhook_key> registrado no painel da uazapi (ver tabela "canais");
    // sem esse parâmetro, cai nas variáveis de ambiente (compatibilidade)
    let canalKey = (req.query && req.query.canal) || '';
    if (!canalKey && req.url) {
      try { canalKey = new URL(req.url, 'http://x').searchParams.get('canal') || ''; } catch (e) {}
    }
    const ctx = await resolveContext(canalKey, SUPA_SERVICE_KEY);
    const empresaId = ctx.empresaId;
    const uazBase = String(ctx.uazBaseUrl || '').replace(/\/+$/, '');
    const uazToken = ctx.uazToken || '';
    // segmento da empresa (ex: "imobiliaria") — muda o vocabulário do prompt
    // (catálogo de "imóveis" em vez de "produtos", roteiro de vendas adequado)
    const segmento = await resolveSegmento(empresaId, SUPA_SERVICE_KEY);
    const isImobiliaria = segmento === 'imobiliaria';

    // config enviada pelo app (tem prioridade sobre as variáveis de ambiente)
    const cfg = (await readConfig(empresaId)) || {};
    // GEMINI_API_KEY é a única fonte da chave agora (o app não guarda/envia mais
    // chave nenhuma); cfg.geminiKey só existe por causa de configs antigas salvas
    // antes dessa mudança — nunca deve ter prioridade sobre a variável de ambiente
    const geminiKey = process.env.GEMINI_API_KEY || cfg.geminiKey;
    const model = cfg.model || GEMINI_MODEL;
    const temperature = (cfg.temperature != null ? cfg.temperature : TEMPERATURE);
    if (cfg.enabled === false) return res.status(200).json({ ignored: true, reason: 'agente desativado no app' });
    if (!geminiKey) return res.status(500).json({ error: 'GEMINI_API_KEY ausente (defina na Vercel ou salve o agente no app)' });

    // palavra-chave para pausar o bot (atendimento humano)
    if (text && text.toLowerCase().includes(STOP_KEYWORD)) {
      return res.status(200).json({ ignored: true, reason: 'stop keyword — atendimento humano' });
    }

    // conversa já transferida para um humano (pedido do cliente, IA sem resposta, ou
    // agendamento fechado) — não responde mais automaticamente até alguém devolver à IA no app
    if (await conversaEstaComHumano(phoneFromJid(from), empresaId)) {
      return res.status(200).json({ ignored: true, reason: 'conversa com atendente humano' });
    }

    const isAudio = /audio|ptt|voice/.test(type) || /audio\//.test(mimetype);
    const isImage = /image|photo|sticker/.test(type) || /image\//.test(mimetype);
    const isDoc   = /document|file/.test(type) || /(pdf|word|excel|sheet|text)/.test(mimetype);

    // busca o histórico recente da conversa — sem isso, cada mensagem chegava
    // "zerada" pro Gemini e ele cumprimentava/se apresentava de novo toda vez.
    const msgId = msg.id || msg.messageid || msg.messageId || (msg.key && msg.key.id) || '';
    uazapiMarkRead(uazBase, uazToken, from, msgId).catch(() => {});
    const history = await fetchHistory(uazBase, uazToken, from, msgId);
    const historyNote = history ? ('\n\nHistórico recente da conversa (mais antigas primeiro):\n' + history) : '';

    // catálogo de produtos (categorias > subcategorias com fotos de modelos)
    const catalogo = await fetchCatalogo(empresaId);
    const catalogoText = buildCatalogoPrompt(catalogo);

    const itemSing = isImobiliaria ? 'imóvel' : 'produto';
    const itemPlural = isImobiliaria ? 'imóveis' : 'produtos';
    const catalogoLabel = isImobiliaria ? 'CATÁLOGO DE IMÓVEIS DISPONÍVEIS (tipo > imóvel [id]: descrição (tags de estilo disponíveis, se houver))' : 'CATÁLOGO DE PRODUTOS DISPONÍVEL (categoria > subcategoria [id]: descrição (tags de estilo disponíveis, se houver))';
    const jsonFormatNote = '\n\n== FORMATO DE RESPOSTA (OBRIGATÓRIO) ==\n'
      + 'Responda SOMENTE com um JSON válido (sem texto fora do JSON), no formato exato:\n'
      + '{"reply": "sua resposta em português do Brasil, curta e profissional, como mensagem de WhatsApp", "sendImages": true ou false, "subcategoriaId": "id da subcategoria escolhida, ou null", "estilo": "tag do estilo pedido pelo cliente (ex: floral, clássico), ou null", "estagioFunil": "estágio atual do cliente no funil de vendas", "precisaHumano": true ou false, "motivoHumano": "motivo curto, ou null", "agendamentoFechado": true ou false, "agendamentoData": "data/horário combinado, ou null", "gerarImagem": true ou false, "promptImagem": "descrição em inglês da imagem a gerar, ou null"}\n'
      + (catalogoText
        ? ('Marque "sendImages": true e escolha o "subcategoriaId" SOMENTE quando o cliente pedir explicitamente para ver fotos, exemplos ou opções de ' + itemPlural + ', E uma das opções abaixo corresponder claramente ao que ele pediu na conversa. Se o cliente mencionar um estilo específico (ex: "quero algo floral", "tem modelo minimalista?") e essa tag aparecer na lista de tags, preencha "estilo" com essa tag (copie exatamente como está listado); caso contrário deixe "estilo": null e será enviada uma foto geral da opção escolhida. Preste atenção ao contexto: nunca envie fotos de uma categoria/subcategoria diferente da que o cliente está perguntando. Se o cliente não pediu fotos/exemplos, ou nenhuma opção bate com o pedido, use "sendImages": false e "subcategoriaId": null.\n\n== ' + catalogoLabel + ' ==\n' + catalogoText)
        : ('Não há catálogo de ' + itemPlural + ' cadastrado — sempre responda "sendImages": false e "subcategoriaId": null.'))
      + '\n\n== CLASSIFICAÇÃO NO FUNIL DE VENDAS (OBRIGATÓRIO) ==\n'
      + 'Preencha "estagioFunil" com o estágio atual do cliente, considerando toda a conversa (não só a última mensagem), usando exatamente um destes valores:\n'
      + '- "novo": primeiro contato, ainda não disse claramente o que precisa.\n'
      + '- "qualificando": já disse o que procura; você está entendendo a necessidade dele.\n'
      + '- "interessado": já viu produtos/fotos/exemplos e demonstrou gostar de algo específico.\n'
      + '- "fechamento": pediu orçamento/preço final, disse que quer fechar ou comprar, ou perguntou como pagar/proceder.\n'
      + '- "ganho": o pedido já foi confirmado/fechado.\n'
      + '- "perdido": desistiu, disse que não quer mais, ou claramente não há mais chance de venda.'
      + '\n\n== TRANSFERÊNCIA PARA ATENDENTE HUMANO (OBRIGATÓRIO) ==\n'
      + 'Marque "precisaHumano": true e preencha "motivoHumano" com um resumo curto SOMENTE quando: (a) o cliente pedir explicitamente para falar com um atendente/humano/pessoa, OU (b) o cliente perguntar algo que você não sabe responder com confiança (informação que não está disponível para você, caso muito específico ou fora do que você pode resolver). Nesse caso, sua "reply" deve avisar educadamente que um atendente vai continuar o atendimento em breve — NUNCA invente uma resposta que você não tem certeza. Se não se aplicar, use "precisaHumano": false e "motivoHumano": null.\n'
      + '== AGENDAMENTO FECHADO (OBRIGATÓRIO) ==\n'
      + 'Marque "agendamentoFechado": true e preencha "agendamentoData" com a data/horário combinado SOMENTE no momento em que o cliente CONFIRMAR um agendamento/data para o evento (ele concordou com uma data e horário específicos). Nas demais mensagens use "agendamentoFechado": false e "agendamentoData": null.'
      + (cfg.gerarImagemAtivo
        ? ('\n\n== GERAÇÃO DE IMAGEM COM IA (OBRIGATÓRIO) ==\nMarque "gerarImagem": true e preencha "promptImagem" SOMENTE quando o cliente pedir para ver algo personalizado que não existe no catálogo (ex: "mostra como fica uma caixa azul com o meu logo", "consegue gerar um exemplo com tema de dinossauro?"). "promptImagem" deve ser uma descrição detalhada EM INGLÊS do que gerar (o modelo de imagem entende melhor em inglês). Não use isso para pedidos que o catálogo já atende — nesse caso prefira "sendImages". Se não se aplicar, use "gerarImagem": false e "promptImagem": null.')
        : '\n\nA geração de imagem com IA está desativada para este agente — sempre responda "gerarImagem": false e "promptImagem": null.');

    const horaBR = new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo', hour: 'numeric', hour12: false });
    const saudacao = Number(horaBR) < 12 ? 'Bom dia' : Number(horaBR) < 18 ? 'Boa tarde' : 'Boa noite';
    const saudacaoConfigurada = (cfg.welcome || '').trim();

    const qualificacaoVendas = isImobiliaria
      ? 'Quando o cliente demonstrar intenção REAL de negociar (pediu mais informações de um imóvel específico, disse que quer visitar ou perguntou sobre condições), colete as informações na seguinte ORDEM, uma pergunta por vez: (1) primeiro, se busca COMPRAR ou ALUGAR; (2) depois, a FAIXA DE VALOR/orçamento disponível; (3) depois, o BAIRRO ou região de preferência e o tipo de imóvel (apartamento, casa, terreno). Só pergunte sobre agendar uma VISITA depois de já ter essas informações, e somente quando um imóvel específico do catálogo atender ao que ele procura.'
      : 'Quando o cliente demonstrar intenção REAL de fechar negócio (pediu orçamento, disse que quer comprar/fechar, perguntou como pagar ou como proceder), colete as informações na seguinte ORDEM, uma pergunta por vez: (1) primeiro, se ele já tem as MEDIDAS definidas da caixa (dimensões); (2) depois, a QUANTIDADE de caixas desejada; (3) depois, se ele já tem a IDENTIDADE VISUAL pronta (logo, cores, arte) ou se precisa de ajuda com isso. Só pergunte a DATA do evento depois de já ter essas três informações, e somente se for realmente necessário para prazo de produção/entrega.';
    const system = (cfg.prompt || process.env.AGENT_PROMPT || DEFAULT_PROMPT)
      + '\n\n== POSTURA E CONDUÇÃO DE VENDAS ==\n'
      + 'Mantenha sempre um tom profissional e corporativo — cordial, mas sem gírias, sem excesso de emojis e sem informalidade exagerada. '
      + ('Conduza a conversa ativamente para avançar o cliente no funil de vendas: entenda a necessidade dele, desperte interesse mostrando os ' + itemPlural + ' certos do catálogo e busque encaminhar para o fechamento — nunca deixe a conversa estagnada sem próximo passo. ')
      + (isImobiliaria
        ? 'NÃO tente marcar uma visita enquanto o cliente ainda está só explorando, pedindo informações ou fotos de imóveis. Antes disso, foque em entender o que ele procura e apresentar o catálogo.'
        : 'NÃO peça a data do evento nem outros dados do evento enquanto o cliente ainda está só explorando, pedindo informações ou fotos. Antes disso, foque em qualificar a necessidade e apresentar o catálogo.')
      + ('\n' + qualificacaoVendas)
      + '\nFaça no máximo UMA pergunta por mensagem. Nunca bombardeie o cliente com várias perguntas de uma vez — prefira avançar aos poucos, uma coisa de cada vez.'
      + '\nNUNCA comece a mensagem com interjeições genéricas como "Ótimo!", "Excelente!", "Perfeito!", "Legal!", "Que bom!" — isso soa robótico e repetitivo. Em vez disso, reaja de forma natural ao que o cliente disse (comente algo específico, mostre que entendeu) antes de seguir para a próxima parte da conversa, como uma pessoa de verdade escreveria, não como um roteiro de atendimento. Evite que a conversa pareça um interrogatório.'
      + '\nResponda SEMPRE em português do Brasil, curto e objetivo, como mensagem de WhatsApp.'
      + (history
        ? '\n\nIMPORTANTE: há histórico de mensagens anteriores desta conversa abaixo. Se a Empresa já cumprimentou ou se apresentou antes, NÃO cumprimente nem se reapresente de novo — apenas continue a conversa naturalmente a partir de onde parou.'
        : ('\n\nEsta é a primeira mensagem da conversa (sem histórico). Cumprimente de forma simples e direta, sem se alongar em apresentação: ' + (saudacaoConfigurada ? ('use algo parecido com "' + saudacaoConfigurada + '"') : ('use "' + saudacao + '! Como posso ajudar você hoje?"')) + ' — não faça mais de uma pergunta nessa primeira resposta.'))
      + jsonFormatNote;

    let userContent;      // partes para o Gemini

    if (isAudio || isImage || isDoc) {
      if (!mediaUrl) return res.status(200).json({ ignored: true, reason: 'mídia sem URL' });
      const bin = await downloadMedia(mediaUrl, uazToken);
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

    const telefone = phoneFromJid(from);
    const nomeCliente = msg.senderName || msg.pushName || msg.notifyName || msg.chatName || msg.name || telefone;

    // classificação no funil de vendas — best-effort, nunca derruba a resposta ao cliente
    const estagio = (parsed && FUNIL_ESTAGIOS.includes(parsed.estagioFunil)) ? parsed.estagioFunil : null;
    if (estagio) {
      upsertFunilCliente(telefone, nomeCliente, estagio, empresaId).catch((e) => console.error('[funil] falha ao salvar estágio:', e.message || e));
    }

    // transferência para atendente humano — cliente pediu, IA não soube responder, ou um
    // agendamento acabou de ser fechado. Marca a conversa como humana (o app para de deixar
    // a IA responder) e avisa o número de notificação com os dados do cliente e o resumo.
    const precisaHumano = !!(parsed && parsed.precisaHumano);
    const agendamentoFechado = !!(parsed && parsed.agendamentoFechado);
    const notifyNumber = cfg.notifyNumber || NOTIFY_NUMBER_ENV;
    if (AUTO_REPLY && (precisaHumano || agendamentoFechado)) {
      marcarConversaHumana(telefone, empresaId).catch((e) => console.error('[handoff] falha ao marcar conversa como humana:', e.message || e));
      if (agendamentoFechado) {
        const resumoConversa = (history ? history.split('\n').slice(-6).join(' ') : text || '').slice(0, 300);
        createAgendamento(telefone, nomeCliente, (parsed && parsed.agendamentoData) || '', resumoConversa, empresaId)
          .catch((e) => console.error('[agendamento] falha ao salvar:', e.message || e));
      }
      if (notifyNumber) {
        const motivo = agendamentoFechado ? 'Agendamento fechado' : ((parsed && parsed.motivoHumano) || 'IA não soube responder');
        const agendamentoData = (parsed && parsed.agendamentoData) || '';
        const resumoMsg = '🔔 *Atendimento precisa de atenção humana*\n'
          + 'Cliente: ' + nomeCliente + '\n'
          + 'Telefone: ' + telefone + '\n'
          + 'Motivo: ' + motivo
          + (agendamentoData ? ('\nData do agendamento: ' + agendamentoData) : '')
          + (history ? ('\n\nResumo da conversa:\n' + history + '\nCliente: ' + text) : ('\n\nÚltima mensagem do cliente: ' + text));
        notifyHuman(uazBase, uazToken, notifyNumber, resumoMsg).catch((e) => console.error('[handoff] falha ao notificar:', e.message || e));
      } else {
        console.warn('[handoff] nenhum número de notificação configurado (aba Ferramentas do agente) — aviso não enviado');
      }
    }

    let replied = false;
    let imagesSent = 0;
    if (AUTO_REPLY && reply && uazBase && uazToken) {
      // espera um pouco antes de responder, pra não parecer instantâneo/robótico —
      // mostra "digitando…" durante essa espera, pra parecer alguém realmente escrevendo
      const delaySec = Math.min(10, Math.max(2, Number(cfg.respostaDelay) || 3));
      uazapiSetPresence(uazBase, uazToken, from, 'composing').catch(() => {});
      await new Promise((r) => setTimeout(r, delaySec * 1000));
      await uazapiSendText(uazBase, uazToken, from, reply);
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
          await uazapiSendImage(uazBase, uazToken, from, dataUrl);
          imagesSent++;
          await new Promise((r) => setTimeout(r, 500)); // evita rajada/flood na uazapi
        }
      }
      // gera uma imagem sob medida com IA (fora do catálogo) — só se a ferramenta
      // estiver ligada nesse agente; nunca derruba a resposta se falhar
      if (cfg.gerarImagemAtivo && parsed && parsed.gerarImagem && parsed.promptImagem) {
        try {
          const dataUrl = await geminiGenerateImage(parsed.promptImagem, geminiKey);
          await uazapiSendImage(uazBase, uazToken, from, dataUrl);
          imagesSent++;
        } catch (e) { console.error('[imagem IA] falha ao gerar/enviar:', e.message || e); }
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

function phoneFromJid(jid) {
  const digits = String(jid || '').replace(/@.*/, '').replace(/[^0-9]/g, '');
  return digits ? ('+' + digits) : '';
}

async function conversaEstaComHumano(telefone, empresaId) {
  if (!telefone || !empresaId) return false;
  try {
    const r = await fetch(SUPA_URL + '/rest/v1/conversas?telefone=eq.' + encodeURIComponent(telefone) + '&empresa_id=eq.' + encodeURIComponent(empresaId) + '&select=dados', {
      headers: { apikey: SUPA_ANON_KEY, Authorization: 'Bearer ' + SUPA_SERVICE_KEY },
    });
    if (!r.ok) return false;
    const rows = await r.json();
    const dados = rows && rows[0] && rows[0].dados;
    return !!(dados && dados.humano === true && !dados.resolvida);
  } catch (e) { return false; }
}

// service_role não carrega um empresa_id no token (é assim que o Supabase
// identifica multi-tenant), então todo INSERT feito por aqui precisa mandar
// empresa_id explicitamente — sem isso, o gatilho do banco não consegue
// preenchê-lo sozinho e a gravação falha. empresaId vem de resolveContext(),
// já resolvido a partir do canal que recebeu a mensagem.
async function upsertFunilCliente(telefone, nome, estagio, empresaId) {
  if (!telefone || !empresaId) return;
  // a chave passou a ser (empresa_id, telefone) — mesmo número pode existir em
  // empresas diferentes, então precisa dizer explicitamente qual é o conflito
  await fetch(SUPA_URL + '/rest/v1/funil_clientes?on_conflict=empresa_id,telefone', {
    method: 'POST',
    headers: { apikey: SUPA_ANON_KEY, Authorization: 'Bearer ' + SUPA_SERVICE_KEY, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ telefone, nome: nome || telefone, estagio, empresa_id: empresaId, updated_at: new Date().toISOString() }),
  });
}

// cria o registro do agendamento assim que a IA detecta que o cliente
// fechou uma data — antes disso só existia o aviso por WhatsApp, o
// agendamento nunca ficava salvo em lugar nenhum se ninguém estivesse
// com o app aberto naquela conversa
async function createAgendamento(telefone, nome, quando, resumo, empresaId) {
  if (!telefone || !empresaId) return;
  await fetch(SUPA_URL + '/rest/v1/agendamentos', {
    method: 'POST',
    headers: { apikey: SUPA_ANON_KEY, Authorization: 'Bearer ' + SUPA_SERVICE_KEY, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({ telefone, nome: nome || telefone, quando: quando || '', resumo: resumo || '', origem: 'IA', status: 'ativo', empresa_id: empresaId }),
  });
}

// marca a conversa como "com humano" na tabela conversas (mesma linha que o app lê/escreve) —
// só atualiza uma linha que já existe (lê e reescreve o mesmo "dados" com o campo alterado),
// nunca cria uma linha nova, para não gravar um snapshot de conversa incompleto/sem mensagens
async function marcarConversaHumana(telefone, empresaId) {
  if (!telefone || !empresaId) return;
  const r = await fetch(SUPA_URL + '/rest/v1/conversas?telefone=eq.' + encodeURIComponent(telefone) + '&empresa_id=eq.' + encodeURIComponent(empresaId) + '&select=dados', {
    headers: { apikey: SUPA_ANON_KEY, Authorization: 'Bearer ' + SUPA_SERVICE_KEY },
  });
  if (!r.ok) return;
  const rows = await r.json();
  const dados = rows && rows[0] && rows[0].dados;
  if (!dados) return; // conversa ainda não sincronizada pelo app — nada a atualizar ainda
  const novoDados = Object.assign({}, dados, { humano: true, iaAtiva: false, resolvida: false, _localCtrl: true });
  await fetch(SUPA_URL + '/rest/v1/conversas?telefone=eq.' + encodeURIComponent(telefone) + '&empresa_id=eq.' + encodeURIComponent(empresaId), {
    method: 'PATCH',
    headers: { apikey: SUPA_ANON_KEY, Authorization: 'Bearer ' + SUPA_SERVICE_KEY, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({ dados: novoDados, updated_at: new Date().toISOString() }),
  });
}

async function notifyHuman(base, token, number, text) {
  if (!number || !base || !token) return;
  await uazapiSendText(base, token, number, text);
}

async function fetchCatalogo(empresaId) {
  if (!empresaId) return [];
  try {
    const r = await fetch(SUPA_URL + '/rest/v1/app_config?id=eq.produtos_catalogo&empresa_id=eq.' + encodeURIComponent(empresaId) + '&select=data', {
      headers: { apikey: SUPA_ANON_KEY, Authorization: 'Bearer ' + SUPA_SERVICE_KEY },
    });
    if (!r.ok) return [];
    const rows = await r.json();
    const data = rows && rows[0] && rows[0].data;
    return (data && Array.isArray(data.catalogo)) ? data.catalogo : [];
  } catch (e) { return []; }
}

async function fetchHistory(base, token, chatid, excludeId) {
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

async function downloadMedia(url, token) {
  const headers = {};
  if (token) headers.token = token;
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
        estagioFunil: { type: 'STRING', enum: FUNIL_ESTAGIOS },
        precisaHumano: { type: 'BOOLEAN' },
        motivoHumano: { type: 'STRING', nullable: true },
        agendamentoFechado: { type: 'BOOLEAN' },
        agendamentoData: { type: 'STRING', nullable: true },
        gerarImagem: { type: 'BOOLEAN' },
        promptImagem: { type: 'STRING', nullable: true },
      },
      required: ['reply', 'sendImages', 'estagioFunil', 'precisaHumano', 'agendamentoFechado'],
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

// gera uma imagem sob medida (ferramenta "Gerar imagens com IA" do agente) quando o
// cliente pede algo fora do catálogo — usa a mesma GEMINI_API_KEY, modelo próprio de imagem
async function geminiGenerateImage(prompt, key) {
  const model = 'gemini-2.5-flash-image';
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + encodeURIComponent(key);
  const payload = { contents: [{ role: 'user', parts: [{ text: prompt }] }] };
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const data = await r.json();
  if (!r.ok) throw new Error('Gemini imagem: ' + (data.error && data.error.message || r.status));
  const parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
  const imgPart = parts.find((p) => p.inlineData || p.inline_data);
  const inline = imgPart && (imgPart.inlineData || imgPart.inline_data);
  if (!inline || !inline.data) throw new Error('Gemini não retornou imagem');
  const mime = inline.mimeType || inline.mime_type || 'image/png';
  return 'data:' + mime + ';base64,' + inline.data;
}

// marca a(s) mensagem(ns) recebida(s) como lida (check azul) — best-effort,
// nunca derruba a resposta se a uazapi não reconhecer o endpoint/formato
async function uazapiMarkRead(base, token, chatid, messageId) {
  if (!messageId || !base || !token) return;
  try {
    const r = await fetch(base + '/message/markread', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', token: token },
      body: JSON.stringify({ id: [messageId], number: chatid }),
    });
    if (!r.ok) console.warn('[uazapi markread] não confirmado:', r.status, await r.text());
  } catch (e) { console.warn('[uazapi markread] falhou:', e.message || e); }
}

// mostra "digitando…" pro cliente enquanto a IA "pensa" a resposta — best-effort
async function uazapiSetPresence(base, token, to, presence) {
  if (!to || !base || !token) return;
  try {
    const r = await fetch(base + '/chat/presence', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', token: token },
      body: JSON.stringify({ number: to, presence: presence }),
    });
    if (!r.ok) console.warn('[uazapi presence] não confirmado:', r.status, await r.text());
  } catch (e) { console.warn('[uazapi presence] falhou:', e.message || e); }
}

async function uazapiSendText(base, token, to, text) {
  const r = await fetch(base + '/send/text', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', token: token },
    body: JSON.stringify({ number: to, text: text }),
  });
  if (!r.ok) console.error('[uazapi send] falhou:', r.status, await r.text());
}

async function uazapiSendImage(base, token, to, dataUrl) {
  const r = await fetch(base + '/send/media', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', token: token },
    body: JSON.stringify({ number: to, type: 'image', file: dataUrl }),
  });
  if (!r.ok) console.error('[uazapi send image] falhou:', r.status, await r.text());
}
