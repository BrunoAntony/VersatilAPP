// ============================================================
//  /api/config — recebe a configuração do agente enviada pelo APP
// ------------------------------------------------------------
//  O editor de agente do app faz POST aqui ao salvar. A config
//  (prompt, chave Gemini, modelo, criatividade, boas-vindas) passa
//  a ser usada pelo /api/webhook, sem precisar editar variáveis na
//  Vercel manualmente.
//
//  POST body: { prompt, geminiKey, model, temperature, welcome, enabled }
//  GET  → retorna a config atual (sem expor a chave)
// ============================================================
const { readConfig, writeConfig } = require('./_configStore');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (req.method === 'GET') {
    const c = readConfig();
    return res.status(200).json({ ok: true, configured: !!c, config: c ? { model: c.model, temperature: c.temperature, enabled: c.enabled, hasKey: !!c.geminiKey, promptLen: (c.prompt || '').length } : null });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const cfg = {
      prompt: body.prompt || '',
      geminiKey: body.geminiKey || '',
      model: body.model || 'gemini-flash-latest',
      temperature: (body.temperature != null ? Number(body.temperature) : 0.5),
      welcome: body.welcome || '',
      enabled: body.enabled !== false,
      updatedAt: Date.now(),
    };
    const okWrite = writeConfig(cfg);
    return res.status(200).json({ ok: true, stored: okWrite });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
};
