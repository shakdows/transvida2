'use strict';
const crypto = require('node:crypto');
const { resolvePermissions, ROLES } = require('./permissions');
const { nowIso } = require('./core');

const SESSION_HOURS = 12;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [alg, saltHex, hashHex] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const hash = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), 32);
  return crypto.timingSafeEqual(hash, Buffer.from(hashHex, 'hex'));
}

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function createSession(db, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_HOURS * 3600e3).toISOString();
  db.insert('sessions', { token_hash: sha(token), user_id: userId, created_at: nowIso(), expires_at: expires });
  return token;
}

function destroySession(db, token) {
  db.run('DELETE FROM sessions WHERE token_hash = ?', sha(token));
}

// Carga el usuario con sus permisos efectivos. Se recalcula en cada solicitud:
// desactivar un usuario o quitarle un perfil tiene efecto inmediato.
function loadUser(db, userId) {
  const u = db.get('SELECT id, username, name, phone, email, active, client_id FROM users WHERE id = ?', userId);
  if (!u || !u.active) return null;
  const roles = db.all('SELECT role FROM user_roles WHERE user_id = ? ORDER BY role', userId).map((r) => r.role);
  const explicit = db.all('SELECT permission FROM user_permissions WHERE user_id = ?', userId).map((r) => r.permission);
  const perms = resolvePermissions(roles, explicit);
  return {
    ...u, roles, explicit, perms,
    has: (p) => perms.has(p),
    workspaces: roles.filter((r) => ROLES[r] && !ROLES[r].future && perms.has(`workspace.${r}`)),
  };
}

function userFromToken(db, token) {
  if (!token) return null;
  const s = db.get('SELECT user_id, expires_at FROM sessions WHERE token_hash = ?', sha(token));
  if (!s || s.expires_at < nowIso()) return null;
  return loadUser(db, s.user_id);
}

// Limitador sencillo de intentos fallidos por usuario.
const failures = new Map();
function loginBlocked(username) {
  const f = failures.get(username);
  return f && f.count >= 5 && Date.now() - f.last < 60e3;
}
function loginFailed(username) {
  const f = failures.get(username) || { count: 0, last: 0 };
  if (Date.now() - f.last > 60e3) f.count = 0;
  f.count++; f.last = Date.now();
  failures.set(username, f);
}
function loginOk(username) { failures.delete(username); }

module.exports = { hashPassword, verifyPassword, createSession, destroySession, loadUser, userFromToken, loginBlocked, loginFailed, loginOk };
