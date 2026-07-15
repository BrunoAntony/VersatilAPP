// ============================================================
//  /api/switch-empresa — troca a empresa ativa da sessão (só admin)
// ------------------------------------------------------------
//  Recebe o token da sessão atual + o id da empresa alvo. Confirma
//  que quem está pedindo é admin (app_users.is_admin) e que a
//  empresa existe, e devolve um JWT novo com uma claim "empresa_id"
//  apontando pra ela — a partir daí, todas as chamadas ao Supabase
//  com esse token enxergam só os dados daquela empresa (RLS lê essa
//  claim direto, sem precisar mudar nenhuma outra parte do app).
//
//  POST body: { empresaId }
//  Header: Authorization: Bearer <access_token da sessão atual>
// ============================================================
const jwt = require('./_jwt');

const SUPA_URL = 'https://kvxsqbfwakfqdxzilvix.supabase.co';
const SUPA_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt2eHNxYmZ3YWtmcWR4emlsdml4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODExNzQ0MjYsImV4cCI6MjA5Njc1MDQyNn0.PQads0GXVlNqr11K5co65XbWYoZJWu4V-4h4AR5DdpU';
const SESSION_HOURS = 12;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const jwtSecret = process.env.SUPABASE_JWT_SECRET;
  if (!serviceKey || !jwtSecret) {
    return res.status(500).json({ error: 'Não configurado no servidor (SUPABASE_SERVICE_ROLE_KEY / SUPABASE_JWT_SECRET ausentes).' });
  }

  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();
    const payload = jwt.verify(token, jwtSecret);
    if (!payload || !payload.sub) return res.status(401).json({ error: 'Sessão inválida ou expirada' });

    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const empresaId = String(body.empresaId || '').trim();
    if (!empresaId) return res.status(400).json({ error: 'Informe a empresa' });

    const ru = await fetch(SUPA_URL + '/rest/v1/app_users?id=eq.' + encodeURIComponent(payload.sub) + '&select=id,username,is_admin', {
      headers: { apikey: SUPA_ANON_KEY, Authorization: 'Bearer ' + serviceKey },
    });
    if (!ru.ok) throw new Error('Falha ao consultar usuário: ' + ru.status);
    const users = await ru.json();
    const user = users && users[0];
    if (!user || !user.is_admin) return res.status(403).json({ error: 'Sem permissão para trocar de empresa' });

    const re = await fetch(SUPA_URL + '/rest/v1/empresas?id=eq.' + encodeURIComponent(empresaId) + '&select=id,nome,segmento', {
      headers: { apikey: SUPA_ANON_KEY, Authorization: 'Bearer ' + serviceKey },
    });
    if (!re.ok) throw new Error('Falha ao consultar empresa: ' + re.status);
    const empresas = await re.json();
    const empresa = empresas && empresas[0];
    if (!empresa) return res.status(404).json({ error: 'Empresa não encontrada' });

    const now = Math.floor(Date.now() / 1000);
    const exp = now + SESSION_HOURS * 3600;
    const newPayload = { aud: 'authenticated', role: 'authenticated', sub: user.id, username: user.username, empresa_id: empresa.id, iat: now, exp: exp };
    const access_token = jwt.sign(newPayload, jwtSecret);

    // quem troca de empresa é sempre admin cross-empresa (só ele chega até aqui),
    // então tem acesso total à empresa escolhida, independente do "role" da própria linha
    return res.status(200).json({ access_token: access_token, expires_at: exp * 1000, username: user.username, empresa_id: empresa.id, empresaNome: empresa.nome, role: 'admin', isAdmin: true, segmento: empresa.segmento || 'geral' });
  } catch (e) {
    console.error('[switch-empresa] erro:', e);
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
};
