'use strict';
// Mantenimiento: órdenes de trabajo, inmovilización y liberación técnica.
const { bad, conflict, notFound } = require('../http');
const { audit, notify, notifyPermission, nowIso, req, reqReason, num, id: toId, getConfig, round2 } = require('../core');
const fleet = require('./fleet');
const approvals = require('./approvals');

const OPEN = ['programado', 'pendiente_evaluacion', 'en_taller'];

function serialize(db, user, w) {
  const out = {
    id: w.id, vehicle: db.get('SELECT id, plate, kind FROM vehicles WHERE id = ?', w.vehicle_id), kind: w.kind,
    status: w.status, title: w.title, scheduled_date: w.scheduled_date, diagnosis: w.diagnosis, works: w.works,
    parts: JSON.parse(w.parts), entered_at: w.entered_at, exited_at: w.exited_at, incident_id: w.incident_id,
    budget_status: w.budget_status, created_by: db.get('SELECT id, name FROM users WHERE id = ?', w.created_by),
    created_at: w.created_at, updated_at: w.updated_at,
  };
  if (user.has('maintenance.view_costs')) {
    Object.assign(out, { labor_cost: w.labor_cost, parts_cost: w.parts_cost, total_cost: round2(w.labor_cost + w.parts_cost), budget_amount: w.budget_amount, closed_cost: w.closed_cost });
  }
  return out;
}

function list(db, user, q = {}) {
  const where = ['1=1']; const params = [];
  if (q.status) { const st = String(q.status).split(','); where.push(`status IN (${st.map(() => '?').join(',')})`); params.push(...st); }
  if (q.vehicle_id) { where.push('vehicle_id = ?'); params.push(Number(q.vehicle_id)); }
  return db.all(`SELECT * FROM work_orders WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT 300`, ...params).map((w) => serialize(db, user, w));
}

function load(db, id) {
  const w = db.get('SELECT * FROM work_orders WHERE id = ?', Number(id));
  if (!w) throw notFound('Orden de trabajo no encontrada');
  return w;
}

function get(db, user, id) { return serialize(db, user, load(db, id)); }

function create(db, user, body) {
  req(body, 'vehicle_id', 'title');
  const v = db.get('SELECT id FROM vehicles WHERE id = ?', toId(body.vehicle_id));
  if (!v) throw bad('Unidad inexistente');
  const kind = body.kind || 'preventivo';
  if (!['preventivo', 'correctivo'].includes(kind)) throw bad('Tipo inválido');
  const now = nowIso();
  const id = db.insert('work_orders', {
    vehicle_id: v.id, kind, status: 'programado', title: body.title, scheduled_date: body.scheduled_date || null,
    incident_id: body.incident_id ? toId(body.incident_id) : null, created_by: user.id, created_at: now, updated_at: now,
  });
  audit(db, { user, action: 'orden_trabajo_creada', entity: 'work_order', id, data: { vehicle_id: v.id, title: body.title, scheduled_date: body.scheduled_date } });
  return get(db, user, id);
}

function update(db, user, id, body) {
  const w = load(db, id);
  // Costos cerrados: no se modifican silenciosamente.
  if (!OPEN.includes(w.status)) throw conflict('La orden está cerrada; sus costos no se modifican');
  const changes = { updated_at: nowIso() };
  for (const f of ['title', 'diagnosis', 'works', 'scheduled_date']) if (body[f] !== undefined) changes[f] = body[f];
  if (body.parts !== undefined) {
    if (!Array.isArray(body.parts)) throw bad('Repuestos inválidos');
    const parts = body.parts.map((p) => ({ name: String(p.name || '').trim(), qty: num(p.qty ?? 1, 'qty', { min: 0 }), unit_cost: round2(num(p.unit_cost ?? 0, 'unit_cost', { min: 0 })) })).filter((p) => p.name);
    changes.parts = JSON.stringify(parts);
    changes.parts_cost = round2(parts.reduce((s, p) => s + p.qty * p.unit_cost, 0));
  }
  if (body.labor_cost !== undefined) changes.labor_cost = round2(num(body.labor_cost, 'labor_cost', { min: 0 }));
  // Si el costo aprobado se supera, el presupuesto debe aprobarse de nuevo.
  const total = (changes.labor_cost ?? w.labor_cost) + (changes.parts_cost ?? w.parts_cost);
  if (w.budget_status === 'aprobado' && w.budget_amount != null && total > w.budget_amount) changes.budget_status = 'excedido';
  db.update('work_orders', w.id, changes);
  audit(db, { user, action: 'orden_trabajo_actualizada', entity: 'work_order', id: w.id, data: { before: pickKeys(w, Object.keys(changes)), after: changes } });
  return get(db, user, w.id);
}

function pickKeys(o, keys) { const r = {}; keys.forEach((k) => { r[k] = o[k]; }); return r; }

function requestBudget(db, user, id, body) {
  const w = load(db, id);
  if (!OPEN.includes(w.status)) throw conflict('La orden está cerrada');
  if (w.budget_status === 'pendiente') throw conflict('Ya hay un presupuesto pendiente de aprobación');
  const amount = round2(num(body.amount, 'amount', { min: 0.01 }));
  const reason = reqReason(body.reason, 'motivo / detalle del presupuesto');
  db.tx(() => {
    db.update('work_orders', w.id, { budget_amount: amount, budget_status: 'pendiente', updated_at: nowIso() });
    approvals.create(db, user, { type: 'presupuesto_mantenimiento', entity: 'work_order', entityId: w.id, amount, reason });
  });
  return get(db, user, w.id);
}

function enterWorkshop(db, user, id) {
  const w = load(db, id);
  if (!['programado', 'pendiente_evaluacion'].includes(w.status)) throw conflict('La orden no puede ingresar a taller en este estado');
  const busy = db.get(`SELECT code FROM trips WHERE (vehicle_id = ? OR trailer_id = ?) AND status IN ('en_curso','fin_reportado','cierre_solicitado')`, w.vehicle_id, w.vehicle_id);
  if (busy) throw conflict(`La unidad está en viaje (${busy.code})`);
  db.update('work_orders', w.id, { status: 'en_taller', entered_at: nowIso(), updated_at: nowIso() });
  audit(db, { user, action: 'ingreso_taller', entity: 'work_order', id: w.id, data: { vehicle_id: w.vehicle_id } });
  notifyFleetChange(db, user, w.vehicle_id, 'ingresó a taller');
  return get(db, user, w.id);
}

function exitWorkshop(db, user, id, body = {}) {
  const w = load(db, id);
  // Una evaluación puede cerrarse sin ingreso a taller (p. ej. falla descartada o resuelta en patio).
  if (!['en_taller', 'pendiente_evaluacion'].includes(w.status)) throw conflict('La orden no está en taller ni en evaluación');
  const total = round2(w.labor_cost + w.parts_cost);
  const threshold = getConfig(db, 'maintenance_approval_threshold');
  if (total > threshold && !(w.budget_status === 'aprobado' && w.budget_amount >= total)) {
    throw conflict(`El costo (${total}) supera el umbral de ${threshold} y requiere presupuesto aprobado. Una solicitud pendiente no es una autorización.`, { code: 'requiere_aprobacion' });
  }
  if (!w.works && !w.diagnosis) throw bad('Registre el diagnóstico o los trabajos realizados');
  db.update('work_orders', w.id, { status: 'terminado', exited_at: nowIso(), closed_cost: total, updated_at: nowIso() });
  audit(db, { user, action: 'salida_taller', entity: 'work_order', id: w.id, reason: body.notes, data: { total } });
  return get(db, user, w.id);
}

function cancel(db, user, id, body) {
  const w = load(db, id);
  if (!['programado', 'pendiente_evaluacion'].includes(w.status)) throw conflict('Solo se cancelan órdenes que no ingresaron a taller');
  const reason = reqReason(body.reason);
  db.update('work_orders', w.id, { status: 'cancelado', updated_at: nowIso() });
  audit(db, { user, action: 'orden_trabajo_cancelada', entity: 'work_order', id: w.id, reason });
  return get(db, user, w.id);
}

function immobilize(db, user, vehicleId, body) {
  const v = db.get('SELECT * FROM vehicles WHERE id = ?', Number(vehicleId));
  if (!v) throw notFound('Unidad no encontrada');
  const reason = reqReason(body.reason);
  if (fleet.openImmobilization(db, v.id)) throw conflict('La unidad ya está inmovilizada');
  db.tx(() => {
    db.insert('immobilizations', { vehicle_id: v.id, reason, source: 'mantenimiento', created_by: user.id, created_at: nowIso() });
    audit(db, { user, action: 'unidad_inmovilizada', entity: 'vehicle', id: v.id, reason });
  });
  notifyFleetChange(db, user, v.id, `fue inmovilizada: ${reason}`);
  // No se reasignan viajes automáticamente: operaciones decide.
  const affected = db.all(`SELECT id, code, coordinator_id FROM trips WHERE (vehicle_id = ? OR trailer_id = ?) AND status IN ('programado','asignado','confirmado','inspeccion_aprobada')`, v.id, v.id);
  for (const t of affected) notify(db, [t.coordinator_id], { type: 'restriccion', title: `${t.code}: unidad inmovilizada`, body: `La unidad ${v.plate} asignada fue inmovilizada. Revise la asignación.`, entity: 'trip', id: t.id });
  return fleet.getVehicle(db, user, v.id);
}

/**
 * Liberación técnica. No cancela reservas ni cambia asignaciones: los viajes
 * bloqueados siguen asignados y el conductor debe repetir la inspección previa.
 */
function release(db, user, vehicleId, body) {
  const v = db.get('SELECT * FROM vehicles WHERE id = ?', Number(vehicleId));
  if (!v) throw notFound('Unidad no encontrada');
  const notes = reqReason(body.notes, 'detalle de la liberación técnica');
  const imm = fleet.openImmobilization(db, v.id);
  if (!imm) throw conflict('La unidad no está inmovilizada');
  if (fleet.inWorkshop(db, v.id)) throw conflict('Registre primero la salida del taller');
  const pendingEval = db.get("SELECT id FROM work_orders WHERE vehicle_id = ? AND status = 'pendiente_evaluacion'", v.id);
  if (pendingEval) throw conflict(`Cierre primero la evaluación técnica (orden #${pendingEval.id})`);
  db.tx(() => {
    db.run('UPDATE immobilizations SET released_at = ?, released_by = ?, release_notes = ? WHERE vehicle_id = ? AND released_at IS NULL', nowIso(), user.id, notes, v.id);
    audit(db, { user, action: 'liberacion_tecnica', entity: 'vehicle', id: v.id, reason: notes });
  });
  notifyFleetChange(db, user, v.id, 'fue liberada técnicamente');
  const blocked = db.all("SELECT id, code, driver_id, coordinator_id FROM trips WHERE vehicle_id = ? AND status = 'bloqueado'", v.id);
  for (const t of blocked) {
    notify(db, [t.driver_id, t.coordinator_id], { type: 'liberacion', title: `${t.code}: unidad liberada`, body: `La unidad ${v.plate} fue liberada técnicamente. Repita la inspección previa antes de salir.`, entity: 'trip', id: t.id });
  }
  return fleet.getVehicle(db, user, v.id);
}

function notifyFleetChange(db, user, vehicleId, what) {
  const plate = db.get('SELECT plate FROM vehicles WHERE id = ?', vehicleId).plate;
  for (const perm of ['trips.assign', 'reports.view']) {
    notifyPermission(db, perm, { type: 'flota', title: `Unidad ${plate}`, body: `La unidad ${plate} ${what}.`, entity: 'vehicle', id: vehicleId, exclude: [user.id] });
  }
}

function upcoming(db, user) {
  const vehicles = fleet.listVehicles(db, user);
  return {
    in_workshop: list(db, user, { status: 'en_taller' }),
    pending_evaluation: list(db, user, { status: 'pendiente_evaluacion' }),
    scheduled: list(db, user, { status: 'programado' }),
    immobilized: vehicles.filter((v) => v.availability.status === 'inmovilizado'),
    service_due: vehicles.filter((v) => v.service_due),
  };
}

module.exports = { list, get, create, update, requestBudget, enterWorkshop, exitWorkshop, cancel, immobilize, release, upcoming };
