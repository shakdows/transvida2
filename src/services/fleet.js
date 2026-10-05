'use strict';
// Flota, disponibilidad y restricciones técnicas.
const { conflict, notFound, bad } = require('../http');
const { audit, nowIso, req, num, getConfig } = require('../core');

// Estados del viaje que ocupan recursos. La finalización operativa los libera:
// un cierre financiero pendiente NO mantiene ocupado al camión.
const OCCUPYING = ['programado', 'asignado', 'confirmado', 'inspeccion_aprobada', 'bloqueado', 'en_curso', 'fin_reportado', 'cierre_solicitado'];
const ON_ROAD = ['en_curso', 'fin_reportado', 'cierre_solicitado'];

function openImmobilization(db, vehicleId) {
  return db.get('SELECT * FROM immobilizations WHERE vehicle_id = ? AND released_at IS NULL ORDER BY id DESC LIMIT 1', vehicleId);
}

function inWorkshop(db, vehicleId) {
  return db.get("SELECT id, title FROM work_orders WHERE vehicle_id = ? AND status = 'en_taller' LIMIT 1", vehicleId);
}

function vehicleAvailability(db, v) {
  const imm = openImmobilization(db, v.id);
  const shop = inWorkshop(db, v.id);
  const now = nowIso();
  const onRoad = db.get(`SELECT id, code FROM trips WHERE (vehicle_id = ? OR trailer_id = ?) AND status IN (${ON_ROAD.map(() => '?').join(',')}) LIMIT 1`, v.id, v.id, ...ON_ROAD);
  const reserved = db.all(`SELECT id, code, scheduled_start, scheduled_end FROM trips WHERE (vehicle_id = ? OR trailer_id = ?)
    AND status IN ('programado','asignado','confirmado','inspeccion_aprobada','bloqueado') AND scheduled_end >= ? ORDER BY scheduled_start`, v.id, v.id, now);
  let status = 'disponible';
  if (imm) status = 'inmovilizado';
  else if (shop) status = 'en_taller';
  else if (onRoad) status = 'en_viaje';
  else if (reserved.length) status = 'reservado';
  return {
    status,
    immobilization: imm ? { id: imm.id, reason: imm.reason, since: imm.created_at, source: imm.source } : null,
    work_order: shop || null,
    current_trip: onRoad || null,
    reservations: reserved,
  };
}

function serializeVehicle(db, user, v) {
  const out = { ...v, availability: vehicleAvailability(db, v) };
  const kmWindow = getConfig(db, 'service_due_km_window');
  const dayWindow = getConfig(db, 'service_due_days_window');
  const soon = new Date(Date.now() + dayWindow * 86400e3).toISOString().slice(0, 10);
  out.service_due = Boolean((v.next_service_km && v.next_service_km - v.odometer <= kmWindow)
    || (v.next_service_date && v.next_service_date <= soon));
  return out;
}

function listVehicles(db, user) {
  return db.all('SELECT * FROM vehicles WHERE active = 1 ORDER BY kind DESC, plate').map((v) => serializeVehicle(db, user, v));
}

function getVehicle(db, user, id) {
  const v = db.get('SELECT * FROM vehicles WHERE id = ?', Number(id));
  if (!v) throw notFound('Unidad no encontrada');
  const out = serializeVehicle(db, user, v);
  out.immobilizations = db.all(`SELECT i.*, u.name AS created_by_name, r.name AS released_by_name FROM immobilizations i
    JOIN users u ON u.id = i.created_by LEFT JOIN users r ON r.id = i.released_by WHERE vehicle_id = ? ORDER BY i.id DESC`, v.id);
  return out;
}

const VEHICLE_FIELDS = ['plate', 'kind', 'brand', 'model', 'year', 'capacity', 'odometer', 'next_service_km', 'next_service_date', 'notes'];

function createVehicle(db, user, body) {
  req(body, 'plate', 'kind');
  if (!['tractor', 'remolque'].includes(body.kind)) throw bad('Tipo de unidad inválido');
  const row = { created_at: nowIso() };
  for (const f of VEHICLE_FIELDS) if (body[f] !== undefined) row[f] = body[f];
  row.plate = String(row.plate).toUpperCase().trim();
  if (db.get('SELECT id FROM vehicles WHERE plate = ?', row.plate)) throw conflict('Ya existe una unidad con esa placa');
  const id = db.insert('vehicles', row);
  audit(db, { user, action: 'unidad_creada', entity: 'vehicle', id, data: row });
  return getVehicle(db, user, id);
}

function updateVehicle(db, user, id, body) {
  const v = db.get('SELECT * FROM vehicles WHERE id = ?', Number(id));
  if (!v) throw notFound('Unidad no encontrada');
  const changes = {};
  for (const f of ['brand', 'model', 'year', 'capacity', 'next_service_km', 'next_service_date', 'notes']) {
    if (body[f] !== undefined) changes[f] = body[f] === '' ? null : body[f];
  }
  if (body.odometer !== undefined) {
    const km = num(body.odometer, 'odometer', { min: 0 });
    if (km < v.odometer) throw bad('El kilometraje no puede ser menor al registrado');
    changes.odometer = Math.round(km);
  }
  db.update('vehicles', v.id, changes);
  audit(db, { user, action: 'ficha_tecnica_actualizada', entity: 'vehicle', id: v.id, data: { before: pick(v, Object.keys(changes)), after: changes } });
  return getVehicle(db, user, v.id);
}

function pick(o, keys) { const r = {}; keys.forEach((k) => { r[k] = o[k]; }); return r; }

function driverAvailability(db) {
  const now = nowIso();
  return db.all(`SELECT u.id, u.name, u.phone FROM users u JOIN user_roles r ON r.user_id = u.id
    WHERE r.role = 'conductor' AND u.active = 1 ORDER BY u.name`).map((d) => {
    const onRoad = db.get(`SELECT id, code FROM trips WHERE driver_id = ? AND status IN (${ON_ROAD.map(() => '?').join(',')}) LIMIT 1`, d.id, ...ON_ROAD);
    const reservations = db.all(`SELECT id, code, scheduled_start, scheduled_end FROM trips WHERE driver_id = ?
      AND status IN ('programado','asignado','confirmado','inspeccion_aprobada','bloqueado') AND scheduled_end >= ? ORDER BY scheduled_start`, d.id, now);
    return { ...d, status: onRoad ? 'en_viaje' : reservations.length ? 'reservado' : 'disponible', current_trip: onRoad || null, reservations };
  });
}

/**
 * Comprueba conflictos de un recurso en una ventana horaria.
 * Las restricciones técnicas (inmovilización / taller) no tienen excepción posible.
 */
function checkVehicleUsable(db, vehicleId, kind) {
  const v = db.get('SELECT * FROM vehicles WHERE id = ? AND active = 1', vehicleId);
  if (!v) throw bad(kind === 'tractor' ? 'Vehículo inexistente' : 'Remolque inexistente');
  if (v.kind !== kind) throw bad(`La unidad ${v.plate} no es de tipo ${kind}`);
  const imm = openImmobilization(db, v.id);
  if (imm) throw conflict(`La unidad ${v.plate} está inmovilizada por mantenimiento: ${imm.reason}. Solo la liberación técnica levanta esta restricción.`, { code: 'unidad_inmovilizada' });
  const shop = inWorkshop(db, v.id);
  if (shop) throw conflict(`La unidad ${v.plate} está en taller (${shop.title}).`, { code: 'unidad_en_taller' });
  return v;
}

function overlapping(db, column, resourceId, start, end, excludeTripId) {
  return db.all(`SELECT id, code, scheduled_start, scheduled_end FROM trips WHERE ${column} = ? AND id != ?
    AND status IN (${OCCUPYING.map(() => '?').join(',')})
    AND scheduled_start < ? AND (CASE WHEN status IN ('en_curso','fin_reportado','cierre_solicitado') AND scheduled_end < ? THEN ? ELSE scheduled_end END) > ?`,
  resourceId, excludeTripId || 0, ...OCCUPYING, end, nowIso(), '9999-12-31', start);
}

module.exports = {
  OCCUPYING, ON_ROAD, openImmobilization, inWorkshop, vehicleAvailability, listVehicles, getVehicle,
  createVehicle, updateVehicle, driverAvailability, checkVehicleUsable, overlapping,
};
