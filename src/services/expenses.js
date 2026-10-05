'use strict';
// Gastos y comprobantes. Un gasto enviado no se elimina; uno rechazado se conserva con su motivo.
const { bad, conflict, forbidden, notFound } = require('../http');
const { audit, notify, notifyPermission, nowIso, req, reqReason, num, id: toId, clientUuid, getConfig, round2 } = require('../core');
const policy = require('../policy');
const approvals = require('./approvals');

function serialize(db, user, e) {
  const trip = db.get('SELECT id, code, driver_id FROM trips WHERE id = ?', e.trip_id);
  const creator = db.get('SELECT id, name FROM users WHERE id = ?', e.created_by);
  const approval = db.get(`SELECT id, status, decided_at, decision_reason FROM approvals WHERE type = 'gasto_extraordinario' AND entity_id = ? ORDER BY id DESC LIMIT 1`, e.id);
  const out = {
    id: e.id, trip: trip ? { id: trip.id, code: trip.code } : null, category: e.category, amount: e.amount,
    liters: e.liters, odometer: e.odometer, description: e.description, supplier: e.supplier,
    receipt_number: e.receipt_number, receipt_date: e.receipt_date, receipt_file_id: e.receipt_file_id,
    extraordinary: !!e.extraordinary, approval_status: e.approval_status, approval,
    validation_status: e.validation_status, validation_reason: e.validation_reason, validated_at: e.validated_at,
    created_by: creator, created_at: e.created_at,
  };
  // La detección de duplicados es información de control para quien revisa.
  if (user.has('expenses.view_all')) out.possible_duplicate_of = e.possible_duplicate_of;
  return out;
}

function list(db, user, q = {}) {
  const scope = policy.expenseScopeSql(user);
  const where = [scope.where];
  const params = [...scope.params];
  if (q.trip_id) { where.push('e.trip_id = ?'); params.push(Number(q.trip_id)); }
  if (q.validation_status) { where.push('e.validation_status = ?'); params.push(q.validation_status); }
  if (q.approval_status) { where.push('e.approval_status = ?'); params.push(q.approval_status); }
  if (q.duplicates === '1') where.push('e.possible_duplicate_of IS NOT NULL');
  return db.all(`SELECT e.* FROM expenses e WHERE ${where.join(' AND ')} ORDER BY e.id DESC LIMIT 500`, ...params)
    .map((e) => serialize(db, user, e));
}

function findDuplicate(db, row) {
  if (row.receipt_sha256) {
    const d = db.get('SELECT id FROM expenses WHERE receipt_sha256 = ? ORDER BY id LIMIT 1', row.receipt_sha256);
    if (d) return d.id;
  }
  if (row.receipt_number && row.supplier) {
    const d = db.get('SELECT id FROM expenses WHERE lower(receipt_number) = lower(?) AND lower(supplier) = lower(?) ORDER BY id LIMIT 1', row.receipt_number, row.supplier);
    if (d) return d.id;
  }
  if (row.receipt_date) {
    const d = db.get(`SELECT id FROM expenses WHERE amount = ? AND receipt_date = ? AND category = ? AND vehicle_id IS ? ORDER BY id LIMIT 1`,
      row.amount, row.receipt_date, row.category, row.vehicle_id);
    if (d) return d.id;
  }
  return null;
}

function create(db, user, body) {
  req(body, 'trip_id', 'category', 'amount');
  const uuid = clientUuid(body.client_uuid);
  if (uuid) {
    const prev = db.get('SELECT * FROM expenses WHERE created_by = ? AND client_uuid = ?', user.id, uuid);
    if (prev) return { ...serialize(db, user, prev), duplicate_submission: true };
  }
  const trip = db.get('SELECT * FROM trips WHERE id = ?', toId(body.trip_id));
  // Alcance: el conductor solo registra gastos en sus viajes.
  if (!trip || !(user.has('expenses.create_any') || (user.has('expenses.create_own') && trip.driver_id === user.id))) {
    throw notFound('Viaje no encontrado');
  }
  if (['cerrado_financiero', 'cancelado'].includes(trip.status)) throw conflict('El viaje no admite nuevos gastos');
  if (user.has('expenses.create_own') && !user.has('expenses.create_any') && !['en_curso', 'fin_reportado', 'cierre_solicitado', 'inspeccion_aprobada'].includes(trip.status)) {
    throw conflict('Solo puede registrar gastos durante el servicio');
  }
  const categories = getConfig(db, 'expense_categories').map((c) => c.code);
  if (!categories.includes(body.category)) throw bad('Categoría de gasto inválida');
  const amount = round2(num(body.amount, 'amount', { min: 0.01 }));

  let fileId = null; let sha = null;
  if (body.receipt_file_id) {
    const f = db.get('SELECT * FROM files WHERE id = ?', toId(body.receipt_file_id));
    if (!f || f.owner_id !== user.id || f.entity_type) throw bad('Comprobante inválido');
    fileId = f.id; sha = f.sha256;
  }
  const threshold = getConfig(db, 'extraordinary_expense_threshold');
  const extraCats = getConfig(db, 'extraordinary_categories');
  const extraordinary = amount > threshold || extraCats.includes(body.category);
  if (extraordinary && (!body.description || String(body.description).trim().length < 3)) {
    throw bad('Los gastos extraordinarios requieren una descripción del motivo', { fields: ['description'] });
  }
  const row = {
    trip_id: trip.id, vehicle_id: trip.vehicle_id, category: body.category, amount,
    liters: body.liters ? num(body.liters, 'liters', { min: 0 }) : null,
    odometer: body.odometer ? Math.round(num(body.odometer, 'odometer', { min: 0 })) : null,
    description: body.description || null, supplier: body.supplier || null, receipt_number: body.receipt_number || null,
    receipt_date: body.receipt_date || null, receipt_file_id: fileId, receipt_sha256: sha,
    extraordinary: extraordinary ? 1 : 0, approval_status: extraordinary ? 'pendiente' : 'no_requerida',
    validation_status: 'pendiente', created_by: user.id, created_at: nowIso(), client_uuid: uuid,
  };
  row.possible_duplicate_of = findDuplicate(db, row);
  const id = db.tx(() => {
    const eid = db.insert('expenses', row);
    if (fileId) db.run("UPDATE files SET entity_type = 'expense', entity_id = ? WHERE id = ?", eid, fileId);
    audit(db, { user, action: 'gasto_registrado', entity: 'expense', id: eid, data: { trip: trip.code, category: row.category, amount, extraordinary } });
    if (extraordinary) {
      approvals.create(db, user, { type: 'gasto_extraordinario', entity: 'expense', entityId: eid, amount, reason: row.description });
    }
    if (row.possible_duplicate_of) {
      notifyPermission(db, 'expenses.validate', { type: 'duplicado', title: 'Posible comprobante duplicado', body: `El gasto #${eid} coincide con el #${row.possible_duplicate_of}.`, entity: 'expense', id: eid });
    }
    return eid;
  });
  return serialize(db, user, db.get('SELECT * FROM expenses WHERE id = ?', id));
}

function validate(db, user, expenseId, { decision, reason }) {
  return db.tx(() => {
    const e = db.get('SELECT * FROM expenses WHERE id = ?', Number(expenseId));
    if (!e) throw bad('Gasto inexistente');
    if (e.created_by === user.id) throw forbidden('No puede validar un gasto registrado por usted');
    if (e.validation_status !== 'pendiente') throw conflict('El gasto ya fue validado o rechazado');
    if (!['validado', 'rechazado'].includes(decision)) throw bad('Decisión inválida');
    if (decision === 'validado' && e.approval_status === 'pendiente') throw conflict('El gasto extraordinario aún no fue aprobado. Una solicitud pendiente no es una autorización.');
    if (decision === 'validado' && e.approval_status === 'rechazada') throw conflict('El gasto fue rechazado en aprobación');
    const trip = db.get('SELECT status FROM trips WHERE id = ?', e.trip_id);
    if (trip.status === 'cerrado_financiero') throw conflict('El viaje ya tiene cierre financiero');
    if (decision === 'rechazado') reason = reqReason(reason, 'motivo del rechazo');
    db.update('expenses', e.id, { validation_status: decision, validation_reason: reason || null, validated_by: user.id, validated_at: nowIso() });
    audit(db, { user, action: `gasto_${decision}`, entity: 'expense', id: e.id, reason });
    notify(db, [e.created_by], { type: 'gasto', title: `Gasto #${e.id} ${decision}`, body: reason ? `Motivo: ${reason}` : 'Su gasto fue validado.', entity: 'expense', id: e.id });
    return serialize(db, user, db.get('SELECT * FROM expenses WHERE id = ?', e.id));
  });
}

module.exports = { serialize, list, create, validate };
