'use strict';
// Autorización a nivel de registro y filtrado de campos sensibles.
// Toda consulta de un registro concreto pasa por estas funciones: un conductor que cambia
// el id en la URL recibe 404 (no se revela la existencia de registros ajenos).
const { forbidden, notFound } = require('./http');
const { round2 } = require('./core');

function need(user, ...perms) {
  if (!perms.some((p) => user.has(p))) throw forbidden();
}

// ---------- Viajes ----------
function tripScopeSql(user, alias = 't') {
  if (user.has('trips.view_all')) return { where: '1=1', params: [] };
  if (user.has('trips.view_own')) return { where: `${alias}.driver_id = ?`, params: [user.id] };
  if (user.has('portal.view_own') && user.client_id) return { where: `${alias}.client_id = ?`, params: [user.client_id] };
  return { where: '0=1', params: [] };
}

function canViewTrip(user, trip) {
  if (user.has('trips.view_all')) return true;
  if (user.has('trips.view_own') && trip.driver_id === user.id) return true;
  return false;
}

function loadTripFor(db, user, tripId) {
  const trip = db.get('SELECT * FROM trips WHERE id = ?', Number(tripId));
  if (!trip || !canViewTrip(user, trip)) throw notFound('Viaje no encontrado');
  return trip;
}

// El conductor solo opera sus propias asignaciones.
function loadOwnTrip(db, user, tripId) {
  need(user, 'trips.driver_operate');
  const trip = db.get('SELECT * FROM trips WHERE id = ?', Number(tripId));
  if (!trip || trip.driver_id !== user.id) throw notFound('Viaje no encontrado');
  return trip;
}

function tripCosts(db, tripId) {
  const exp = db.get(`SELECT
      COALESCE(SUM(CASE WHEN validation_status = 'validado' THEN amount END), 0) AS validated,
      COALESCE(SUM(CASE WHEN validation_status = 'pendiente' THEN amount END), 0) AS pending,
      COALESCE(SUM(CASE WHEN validation_status != 'rechazado' AND category = 'combustible' THEN amount END), 0) AS fuel
    FROM expenses WHERE trip_id = ?`, tripId);
  const ce = db.get(`SELECT
      COALESCE(SUM(CASE WHEN after_close = 0 THEN amount END), 0) AS allocated,
      COALESCE(SUM(CASE WHEN after_close = 1 THEN amount END), 0) AS adjustments
    FROM cost_entries WHERE trip_id = ?`, tripId);
  return {
    expenses_validated: round2(exp.validated), expenses_pending: round2(exp.pending), fuel: round2(exp.fuel),
    allocated: round2(ce.allocated), adjustments: round2(ce.adjustments),
    total: round2(exp.validated + exp.pending + ce.allocated + ce.adjustments),
  };
}

const STATUS_LABELS = {
  programado: 'Programado (sin recursos)',
  asignado: 'Asignado — pendiente de confirmación',
  confirmado: 'Confirmado — pendiente de inspección',
  inspeccion_aprobada: 'Inspección aprobada — listo para salir',
  bloqueado: 'Bloqueado por falla crítica',
  en_curso: 'En curso',
  fin_reportado: 'Conductor reportó fin del servicio',
  cierre_solicitado: 'Cierre operativo solicitado',
  cerrado_operativo: 'Operaciones validó cierre',
  cerrado_financiero: 'Cierre financiero realizado',
  cancelado: 'Cancelado',
};

function person(db, userId) {
  if (!userId) return null;
  const u = db.get('SELECT id, name, phone FROM users WHERE id = ?', userId);
  return u || null;
}

function vehicleRef(db, vid) {
  if (!vid) return null;
  return db.get('SELECT id, plate, kind, brand, model FROM vehicles WHERE id = ?', vid) || null;
}

function serializeTrip(db, user, t, { detail = false } = {}) {
  const now = new Date().toISOString();
  const client = t.client_id ? db.get('SELECT id, name FROM clients WHERE id = ?', t.client_id) : null;
  const out = {
    id: t.id, code: t.code, status: t.status, status_label: STATUS_LABELS[t.status],
    client, origin: t.origin, destination: t.destination, cargo: t.cargo, instructions: t.instructions,
    scheduled_start: t.scheduled_start, scheduled_end: t.scheduled_end,
    vehicle: vehicleRef(db, t.vehicle_id), trailer: vehicleRef(db, t.trailer_id),
    driver: person(db, t.driver_id), coordinator: person(db, t.coordinator_id),
    km_start: t.km_start, km_end: t.km_end, confirmed_at: t.confirmed_at, started_at: t.started_at,
    driver_end_reported_at: t.driver_end_reported_at, close_requested_at: t.close_requested_at,
    ops_closed_at: t.ops_closed_at, fin_closed_at: t.fin_closed_at, cancel_reason: t.cancel_reason,
    delayed: isDelayed(t, now),
  };
  if (user.has('finance.view_costs') || user.has('finance.view_revenue')) {
    const c = tripCosts(db, t.id);
    out.costs = c;
    out.budget_cost = t.budget_cost;
    if (t.status === 'cerrado_financiero') {
      out.fin_cost = t.fin_cost;
    }
    if (user.has('finance.view_revenue')) {
      out.revenue_agreed = t.revenue_agreed;
      if (t.revenue_agreed != null) out.margin = round2(t.revenue_agreed - c.total);
      if (t.status === 'cerrado_financiero') {
        out.fin_revenue = t.fin_revenue;
        out.fin_margin = t.fin_margin;
        out.adjusted_margin = round2(t.fin_margin - c.adjustments);
      }
    }
  }
  if (detail) {
    out.events = db.all(`SELECT e.id, e.type, e.at, e.odometer, e.notes, u.name AS user_name
      FROM trip_events e JOIN users u ON u.id = e.user_id WHERE trip_id = ? ORDER BY e.id`, t.id);
    out.inspections = db.all(`SELECT id, result, items, photo_ids, odometer, notes, created_at FROM inspections
      WHERE trip_id = ? ORDER BY id`, t.id).map((i) => ({ ...i, items: JSON.parse(i.items), photo_ids: JSON.parse(i.photo_ids) }));
  }
  return out;
}

function isDelayed(t, now) {
  if (['cerrado_operativo', 'cerrado_financiero', 'cancelado'].includes(t.status)) return false;
  if (['fin_reportado', 'cierre_solicitado'].includes(t.status)) return (t.driver_end_reported_at || now) > t.scheduled_end;
  if (!t.started_at && now > t.scheduled_start) return true;
  return now > t.scheduled_end;
}

// ---------- Gastos ----------
function expenseScopeSql(user) {
  if (user.has('expenses.view_all')) return { where: '1=1', params: [] };
  // El conductor ve los gastos que registró en sus viajes.
  return { where: 'e.created_by = ?', params: [user.id] };
}

function loadExpenseFor(db, user, expenseId) {
  const e = db.get('SELECT * FROM expenses WHERE id = ?', Number(expenseId));
  if (!e) throw notFound('Gasto no encontrado');
  if (user.has('expenses.view_all') || e.created_by === user.id) return e;
  throw notFound('Gasto no encontrado');
}

// ---------- Incidencias ----------
const MECHANICAL = ['averia'];
function incidentScopeSql(user) {
  if (user.has('incidents.view_all')) return { where: '1=1', params: [] };
  const parts = ['i.reported_by = ?'];
  const params = [user.id];
  if (user.has('incidents.view_mechanical')) parts.push(`i.type IN (${MECHANICAL.map(() => '?').join(',')})`), params.push(...MECHANICAL);
  return { where: `(${parts.join(' OR ')})`, params };
}

function canViewIncident(user, i) {
  return user.has('incidents.view_all') || i.reported_by === user.id
    || (user.has('incidents.view_mechanical') && MECHANICAL.includes(i.type));
}

// ---------- Archivos ----------
function canViewFile(db, user, f) {
  if (f.owner_id === user.id) return true;
  if (f.entity_type === 'expense') {
    const e = db.get('SELECT * FROM expenses WHERE id = ?', f.entity_id);
    return !!e && (user.has('expenses.view_all') || e.created_by === user.id);
  }
  if (f.entity_type === 'inspection') {
    const i = db.get('SELECT trip_id FROM inspections WHERE id = ?', f.entity_id);
    if (!i) return false;
    if (user.has('inspections.view_all')) return true;
    const t = db.get('SELECT driver_id FROM trips WHERE id = ?', i.trip_id);
    return !!t && t.driver_id === user.id;
  }
  return false;
}

// ---------- Portal de clientes (preparado, no habilitado en el MVP) ----------
// Vista mínima para un cliente externo: sin costos, márgenes, otros clientes ni ubicación exacta.
function serializeTripForClient(db, t, { allowLocation = false } = {}) {
  const milestones = db.all(`SELECT type, at FROM trip_events WHERE trip_id = ? AND type IN
    ('salida','llegada_carga','inicio_traslado','llegada_destino','fin_servicio') ORDER BY id`, t.id);
  const out = {
    code: t.code, status: STATUS_LABELS[t.status], origin: t.origin, destination: t.destination,
    milestones, eta: milestones.length >= 1 ? t.scheduled_end : null,
    incidents: db.all(`SELECT type, created_at, status FROM incidents WHERE trip_id = ? AND communicated_to_client = 1`, t.id),
  };
  if (allowLocation) out.location = null; // requiere política y autorización explícitas
  return out;
}

module.exports = {
  need, tripScopeSql, canViewTrip, loadTripFor, loadOwnTrip, tripCosts, serializeTrip, STATUS_LABELS, isDelayed,
  person, vehicleRef, expenseScopeSql, loadExpenseFor, incidentScopeSql, canViewIncident, canViewFile,
  serializeTripForClient, MECHANICAL,
};
