// ============================================================
//  Resolve a qual empresa/canal uma requisição do webhook pertence,
//  a partir do parâmetro ?canal=<webhook_key> (tabela "canais").
//  Compartilhado entre webhook.js e config.js pra manter a mesma
//  lógica nos dois lugares.
// ============================================================
const SUPA_URL = 'https://kvxsqbfwakfqdxzilvix.supabase.co';
const SUPA_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt2eHNxYmZ3YWtmcWR4emlsdml4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODExNzQ0MjYsImV4cCI6MjA5Njc1MDQyNn0.PQads0GXVlNqr11K5co65XbWYoZJWu4V-4h4AR5DdpU';

async function resolveCanal(canalKey, serviceKey) {
  if (!canalKey) return null;
  try {
    const r = await fetch(SUPA_URL + '/rest/v1/canais?webhook_key=eq.' + encodeURIComponent(canalKey) + '&select=empresa_id,uazapi_base_url,uazapi_instance_token', {
      headers: { apikey: SUPA_ANON_KEY, Authorization: 'Bearer ' + serviceKey },
    });
    if (!r.ok) return null;
    const rows = await r.json();
    return (rows && rows[0]) || null;
  } catch (e) { return null; }
}

// fallback pra quando não veio ?canal= na URL (compatibilidade com quem
// ainda não atualizou a URL registrada no painel da uazapi) — usa a
// primeira empresa cadastrada
let _defaultEmpresaId = null;
async function resolveDefaultEmpresa(serviceKey) {
  if (_defaultEmpresaId) return _defaultEmpresaId;
  try {
    const r = await fetch(SUPA_URL + '/rest/v1/empresas?select=id&order=created_at.asc&limit=1', {
      headers: { apikey: SUPA_ANON_KEY, Authorization: 'Bearer ' + serviceKey },
    });
    if (!r.ok) return null;
    const rows = await r.json();
    _defaultEmpresaId = (rows && rows[0] && rows[0].id) || null;
    return _defaultEmpresaId;
  } catch (e) { return null; }
}

// resolve tudo de uma vez: empresa_id + credenciais uazapi (do canal, ou das
// variáveis de ambiente se não veio ?canal= — mantém funcionando quem ainda
// não trocou a URL do webhook no painel da uazapi)
async function resolveContext(canalKey, serviceKey) {
  const canal = await resolveCanal(canalKey, serviceKey);
  if (canal) {
    return {
      empresaId: canal.empresa_id,
      uazBaseUrl: canal.uazapi_base_url || '',
      uazToken: canal.uazapi_instance_token || '',
    };
  }
  const empresaId = await resolveDefaultEmpresa(serviceKey);
  return {
    empresaId: empresaId,
    uazBaseUrl: process.env.UAZAPI_BASE_URL || '',
    uazToken: process.env.UAZAPI_INSTANCE_TOKEN || '',
  };
}

// segmento da empresa (ex: "imobiliaria") — usado pra adaptar o vocabulário do
// prompt do agente de IA (catálogo de "produtos" vs. de "imóveis")
async function resolveSegmento(empresaId, serviceKey) {
  if (!empresaId) return 'geral';
  try {
    const r = await fetch(SUPA_URL + '/rest/v1/empresas?id=eq.' + encodeURIComponent(empresaId) + '&select=segmento', {
      headers: { apikey: SUPA_ANON_KEY, Authorization: 'Bearer ' + serviceKey },
    });
    if (!r.ok) return 'geral';
    const rows = await r.json();
    return (rows && rows[0] && rows[0].segmento) || 'geral';
  } catch (e) { return 'geral'; }
}

module.exports = { resolveCanal, resolveDefaultEmpresa, resolveContext, resolveSegmento };
