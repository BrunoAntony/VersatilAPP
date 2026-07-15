// ============================================================
//  /api/login — autentica usuário/senha (tabela app_users) e
//  devolve um JWT compatível com o Supabase (assinado com o
//  mesmo JWT secret do projeto), para o app usar como sessão.
// ------------------------------------------------------------
//  Não usa Supabase Auth — evita a exigência de email com domínio
//  real. A senha nunca é guardada em texto puro (scrypt + salt).
//
//  Variáveis de ambiente necessárias (Vercel):
//   SUPABASE_SERVICE_ROLE_KEY  chave de serviço (ignora RLS)   [obrigatório]
//   SUPABASE_JWT_SECRET        "JWT Secret" do projeto Supabase [obrigatório]
//                               (Supabase → Settings → API → JWT Secret)
// ============================================================
const crypto = require('crypto');
const jwt = require('./_jwt');

const SUPA_URL = 'https://kvxsqbfwakfqdxzilvix.supabase.co';
const SUPA_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt2eHNxYmZ3YWtmcWR4emlsdml4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODExNzQ0MjYsImV4cCI6MjA5Njc1MDQyNn0.PQads0GXVlNqr11K5co65XbWYoZJWu4V-4h4AR5DdpU';
const SESSION_HOURS = 12;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const jwtSecret = process.env.SUPABASE_JWT_SECRET;
  if (!serviceKey || !jwtSecret) {
    return res.status(500).json({ error: 'Login não configurado no servidor (SUPABASE_SERVICE_ROLE_KEY / SUPABASE_JWT_SECRET ausentes).' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const username = String(body.username || '').trim().toLowerCase();
    const password = String(body.password || '');
    if (!username || !password) return res.status(400).json({ error: 'Informe usuário e senha' });

    const r = await fetch(SUPA_URL + '/rest/v1/app_users?username=eq.' + encodeURIComponent(username) + '&select=id,username,password_hash,password_salt,empresa_id,role,is_admin,must_change_password,empresas(segmento)', {
      headers: { apikey: SUPA_ANON_KEY, Authorization: 'Bearer ' + serviceKey },
    });
    if (!r.ok) throw new Error('Falha ao consultar usuário: ' + r.status);
    const rows = await r.json();
    const user = rows && rows[0];

    // sempre calcula um hash (mesmo sem usuário encontrado) pra não vazar, por tempo de resposta, se o usuário existe
    const salt = (user && user.password_salt) || crypto.randomBytes(16).toString('hex');
    const candidate = crypto.scryptSync(password, salt, 64);
    const stored = user ? Buffer.from(user.password_hash, 'hex') : crypto.randomBytes(64);
    const match = user && candidate.length === stored.length && crypto.timingSafeEqual(candidate, stored);
    if (!match) return res.status(401).json({ error: 'Usuário ou senha inválidos' });

    const now = Math.floor(Date.now() / 1000);
    const exp = now + SESSION_HOURS * 3600;
    const payload = { aud: 'authenticated', role: 'authenticated', sub: user.id, username: user.username, iat: now, exp: exp };
    const access_token = jwt.sign(payload, jwtSecret);

    return res.status(200).json({ access_token: access_token, expires_at: exp * 1000, username: user.username, empresa_id: user.empresa_id, role: user.role || 'admin', isAdmin: !!user.is_admin, mustChangePassword: !!user.must_change_password, segmento: (user.empresas && user.empresas.segmento) || 'geral' });
  } catch (e) {
    console.error('[login] erro:', e);
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
};
