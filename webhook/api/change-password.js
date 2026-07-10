// ============================================================
//  /api/change-password — troca a senha do usuário logado
// ------------------------------------------------------------
//  Exige o token de sessão (Authorization: Bearer <access_token>,
//  o mesmo emitido por /api/login) e a senha atual, por segurança.
// ============================================================
const crypto = require('crypto');
const jwt = require('./_jwt');

const SUPA_URL = 'https://kvxsqbfwakfqdxzilvix.supabase.co';
const SUPA_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt2eHNxYmZ3YWtmcWR4emlsdml4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODExNzQ0MjYsImV4cCI6MjA5Njc1MDQyNn0.PQads0GXVlNqr11K5co65XbWYoZJWu4V-4h4AR5DdpU';

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
    const authHeader = req.headers.authorization || req.headers.Authorization || '';
    const token = String(authHeader).replace(/^Bearer\s+/i, '');
    const claims = jwt.verify(token, jwtSecret);
    if (!claims || !claims.username) return res.status(401).json({ error: 'Sessão inválida ou expirada — faça login novamente.' });

    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const currentPassword = String(body.currentPassword || '');
    const newPassword = String(body.newPassword || '');
    if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Informe a senha atual e a nova senha' });
    if (newPassword.length < 6) return res.status(400).json({ error: 'A nova senha precisa ter pelo menos 6 caracteres' });

    const r = await fetch(SUPA_URL + '/rest/v1/app_users?username=eq.' + encodeURIComponent(claims.username) + '&select=id,username,password_hash,password_salt', {
      headers: { apikey: SUPA_ANON_KEY, Authorization: 'Bearer ' + serviceKey },
    });
    if (!r.ok) throw new Error('Falha ao consultar usuário: ' + r.status);
    const rows = await r.json();
    const user = rows && rows[0];
    if (!user) return res.status(401).json({ error: 'Usuário não encontrado' });

    const candidate = crypto.scryptSync(currentPassword, user.password_salt, 64);
    const stored = Buffer.from(user.password_hash, 'hex');
    if (candidate.length !== stored.length || !crypto.timingSafeEqual(candidate, stored)) {
      return res.status(401).json({ error: 'Senha atual incorreta' });
    }

    const newSalt = crypto.randomBytes(16).toString('hex');
    const newHash = crypto.scryptSync(newPassword, newSalt, 64).toString('hex');
    const up = await fetch(SUPA_URL + '/rest/v1/app_users?id=eq.' + encodeURIComponent(user.id), {
      method: 'PATCH',
      headers: { apikey: SUPA_ANON_KEY, Authorization: 'Bearer ' + serviceKey, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ password_hash: newHash, password_salt: newSalt }),
    });
    if (!up.ok) throw new Error('Falha ao atualizar senha: ' + up.status);

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('[change-password] erro:', e);
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
};
