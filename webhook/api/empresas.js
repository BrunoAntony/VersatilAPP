// ============================================================
//  /api/empresas — lista as empresas que o usuário pode ver
// ------------------------------------------------------------
//  Usuário comum: só devolve a própria empresa (o seletor no app
//  fica escondido quando só tem uma). Usuário admin
//  (app_users.is_admin): devolve todas as empresas cadastradas,
//  pra alimentar o seletor "trocar de empresa" na sidebar.
//
//  Header: Authorization: Bearer <access_token da sessão>
// ============================================================
const jwt = require('./_jwt');

const SUPA_URL = 'https://kvxsqbfwakfqdxzilvix.supabase.co';
const SUPA_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt2eHNxYmZ3YWtmcWR4emlsdml4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODExNzQ0MjYsImV4cCI6MjA5Njc1MDQyNn0.PQads0GXVlNqr11K5co65XbWYoZJWu4V-4h4AR5DdpU';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method not allowed' });

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

    const ru = await fetch(SUPA_URL + '/rest/v1/app_users?id=eq.' + encodeURIComponent(payload.sub) + '&select=is_admin,empresa_id', {
      headers: { apikey: SUPA_ANON_KEY, Authorization: 'Bearer ' + serviceKey },
    });
    if (!ru.ok) throw new Error('Falha ao consultar usuário: ' + ru.status);
    const users = await ru.json();
    const user = users && users[0];
    if (!user) return res.status(401).json({ error: 'Usuário não encontrado' });

    if (!user.is_admin) {
      const re = await fetch(SUPA_URL + '/rest/v1/empresas?id=eq.' + encodeURIComponent(user.empresa_id) + '&select=id,nome,segmento', {
        headers: { apikey: SUPA_ANON_KEY, Authorization: 'Bearer ' + serviceKey },
      });
      const empresas = re.ok ? await re.json() : [];
      return res.status(200).json({ isAdmin: false, empresas: empresas || [] });
    }

    const re = await fetch(SUPA_URL + '/rest/v1/empresas?select=id,nome,segmento&order=nome.asc', {
      headers: { apikey: SUPA_ANON_KEY, Authorization: 'Bearer ' + serviceKey },
    });
    if (!re.ok) throw new Error('Falha ao listar empresas: ' + re.status);
    const empresas = await re.json();
    return res.status(200).json({ isAdmin: true, empresas: empresas || [] });
  } catch (e) {
    console.error('[empresas] erro:', e);
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
};
