'use strict';
// Incidencias reportadas. No es un canal de emergencias ni está vigilado permanentemente.
const { bad, conflict, notFound } = require('../http');
const { audit, notify, notifyPermission, nowIso, req, reqReason, id: toId, clientUuid, getConfig } = require('../core');
const policy = require('../policy');

const SEVERITIES = ['baja', 'media', 'alta', 'critica'];

function serialize(db, i) {
  return {
    ...i,
    communicated_to_client: !!i.communicated_to_client,
    trip: i.trip_id ? db.get('SELECT id, code FROM trips WHERE id = ?', i.trip_id) : null,
    vehicle: i.vehicle_id ? db.get('SELECT id, plate FROM vehicles WHERE id = ?', i.vehicle_id) : null,
    reported_by: db.get('SELECT id, name FROM users WHERE id = ?', i.reported_by),
    resolved_by: i.resolved_by ? db.get('SELECT id, name FROM users WHERE id = ?', i.resolved_by) : null,
  };
}

function list(db, user, q = {}) {
  const scope = policy.incidentScopeSql(user);
  const where = [scope.where];
  const params = [...scope.params];
  if (q.status) { where.push('i.status = ?'); params.push(q.status); }
  if (q.trip_id) { where.push('i.trip_id = ?'); params.push(Number(q.trip_id)); }
  return db.all(`SELECT i.* FROM incidents i WHERE ${where.join(' AND ')} ORDER BY (i.status = 'resuelta'), i.id DESC LIMIT 300`, ...params)
    .map((i) => serialize(db, i));
}

function get(db, user, incidentId) {
  const i = db.get('SELECT * FROM incidents WHERE id = ?', Number(incidentId));
  if (!i || !policy.canViewIncident(user, i)) throw notFound('Incidencia no encontrada');
  return serialize(db, i);
}

function create(db, user, body) {
  req(body, 'type', 'description');
  const uuid = clientUuid(body.client_uuid);
  if (uuid) {
    const prev = db.get('SELECT * FROM incidents WHERE reported_by = ? AND client_uuid = ?', user.id, uuid);
    if (prev) return { ...serialize(db, prev), duplicate_submission: true };
  }
  const types = getConfig(db, 'incident_types').map((t) => t.code);
  if (!types.includes(body.type)) throw bad('Tipo de incidencia inválido');
  const severity = body.severity || 'media';
  if (!SEVERITIES.includes(severity)) throw bad('Severidad inválida');
  let trip = null;
  if (body.trip_id) {
    trip = db.get('SELECT * FROM trips WHERE id = ?', toId(body.trip_id));
    if (!trip || !(user.has('incidents.report_any') || (user.has('incidents.report_own') && trip.driver_id === user.id))) throw notFound('Viaje no encontrado');
  } else if (!user.has('incidents.report_any')) throw bad('Indique el viaje');
  const vehicleId = trip ? trip.vehicle_id : (body.vehicle_id ? toId(body.vehicle_id) : null);
  const id = db.insert('incidents', {
    trip_id: trip ? trip.id : null, vehicle_id: vehicleId, type: body.type, severity,
    description: String(body.description).trim(), reported_by: user.id, created_at: nowIso(), client_uuid: uuid,
  });
  audit(db, { user, action: 'incidencia_reportada', entity: 'incident', id, data: { type: body.type, severity, trip: trip?.code } });
  const title = `Incidencia${trip ? ' ' + trip.code : ''}: ${body.type}`;
  if (trip?.coordinator_id) notify(db, [trip.coordinator_id], { type: 'incidencia', title, body: String(body.description).slice(0, 200), entity: 'incident', id, exclude: [user.id] });
  notifyPermission(db, 'incidents.resolve', { type: 'incidencia', title, body: String(body.description).slice(0, 200), entity: 'incident', id, exclude: [user.id, trip?.coordinator_id] });
  if (policy.MECHANICAL.includes(body.type)) {
    notifyPermission(db, 'maintenance.manage', { type: 'incidencia', title: `Incidencia mecánica${vehicleId ? '' : ''}`, body: String(body.description).slice(0, 200), entity: 'incident', id, exclude: [user.id] });
  }
  return serialize(db, db.get('SELECT * FROM incidents WHERE id = ?', id));
}

function resolve(db, user, incidentId, body) {
  const i = db.get('SELECT * FROM incidents WHERE id = ?', Number(incidentId));
  if (!i) throw notFound('Incidencia no encontrada');
  if (i.status === 'resuelta') throw conflict('La incidencia ya fue resuelta');
  const resolution = reqReason(body.resolution, 'detalle de la resolución');
  db.update('incidents', i.id, {
    status: 'resuelta', resolution, resolved_by: user.id, resolved_at: nowIso(),
    communicated_to_client: body.communicated_to_client ? 1 : 0,
  });
  audit(db, { user, action: 'incidencia_resuelta', entity: 'incident', id: i.id, reason: resolution });
  notify(db, [i.reported_by], { type: 'incidencia', title: `Incidencia #${i.id} resuelta`, body: resolution, entity: 'incident', id: i.id, exclude: [user.id] });
  return serialize(db, db.get('SELECT * FROM incidents WHERE id = ?', i.id));
}

module.exports = { list, get, create, resolve, SEVERITIES };
