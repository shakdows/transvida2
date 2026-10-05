'use strict';
// Solicitudes de aprobación: solicitante, responsable, motivo, fecha y estado.
// Una solicitud pendiente NO equivale a una autorización.
const { forbidden, notFound, conflict, bad } = require('../http');
const { audit, notify, notifyPermission, nowIso, reqReason, getConfig, round2 } = require('../core');

const TYPES = {
  gasto_extraordinario: { permission: 'approvals.decide_expense', label: 'Gasto extraordinario' },
  presupuesto_mantenimiento: { permission: 'approvals.decide_maintenance', label: 'Presupuesto de mantenimiento' },
  excepcion_operativa: { permission: 'approvals.decide_exception', label: 'Excepción operativa' },
};

function create(db, user, { type, subtype = null, entity, entityId, amount = null, reason }) {
  const id = db.insert('approvals', {
    type, subtype, entity_type: entity, entity_id: entityId, amount, reason: reqReason(reason),
    status: 'pendiente', requested_by: user.id, requested_at: nowIso(),
  });
  audit(db, { user, action: 'aprobacion_solicitada', entity: 'approval', id, reason, data: { type, subtype, entity, entityId, amount } });
  const label = TYPES[type].label;
  notifyPermission(db, TYPES[type].permission, {
    type: 'aprobacion', title: `Solicitud pendiente: ${label}`,
    body: `${user.name} solicita autorización (${label}). Motivo: ${reason}`,
    entity: 'approval', id, exclude: [user.id],
  });
  return id;
}

function serialize(db, user, a) {
  const by = (uid) => (uid ? db.get('SELECT id, name FROM users WHERE id = ?', uid) : null);
  const out = {
    ...a, type_label: TYPES[a.type]?.label, requested_by: by(a.requested_by), decided_by: by(a.decided_by),
    can_decide: a.status === 'pendiente' && user.has(TYPES[a.type]?.permission) && a.requested_by !== user.id,
    own_request: a.requested_by === user.id,
  };
  if (a.entity_type === 'trip' || a.entity_type === 'expense') {
    const tripId = a.entity_type === 'trip' ? a.entity_id : db.get('SELECT trip_id FROM expenses WHERE id = ?', a.entity_id)?.trip_id;
    out.trip = tripId ? db.get('SELECT id, code, origin, destination FROM trips WHERE id = ?', tripId) : null;
  }
  if (a.entity_type === 'work_order') {
    out.work_order = db.get(`SELECT w.id, w.title, v.plate FROM work_orders w JOIN vehicles v ON v.id = w.vehicle_id WHERE w.id = ?`, a.entity_id);
  }
  return out;
}

function list(db, user, { status } = {}) {
  const allowedTypes = Object.entries(TYPES).filter(([, t]) => user.has(t.permission)).map(([k]) => k);
  let where = 'requested_by = ?';
  const params = [user.id];
  if (user.has('approvals.view_all')) where = '1=1', params.length = 0;
  else if (allowedTypes.length) {
    where = `(requested_by = ? OR type IN (${allowedTypes.map(() => '?').join(',')}))`;
    params.push(...allowedTypes);
  }
  if (status) { where += ' AND status = ?'; params.push(status); }
  return db.all(`SELECT * FROM approvals WHERE ${where} ORDER BY (status = 'pendiente') DESC, id DESC LIMIT 300`, ...params)
    .map((a) => serialize(db, user, a));
}

function get(db, user, id) {
  const a = db.get('SELECT * FROM approvals WHERE id = ?', Number(id));
  if (!a) throw notFound('Solicitud no encontrada');
  if (!(user.has('approvals.view_all') || user.has(TYPES[a.type].permission) || a.requested_by === user.id)) throw notFound('Solicitud no encontrada');
  return serialize(db, user, a);
}

/**
 * Decide una solicitud. Reglas:
 *  - se requiere el permiso específico del tipo;
 *  - nadie aprueba su propia solicitud, aunque tenga varios perfiles;
 *  - tampoco quien creó el registro subyacente (p. ej. el gasto o la orden de trabajo);
 *  - el rechazo y las excepciones operativas exigen motivo.
 */
function decide(db, user, approvalId, { decision, reason }) {
  return db.tx(() => {
    const a = db.get('SELECT * FROM approvals WHERE id = ?', Number(approvalId));
    if (!a) throw notFound('Solicitud no encontrada');
    const type = TYPES[a.type];
    if (!user.has(type.permission)) throw forbidden('No tiene permiso para decidir este tipo de solicitud');
    if (a.requested_by === user.id) throw forbidden('No puede aprobar ni rechazar su propia solicitud');
    if (a.entity_type === 'expense') {
      const e = db.get('SELECT created_by FROM expenses WHERE id = ?', a.entity_id);
      if (e && e.created_by === user.id) throw forbidden('No puede aprobar un gasto registrado por usted');
    }
    if (a.entity_type === 'work_order') {
      const w = db.get('SELECT created_by FROM work_orders WHERE id = ?', a.entity_id);
      if (w && w.created_by === user.id) throw forbidden('No puede aprobar el presupuesto de una orden creada por usted');
    }
    if (a.status !== 'pendiente') throw conflict('La solicitud ya fue resuelta');
    if (!['aprobada', 'rechazada'].includes(decision)) throw bad('Decisión inválida');
    if (decision === 'rechazada' || a.type === 'excepcion_operativa') reason = reqReason(reason, 'motivo de la decisión');

    db.update('approvals', a.id, { status: decision, decided_by: user.id, decided_at: nowIso(), decision_reason: reason || null });
    applyEffects(db, user, a, decision, reason);
    audit(db, { user, action: `aprobacion_${decision}`, entity: 'approval', id: a.id, reason, data: { type: a.type, entity: a.entity_type, entityId: a.entity_id } });
    notify(db, [a.requested_by], {
      type: 'aprobacion', title: `${type.label}: ${decision}`,
      body: `Su solicitud #${a.id} fue ${decision} por ${user.name}.${reason ? ' Motivo: ' + reason : ''}`,
      entity: 'approval', id: a.id,
    });
    return get(db, user, a.id);
  });
}

function applyEffects(db, user, a, decision, reason) {
  if (a.type === 'gasto_extraordinario') {
    const changes = { approval_status: decision };
    // Un gasto rechazado se conserva con su estado y explicación.
    if (decision === 'rechazada') Object.assign(changes, { validation_status: 'rechazado', validation_reason: `Rechazado en aprobación: ${reason}`, validated_by: user.id, validated_at: nowIso() });
    db.update('expenses', a.entity_id, changes);
    const e = db.get('SELECT created_by FROM expenses WHERE id = ?', a.entity_id);
    if (e && e.created_by !== a.requested_by) notify(db, [e.created_by], { type: 'gasto', title: `Gasto #${a.entity_id} ${decision}`, body: reason || '', entity: 'expense', id: a.entity_id });
    if (decision === 'aprobada') {
      notifyPermission(db, 'expenses.validate', { type: 'gasto', title: 'Gasto extraordinario aprobado', body: `El gasto #${a.entity_id} quedó listo para validación.`, entity: 'expense', id: a.entity_id, exclude: [user.id] });
    }
  } else if (a.type === 'presupuesto_mantenimiento') {
    db.update('work_orders', a.entity_id, { budget_status: decision === 'aprobada' ? 'aprobado' : 'rechazado', updated_at: nowIso() });
  }
  // Las excepciones operativas no tienen efecto inmediato: se consultan al ejecutar la acción.
}

// Busca una excepción aprobada y vigente para el viaje.
function approvedException(db, tripId, subtype) {
  return db.get(`SELECT * FROM approvals WHERE type = 'excepcion_operativa' AND entity_type = 'trip'
    AND entity_id = ? AND subtype = ? AND status = 'aprobada' ORDER BY id DESC LIMIT 1`, tripId, subtype);
}

function requestException(db, user, tripId, { subtype, reason }) {
  const types = getConfig(db, 'exception_types').map((t) => t.code);
  if (!types.includes(subtype)) throw bad('Tipo de excepción no permitido');
  const trip = db.get('SELECT id FROM trips WHERE id = ?', Number(tripId));
  if (!trip) throw notFound('Viaje no encontrado');
  const pending = db.get(`SELECT id FROM approvals WHERE type='excepcion_operativa' AND entity_id = ? AND subtype = ? AND status = 'pendiente'`, trip.id, subtype);
  if (pending) throw conflict('Ya existe una solicitud pendiente para esta excepción');
  return create(db, user, { type: 'excepcion_operativa', subtype, entity: 'trip', entityId: trip.id, reason });
}

module.exports = { TYPES, create, list, get, decide, approvedException, requestException, round2 };
