'use strict';
// Rutas de la API. Cada ruta declara el permiso requerido y aplica el alcance del registro.
const crypto = require('node:crypto');
const { Router, bad, forbidden, notFound, conflict } = require('./http');
const core = require('./core');
const auth = require('./auth');
const policy = require('./policy');
const { ROLES } = require('./permissions');
const fleet = require('./services/fleet');
const trips = require('./services/trips');
const expenses = require('./services/expenses');
const incidents = require('./services/incidents');
const maintenance = require('./services/maintenance');
const approvals = require('./services/approvals');
const users = require('./services/users');
const reports = require('./services/reports');

const { need } = policy;

function build() {
  const r = new Router();

  // ---------- Sesión ----------
  r.post('/api/auth/login', ({ db, body, res, ip }) => {
    const username = String(body.username || '').trim().toLowerCase();
    if (auth.loginBlocked(username)) throw new (require('./http').HttpError)(429, 'bloqueado', 'Demasiados intentos. Espere un minuto.');
    const u = db.get('SELECT id, password_hash, active FROM users WHERE username = ?', username);
    if (!u || !u.active || !auth.verifyPassword(String(body.password || ''), u.password_hash)) {
      auth.loginFailed(username);
      core.audit(db, { kind: 'acceso', action: 'login_fallido', entity: 'user', id: u?.id, data: { username, ip } });
      throw new (require('./http').HttpError)(401, 'credenciales', 'Usuario o contraseña incorrectos');
    }
    auth.loginOk(username);
    const token = auth.createSession(db, u.id);
    core.audit(db, { kind: 'acceso', user: { id: u.id }, action: 'login', entity: 'user', id: u.id, data: { ip } });
    res.setHeader('Set-Cookie', `tv_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${12 * 3600}`);
    return { user: me(db, auth.loadUser(db, u.id)), token };
  }, { public: true });

  r.post('/api/auth/logout', ({ db, token, user, res }) => {
    if (token) auth.destroySession(db, token);
    core.audit(db, { kind: 'acceso', user, action: 'logout', entity: 'user', id: user.id });
    res.setHeader('Set-Cookie', 'tv_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    return { ok: true };
  });

  r.get('/api/me', ({ db, user }) => me(db, user));
  r.get('/api/config/public', ({ db }) => {
    const all = core.allConfig(db);
    const out = {};
    for (const k of core.PUBLIC_CONFIG_KEYS) out[k] = all[k];
    return out;
  });

  // ---------- Notificaciones ----------
  r.get('/api/notifications', ({ db, user }) => ({
    items: db.all('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 100', user.id),
    unread: db.get('SELECT COUNT(*) c FROM notifications WHERE user_id = ? AND read_at IS NULL', user.id).c,
  }));
  r.post('/api/notifications/read', ({ db, user, body }) => {
    if (body.id) db.run('UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ?', core.nowIso(), Number(body.id), user.id);
    else db.run('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL', core.nowIso(), user.id);
    return { ok: true };
  });

  // ---------- Tableros ----------
  r.get('/api/dashboard/executive', ({ db, user, query }) => { need(user, 'reports.view'); return reports.executive(db, user, query); });
  r.get('/api/dashboard/operations', ({ db, user }) => { need(user, 'workspace.operaciones'); return reports.operations(db, user); });
  r.get('/api/dashboard/maintenance', ({ db, user }) => { need(user, 'maintenance.view'); return maintenance.upcoming(db, user); });
  r.get('/api/dashboard/finance', ({ db, user }) => { need(user, 'workspace.finanzas'); return reports.finance(db, user); });

  // ---------- Flota ----------
  r.get('/api/vehicles', ({ db, user }) => { need(user, 'fleet.view'); return fleet.listVehicles(db, user); });
  r.get('/api/vehicles/:id', ({ db, user, params }) => {
    // El conductor puede consultar el vehículo y remolque que tiene asignados.
    if (!user.has('fleet.view')) {
      const assigned = db.get(`SELECT id FROM trips WHERE driver_id = ? AND (vehicle_id = ? OR trailer_id = ?)
        AND status NOT IN ('cerrado_operativo','cerrado_financiero','cancelado')`, user.id, Number(params.id), Number(params.id));
      if (!assigned) throw notFound('Unidad no encontrada');
      const v = db.get('SELECT id, plate, kind, brand, model, year, capacity FROM vehicles WHERE id = ?', Number(params.id));
      return v;
    }
    return fleet.getVehicle(db, user, params.id);
  });
  r.post('/api/vehicles', ({ db, user, body }) => { need(user, 'fleet.manage'); return fleet.createVehicle(db, user, body); });
  r.patch('/api/vehicles/:id', ({ db, user, params, body }) => { need(user, 'fleet.manage'); return fleet.updateVehicle(db, user, params.id, body); });
  r.post('/api/vehicles/:id/immobilize', ({ db, user, params, body }) => { need(user, 'maintenance.immobilize'); return maintenance.immobilize(db, user, params.id, body); });
  r.post('/api/vehicles/:id/release', ({ db, user, params, body }) => { need(user, 'maintenance.release'); return maintenance.release(db, user, params.id, body); });
  r.get('/api/drivers', ({ db, user }) => { need(user, 'drivers.view'); return fleet.driverAvailability(db); });

  r.get('/api/clients', ({ db, user }) => { need(user, 'clients.view', 'trips.create'); return db.all('SELECT * FROM clients ORDER BY name'); });
  r.post('/api/clients', ({ db, user, body }) => {
    need(user, 'clients.manage');
    core.req(body, 'name');
    const id = db.insert('clients', { name: body.name, tax_id: body.tax_id || null, contact: body.contact || null, created_at: core.nowIso() });
    core.audit(db, { user, action: 'cliente_creado', entity: 'client', id });
    return db.get('SELECT * FROM clients WHERE id = ?', id);
  });

  // ---------- Viajes ----------
  r.get('/api/trips', ({ db, user, query }) => { need(user, 'trips.view_all', 'trips.view_own'); return trips.list(db, user, query); });
  r.get('/api/trips/:id', ({ db, user, params }) => {
    const t = policy.loadTripFor(db, user, params.id);
    const out = policy.serializeTrip(db, user, t, { detail: true });
    if (user.has('finance.view_costs')) out.cost_entries = trips.listCosts(db, t.id);
    return out;
  });
  r.post('/api/trips', ({ db, user, body }) => { need(user, 'trips.create'); return trips.create(db, user, body); });
  r.post('/api/trips/:id/assign', ({ db, user, params, body }) => { need(user, 'trips.assign'); return trips.assign(db, user, params.id, body); });
  r.post('/api/trips/:id/reschedule', ({ db, user, params, body }) => { need(user, 'trips.reschedule'); return trips.reschedule(db, user, params.id, body); });
  r.post('/api/trips/:id/cancel', ({ db, user, params, body }) => { need(user, 'trips.reschedule'); return trips.cancel(db, user, params.id, body); });
  r.post('/api/trips/:id/validate-close', ({ db, user, params, body }) => { need(user, 'trips.validate_close'); return trips.validateClose(db, user, params.id, body); });
  r.post('/api/trips/:id/reject-close', ({ db, user, params, body }) => { need(user, 'trips.validate_close'); return trips.rejectClose(db, user, params.id, body); });
  r.post('/api/trips/:id/corrections', ({ db, user, params, body }) => { need(user, 'trips.correct_event'); return trips.correctEvent(db, user, params.id, body); });
  r.post('/api/trips/:id/exceptions', ({ db, user, params, body }) => {
    need(user, 'approvals.request');
    need(user, 'trips.assign');
    return approvals.get(db, user, approvals.requestException(db, user, params.id, body));
  });
  // Conductor (alcance: solo sus asignaciones; ver policy.loadOwnTrip)
  r.post('/api/trips/:id/confirm', ({ db, user, params, body }) => trips.confirm(db, user, params.id, body));
  r.post('/api/trips/:id/inspection', ({ db, user, params, body }) => trips.inspection(db, user, params.id, body));
  r.post('/api/trips/:id/milestones/:type', ({ db, user, params, body }) => trips.milestone(db, user, params.id, params.type, body));
  r.post('/api/trips/:id/request-close', ({ db, user, params, body }) => trips.requestClose(db, user, params.id, body));
  // Finanzas
  r.post('/api/trips/:id/revenue', ({ db, user, params, body }) => { need(user, 'trips.set_revenue'); return trips.setRevenue(db, user, params.id, body); });
  r.post('/api/trips/:id/costs', ({ db, user, params, body }) => { need(user, 'finance.adjust'); return trips.addCost(db, user, params.id, body); });
  r.post('/api/trips/:id/financial-close', ({ db, user, params, body }) => { need(user, 'trips.financial_close'); return trips.financialClose(db, user, params.id, body); });

  // ---------- Gastos ----------
  r.get('/api/expenses', ({ db, user, query }) => { need(user, 'expenses.view_all', 'expenses.create_own'); return expenses.list(db, user, query); });
  r.get('/api/expenses/:id', ({ db, user, params }) => expenses.serialize(db, user, policy.loadExpenseFor(db, user, params.id)));
  r.post('/api/expenses', ({ db, user, body }) => { need(user, 'expenses.create_any', 'expenses.create_own'); return expenses.create(db, user, body); });
  r.post('/api/expenses/:id/validate', ({ db, user, params, body }) => { need(user, 'expenses.validate'); return expenses.validate(db, user, params.id, body); });

  // ---------- Incidencias ----------
  r.get('/api/incidents', ({ db, user, query }) => incidents.list(db, user, query));
  r.get('/api/incidents/:id', ({ db, user, params }) => incidents.get(db, user, params.id));
  r.post('/api/incidents', ({ db, user, body }) => { need(user, 'incidents.report_any', 'incidents.report_own'); return incidents.create(db, user, body); });
  r.post('/api/incidents/:id/resolve', ({ db, user, params, body }) => { need(user, 'incidents.resolve'); return incidents.resolve(db, user, params.id, body); });

  // ---------- Inspecciones ----------
  r.get('/api/inspections', ({ db, user, query }) => {
    need(user, 'inspections.view_all');
    const where = query.result ? 'WHERE i.result = ?' : '';
    return db.all(`SELECT i.id, i.trip_id, t.code AS trip_code, v.plate, u.name AS driver, i.result, i.items, i.photo_ids, i.odometer, i.notes, i.created_at
      FROM inspections i JOIN trips t ON t.id = i.trip_id JOIN vehicles v ON v.id = i.vehicle_id JOIN users u ON u.id = i.driver_id ${where}
      ORDER BY i.id DESC LIMIT 200`, ...(query.result ? [query.result] : [])).map((i) => ({ ...i, items: JSON.parse(i.items), photo_ids: JSON.parse(i.photo_ids) }));
  });

  // ---------- Mantenimiento ----------
  r.get('/api/work-orders', ({ db, user, query }) => { need(user, 'maintenance.view'); return maintenance.list(db, user, query); });
  r.get('/api/work-orders/:id', ({ db, user, params }) => { need(user, 'maintenance.view'); return maintenance.get(db, user, params.id); });
  r.post('/api/work-orders', ({ db, user, body }) => { need(user, 'maintenance.manage'); return maintenance.create(db, user, body); });
  r.patch('/api/work-orders/:id', ({ db, user, params, body }) => { need(user, 'maintenance.manage'); return maintenance.update(db, user, params.id, body); });
  r.post('/api/work-orders/:id/budget', ({ db, user, params, body }) => { need(user, 'maintenance.manage'); need(user, 'approvals.request'); return maintenance.requestBudget(db, user, params.id, body); });
  r.post('/api/work-orders/:id/enter', ({ db, user, params }) => { need(user, 'maintenance.manage'); return maintenance.enterWorkshop(db, user, params.id); });
  r.post('/api/work-orders/:id/exit', ({ db, user, params, body }) => { need(user, 'maintenance.manage'); return maintenance.exitWorkshop(db, user, params.id, body); });
  r.post('/api/work-orders/:id/cancel', ({ db, user, params, body }) => { need(user, 'maintenance.manage'); return maintenance.cancel(db, user, params.id, body); });

  // ---------- Aprobaciones ----------
  r.get('/api/approvals', ({ db, user, query }) => approvals.list(db, user, query));
  r.get('/api/approvals/:id', ({ db, user, params }) => approvals.get(db, user, params.id));
  r.post('/api/approvals/:id/decide', ({ db, user, params, body }) => approvals.decide(db, user, params.id, body));

  // ---------- Archivos (comprobantes y fotografías) ----------
  r.post('/api/files', ({ db, user, body }) => {
    const m = /^data:(image\/(?:jpeg|png|webp)|application\/pdf);base64,(.+)$/.exec(String(body.data || ''));
    if (!m) throw bad('Archivo inválido: se aceptan imágenes JPG, PNG, WEBP o PDF');
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > 6 * 1024 * 1024) throw bad('El archivo supera 6 MB');
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    const id = db.insert('files', { owner_id: user.id, mime: m[1], size: buf.length, sha256: sha, data: buf, created_at: core.nowIso() });
    return { id, size: buf.length, mime: m[1] };
  });
  r.get('/api/files/:id', ({ db, user, params, res }) => {
    const f = db.get('SELECT * FROM files WHERE id = ?', Number(params.id));
    if (!f || !policy.canViewFile(db, user, f)) throw notFound('Archivo no encontrado');
    res.writeHead(200, { 'Content-Type': f.mime, 'Cache-Control': 'private, max-age=300', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'inline' });
    res.end(Buffer.from(f.data));
    return undefined;
  });

  // ---------- Borradores ----------
  r.get('/api/drafts', ({ db, user }) => db.all('SELECT * FROM drafts WHERE user_id = ? ORDER BY updated_at DESC', user.id).map((d) => ({ ...d, payload: JSON.parse(d.payload) })));
  r.put('/api/drafts', ({ db, user, body }) => {
    core.req(body, 'kind');
    if (!['inspeccion', 'gasto', 'incidencia'].includes(body.kind)) throw bad('Tipo de borrador inválido');
    const payload = JSON.stringify(body.payload || {});
    if (payload.length > 200000) throw bad('Borrador demasiado grande');
    const tripId = body.trip_id ? Number(body.trip_id) : null;
    if (tripId) policy.loadTripFor(db, user, tripId);
    db.run(`INSERT INTO drafts (user_id, kind, trip_id, payload, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (user_id, kind, trip_id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`, user.id, body.kind, tripId, payload, core.nowIso());
    return { ok: true };
  });
  // Un borrador no es un registro enviado: su autor puede descartarlo.
  r.delete('/api/drafts/:id', ({ db, user, params }) => { db.run('DELETE FROM drafts WHERE id = ? AND user_id = ?', Number(params.id), user.id); return { ok: true }; });

  // ---------- Reportes y exportación ----------
  r.get('/api/reports/trips.csv', ({ db, user, query, res }) => {
    need(user, 'reports.export', 'finance.export');
    core.audit(db, { user, action: 'reporte_exportado', entity: 'report', data: { report: 'trips', query } });
    return csvResponse(res, 'viajes.csv', reports.tripsCsv(db, user, query));
  });
  r.get('/api/reports/expenses.csv', ({ db, user, query, res }) => {
    need(user, 'finance.export');
    core.audit(db, { user, action: 'reporte_exportado', entity: 'report', data: { report: 'expenses', query } });
    return csvResponse(res, 'gastos-conciliacion.csv', reports.expensesCsv(db, query));
  });

  // ---------- Auditoría ----------
  r.get('/api/audit', ({ db, user, query }) => {
    const kinds = [];
    if (user.has('audit.view_business')) kinds.push('negocio');
    if (user.has('audit.view_technical')) kinds.push('tecnico', 'acceso');
    if (!kinds.length) throw forbidden();
    const wanted = query.kind ? kinds.filter((k) => k === query.kind) : kinds;
    if (!wanted.length) throw forbidden('No tiene acceso a ese tipo de auditoría');
    const params = [...wanted];
    let extra = '';
    if (query.entity) { extra += ' AND a.entity_type = ?'; params.push(query.entity); }
    if (query.entity_id) { extra += ' AND a.entity_id = ?'; params.push(Number(query.entity_id)); }
    return db.all(`SELECT a.*, u.name AS user_name FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
      WHERE a.kind IN (${wanted.map(() => '?').join(',')}) ${extra} ORDER BY a.id DESC LIMIT 300`, ...params)
      .map((a) => ({ ...a, data: a.data ? JSON.parse(a.data) : null }));
  });

  // ---------- Administración ----------
  r.get('/api/admin/users', ({ db, user }) => { need(user, 'users.manage'); return users.list(db); });
  r.get('/api/admin/catalog', ({ user }) => { need(user, 'users.manage'); return users.catalog(); });
  r.post('/api/admin/users', ({ db, user, body }) => { need(user, 'users.manage'); return users.create(db, user, body); });
  r.patch('/api/admin/users/:id', ({ db, user, params, body }) => { need(user, 'users.manage'); return users.update(db, user, params.id, body); });
  r.get('/api/admin/config', ({ db, user }) => { need(user, 'config.manage'); return core.allConfig(db); });
  r.put('/api/admin/config/:key', ({ db, user, params, body }) => {
    need(user, 'config.manage');
    if (!(params.key in core.DEFAULT_CONFIG)) throw bad('Parámetro desconocido');
    const value = body.value;
    validateConfig(params.key, value);
    const before = core.getConfig(db, params.key);
    db.run(`INSERT INTO config (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
      ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    params.key, JSON.stringify(value), core.nowIso(), user.id);
    core.audit(db, { kind: 'tecnico', user, action: 'configuracion_actualizada', entity: 'config', reason: body.reason, data: { key: params.key, before, after: value } });
    return { key: params.key, value };
  });
  r.get('/api/admin/integrations', ({ db, user }) => {
    need(user, 'integrations.manage');
    return db.all('SELECT code, enabled, settings, updated_at FROM integrations ORDER BY code').map((i) => ({ ...i, enabled: !!i.enabled, settings: JSON.parse(i.settings) }));
  });
  r.put('/api/admin/integrations/:code', ({ db, user, params, body }) => {
    need(user, 'integrations.manage');
    if (!['email', 'whatsapp'].includes(params.code)) throw bad('Integración desconocida');
    const settings = typeof body.settings === 'object' && body.settings ? body.settings : {};
    db.run(`INSERT INTO integrations (code, enabled, settings, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (code) DO UPDATE SET enabled = excluded.enabled, settings = excluded.settings, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    params.code, body.enabled ? 1 : 0, JSON.stringify(settings), core.nowIso(), user.id);
    core.audit(db, { kind: 'tecnico', user, action: 'integracion_actualizada', entity: 'integration', data: { code: params.code, enabled: !!body.enabled } });
    return { ok: true };
  });

  return r;
}

function validateConfig(key, value) {
  const def = core.DEFAULT_CONFIG[key];
  if (typeof def === 'number' && (typeof value !== 'number' || !(value >= 0))) throw bad('Debe ser un número mayor o igual a 0');
  if (typeof def === 'string' && typeof value !== 'string') throw bad('Debe ser texto');
  if (Array.isArray(def)) {
    if (!Array.isArray(value) || !value.length) throw bad('Debe ser una lista no vacía');
    if (typeof def[0] === 'object' && !value.every((v) => v && typeof v.code === 'string' && /^[a-z0-9_]+$/.test(v.code) && v.label)) {
      throw bad('Cada elemento requiere código (minúsculas) y etiqueta');
    }
  }
}

function csvResponse(res, filename, body) {
  res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${filename}"`, 'Cache-Control': 'no-store' });
  res.end(body);
  return undefined;
}

function me(db, user) {
  return {
    id: user.id, username: user.username, name: user.name, phone: user.phone, roles: user.roles,
    workspaces: user.workspaces.map((w) => ({ code: w, label: ROLES[w].label, home: ROLES[w].home })),
    permissions: [...user.perms].sort(),
    unread: db.get('SELECT COUNT(*) c FROM notifications WHERE user_id = ? AND read_at IS NULL', user.id).c,
  };
}

module.exports = { build, conflict };
