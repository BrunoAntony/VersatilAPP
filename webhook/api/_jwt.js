// Assina/verifica JWTs HS256 compatíveis com o Supabase (mesmo JWT secret do
// projeto), usados como sessão de login do app — sem depender do Supabase Auth.
const crypto = require('crypto');

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function base64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64');
}

function sign(payload, secret) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const h = base64url(Buffer.from(JSON.stringify(header)));
  const p = base64url(Buffer.from(JSON.stringify(payload)));
  const data = h + '.' + p;
  const sig = crypto.createHmac('sha256', secret).update(data).digest();
  return data + '.' + base64url(sig);
}

function verify(token, secret) {
  if (!token) return null;
  const parts = String(token).split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  const expected = crypto.createHmac('sha256', secret).update(h + '.' + p).digest();
  let given;
  try { given = base64urlDecode(s); } catch (e) { return null; }
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  let payload;
  try { payload = JSON.parse(base64urlDecode(p).toString('utf8')); } catch (e) { return null; }
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

module.exports = { sign, verify };
