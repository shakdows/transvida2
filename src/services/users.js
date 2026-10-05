'use strict';
// Administración de usuarios, perfiles y permisos.
const { bad, conflict, forbidden, notFound } = require('../http');
const { audit, nowIso, req } = require('../core');
const { ROLES, PERMISSIONS } = require('../permissions');
const { hashPassword } = require('../auth');

const PORTAL_ENABLED = false; // Portal de clientes: ampliación posterior.

function serialize(db, u) {
  return {
    id: u.id, username: u.username, name: u.name, phone: u.phone, email: u.email, active: !!u.active, created_at: u.created_at,
    roles: db.all('SELECT role FROM user_roles WHERE user_id = ? ORDER BY role', u.id).map((r) => r.role),
    permissions: db.all('SELECT permission FROM user_permissions WHERE user_id = ? ORDER BY permission', u.id).map((r) => r.permission),
  };
}

function list(db) {
  return db.all('SELECT * FROM users ORDER BY active DESC, name').map((u) => serialize(db, u));
}

function validateRoles(roles) {
  if (!Array.isArray(roles)) throw bad('Perfiles inválidos');
  for (const r of roles) {
    if (!ROLES[r]) throw bad(`Perfil desconocido: ${r}`);
    if (ROLES[r].future && !PORTAL_ENABLED) throw bad('El portal de clientes no está habilitado en esta versión');
  }
  return [...new Set(roles)];
}

function validatePermissions(perms) {
  if (!Array.isArray(perms)) throw bad('Permisos inválidos');
  for (const p of perms) if (!PERMISSIONS[p] || p === 'portal.view_own') throw bad(`Permiso desconocido: ${p}`);
  return [...new Set(perms)];
}

function validatePassword(pw) {
  if (!pw || String(pw).length < 8) throw bad('La contraseña debe tener al menos 8 caracteres');
}

function activeAdmins(db, excludeId = 0) {
  return db.get(`SELECT COUNT(*) AS c FROM users u JOIN user_roles r ON r.user_id = u.id
    WHERE r.role = 'admin' AND u.active = 1 AND u.id != ?`, excludeId).c;
}

function create(db, user, body) {
  req(body, 'username', 'name', 'password');
  validatePassword(body.password);
  const username = String(body.username).trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,40}$/.test(username)) throw bad('Nombre de usuario inválido');
  if (db.get('SELECT id FROM users WHERE username = ?', username)) throw conflict('El nombre de usuario ya existe');
  const roles = validateRoles(body.roles || []);
  const perms = validatePermissions(body.permissions || []);
  return db.tx(() => {
    const id = db.insert('users', {
      username, name: body.name, phone: body.phone || null, email: body.email || null,
      password_hash: hashPassword(body.password), active: 1, created_at: nowIso(), created_by: user.id,
    });
    for (const r of roles) db.insert('user_roles', { user_id: id, role: r, granted_by: user.id, granted_at: nowIso() });
    for (const p of perms) db.insert('user_permissions', { user_id: id, permission: p, granted_by: user.id, granted_at: nowIso() });
    audit(db, { kind: 'tecnico', user, action: 'usuario_creado', entity: 'user', id, data: { username, roles, permissions: perms } });
    return serialize(db, db.get('SELECT * FROM users WHERE id = ?', id));
  });
}

function update(db, user, userId, body) {
  const target = db.get('SELECT * FROM users WHERE id = ?', Number(userId));
  if (!target) throw notFound('Usuario no encontrado');
  const self = target.id === user.id;
  return db.tx(() => {
    const before = serialize(db, target);
    const changes = {};
    for (const f of ['name', 'phone', 'email']) if (body[f] !== undefined) changes[f] = body[f] || null;
    if (body.password) { validatePassword(body.password); changes.password_hash = hashPassword(body.password); }
    if (body.active !== undefined) {
      const active = body.active ? 1 : 0;
      if (self && !active) throw forbidden('No puede desactivar su propia cuenta');
      if (!active && before.roles.includes('admin') && activeAdmins(db, target.id) === 0) {
        throw conflict('No se puede desactivar al último administrador activo');
      }
      changes.active = active;
    }
    if (Object.keys(changes).length) db.update('users', target.id, changes);
    if (changes.active === 0) db.run('DELETE FROM sessions WHERE user_id = ?', target.id);

    if (body.roles !== undefined) {
      // Nadie se asigna perfiles a sí mismo: evita escalar privilegios (p. ej. finanzas) sin control.
      if (self) throw forbidden('No puede modificar sus propios perfiles; solicítelo a otro administrador');
      const roles = validateRoles(body.roles);
      if (before.roles.includes('admin') && !roles.includes('admin') && target.active && activeAdmins(db, target.id) === 0) {
        throw conflict('No se puede quitar el perfil al último administrador activo');
      }
      db.run('DELETE FROM user_roles WHERE user_id = ?', target.id);
      for (const r of roles) db.insert('user_roles', { user_id: target.id, role: r, granted_by: user.id, granted_at: nowIso() });
    }
    if (body.permissions !== undefined) {
      if (self) throw forbidden('No puede modificar sus propios permisos; solicítelo a otro administrador');
      const perms = validatePermissions(body.permissions);
      db.run('DELETE FROM user_permissions WHERE user_id = ?', target.id);
      for (const p of perms) db.insert('user_permissions', { user_id: target.id, permission: p, granted_by: user.id, granted_at: nowIso() });
    }
    const after = serialize(db, db.get('SELECT * FROM users WHERE id = ?', target.id));
    const { password_hash: _ph, ...safeChanges } = changes;
    audit(db, { kind: 'tecnico', user, action: 'usuario_actualizado', entity: 'user', id: target.id, reason: body.reason,
      data: { before: { roles: before.roles, permissions: before.permissions, active: before.active }, after: { roles: after.roles, permissions: after.permissions, active: after.active }, fields: Object.keys(safeChanges), password_reset: !!body.password } });
    return after;
  });
}

function catalog() {
  return {
    roles: Object.entries(ROLES).map(([code, r]) => ({ code, label: r.label, future: !!r.future, permissions: r.permissions, optional: r.optional || [] })),
    permissions: Object.entries(PERMISSIONS).map(([code, label]) => ({ code, label })),
    portal_enabled: PORTAL_ENABLED,
  };
}

module.exports = { list, create, update, catalog, serialize, PORTAL_ENABLED };
