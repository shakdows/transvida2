'use strict';
// Servicios transversales: configuración, auditoría, notificaciones y utilidades.
const { bad } = require('./http');

const DEFAULT_CONFIG = {
  currency: 'USD',
  // Un gasto que supere este monto (o pertenezca a una categoría extraordinaria) requiere aprobación de gerencia.
  extraordinary_expense_threshold: 500,
  extraordinary_categories: ['reparacion_ruta', 'multa'],
  expense_categories: [
    { code: 'combustible', label: 'Combustible' },
    { code: 'peaje', label: 'Peaje' },
    { code: 'alimentacion', label: 'Alimentación' },
    { code: 'hospedaje', label: 'Hospedaje' },
    { code: 'estacionamiento', label: 'Estacionamiento' },
    { code: 'lavado', label: 'Lavado' },
    { code: 'reparacion_ruta', label: 'Reparación en ruta' },
    { code: 'multa', label: 'Multa' },
    { code: 'otro', label: 'Otro' },
  ],
  // Presupuestos de mantenimiento por encima de este monto requieren aprobación.
  maintenance_approval_threshold: 1500,
  // Reprogramar con menos horas de anticipación requiere una excepción autorizada.
  reprogram_min_hours: 4,
  exception_types: [
    { code: 'solapamiento_conductor', label: 'Asignar conductor con servicios superpuestos' },
    { code: 'reprogramacion_tardia', label: 'Reprogramar con poca anticipación' },
  ],
  incident_types: [
    { code: 'averia', label: 'Avería' },
    { code: 'retraso', label: 'Retraso' },
    { code: 'accidente', label: 'Accidente' },
    { code: 'carga', label: 'Problema con la carga' },
    { code: 'documentacion', label: 'Documentación' },
    { code: 'otro', label: 'Otro' },
  ],
  inspection_checklist: [
    { code: 'frenos', label: 'Frenos', critical: true },
    { code: 'neumaticos', label: 'Neumáticos', critical: true },
    { code: 'luces', label: 'Luces y señalización', critical: true },
    { code: 'direccion', label: 'Dirección', critical: true },
    { code: 'fugas', label: 'Sin fugas de aceite o combustible', critical: true },
    { code: 'enganche', label: 'Quinta rueda / enganche', critical: true },
    { code: 'espejos', label: 'Espejos', critical: false },
    { code: 'extintor', label: 'Extintor y botiquín', critical: false },
    { code: 'documentos', label: 'Documentos de la unidad', critical: false },
    { code: 'limpieza', label: 'Limpieza de cabina', critical: false },
  ],
  inspection_min_photos: 1,
  service_due_km_window: 1500,
  service_due_days_window: 14,
};

const PUBLIC_CONFIG_KEYS = ['currency', 'expense_categories', 'incident_types', 'inspection_checklist',
  'extraordinary_expense_threshold', 'extraordinary_categories',
  'inspection_min_photos', 'exception_types'];

const nowIso = () => new Date().toISOString();
const round2 = (n) => Math.round(Number(n) * 100) / 100;

function getConfig(db, key) {
  const row = db.get('SELECT value FROM config WHERE key = ?', key);
  return row ? JSON.parse(row.value) : DEFAULT_CONFIG[key];
}

function allConfig(db) {
  const out = { ...DEFAULT_CONFIG };
  for (const r of db.all('SELECT key, value FROM config')) out[r.key] = JSON.parse(r.value);
  return out;
}

function audit(db, { kind = 'negocio', user, action, entity, id, reason, data }) {
  db.insert('audit_log', {
    at: nowIso(), kind, user_id: user ? user.id : null, action,
    entity_type: entity || null, entity_id: id ?? null, reason: reason || null,
    data: data === undefined ? null : JSON.stringify(data),
  });
}

// Usuarios activos que tienen un permiso (por perfil o por concesión explícita).
function usersWithPermission(db, permission) {
  const { ROLES } = require('./permissions');
  const roles = Object.entries(ROLES).filter(([, r]) => r.permissions.includes(permission)).map(([k]) => k);
  const ids = new Set();
  if (roles.length) {
    const rows = db.all(`SELECT DISTINCT ur.user_id AS id FROM user_roles ur JOIN users u ON u.id = ur.user_id
      WHERE u.active = 1 AND ur.role IN (${roles.map(() => '?').join(',')})`, ...roles);
    rows.forEach((r) => ids.add(r.id));
  }
  db.all(`SELECT up.user_id AS id FROM user_permissions up JOIN users u ON u.id = up.user_id
    WHERE u.active = 1 AND up.permission = ?`, permission).forEach((r) => ids.add(r.id));
  return [...ids];
}

function userHas(db, userId, permission) {
  const { resolvePermissions } = require('./permissions');
  const roles = db.all('SELECT role FROM user_roles WHERE user_id = ?', userId).map((r) => r.role);
  const explicit = db.all('SELECT permission FROM user_permissions WHERE user_id = ?', userId).map((r) => r.permission);
  return resolvePermissions(roles, explicit).has(permission);
}

/**
 * Notificación dentro de la aplicación.
 * `sensitive` contiene un texto alternativo con datos financieros que solo reciben
 * quienes tengan `sensitivePermission`; el resto recibe `body`, sin datos sensibles.
 */
function notify(db, recipients, { type, title, body, sensitive, sensitivePermission = 'finance.view_revenue', entity, id, exclude = [] }) {
  const unique = [...new Set(recipients)].filter((u) => u && !exclude.includes(u));
  const integrations = db.all('SELECT code FROM integrations WHERE enabled = 1').map((r) => r.code);
  for (const userId of unique) {
    const text = sensitive && userHas(db, userId, sensitivePermission) ? sensitive : body;
    db.insert('notifications', {
      user_id: userId, type, title, body: text, entity_type: entity || null, entity_id: id ?? null, created_at: nowIso(),
    });
    // Integraciones opcionales (correo / WhatsApp): se encolan con el mismo texto ya filtrado.
    if (integrations.length) {
      const u = db.get('SELECT email, phone FROM users WHERE id = ?', userId);
      if (integrations.includes('email') && u.email) db.insert('outbox', { channel: 'email', user_id: userId, destination: u.email, body: `${title}\n${text}`, created_at: nowIso() });
      if (integrations.includes('whatsapp') && u.phone) db.insert('outbox', { channel: 'whatsapp', user_id: userId, destination: u.phone, body: `${title}: ${text}`, created_at: nowIso() });
    }
  }
}

function notifyPermission(db, permission, payload) {
  notify(db, usersWithPermission(db, permission), payload);
}

// Validaciones simples
function req(body, ...fields) {
  const missing = fields.filter((f) => body[f] === undefined || body[f] === null || String(body[f]).trim() === '');
  if (missing.length) throw bad(`Faltan campos obligatorios: ${missing.join(', ')}`, { fields: missing });
}
function reqReason(reason, what = 'motivo') {
  if (!reason || String(reason).trim().length < 3) throw bad(`Debe indicar el ${what}`, { fields: ['reason'] });
  return String(reason).trim();
}
function num(v, field, { min = -Infinity } = {}) {
  const n = Number(v);
  if (v === '' || v === null || v === undefined || !Number.isFinite(n) || n < min) throw bad(`Valor numérico inválido: ${field}`, { fields: [field] });
  return n;
}
function date(v, field) {
  const d = new Date(v);
  if (!v || Number.isNaN(d.getTime())) throw bad(`Fecha inválida: ${field}`, { fields: [field] });
  return d.toISOString();
}
function id(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}
function clientUuid(v) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(v)) throw bad('Identificador de envío inválido');
  return v;
}

module.exports = {
  DEFAULT_CONFIG, PUBLIC_CONFIG_KEYS, nowIso, round2, getConfig, allConfig, audit,
  usersWithPermission, userHas, notify, notifyPermission, req, reqReason, num, date, id, clientUuid,
};
