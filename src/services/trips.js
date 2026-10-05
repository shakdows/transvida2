'use strict';
// Ciclo de vida del viaje: operaciones → conductor → mantenimiento → operaciones → finanzas.
const { bad, conflict, forbidden } = require('../http');
const {
  audit, notify, notifyPermission, nowIso, req, reqReason, num, date, id: toId, clientUuid, getConfig, round2,
} = require('../core');
const policy = require('../policy');
const fleet = require('./fleet');
const approvals = require('./approvals');

const ASSIGNABLE = ['programado', 'asignado', 'confirmado', 'inspeccion_aprobada', 'bloqueado'];
const MILESTONES = ['salida', 'llegada_carga', 'inicio_traslado', 'llegada_destino', 'fin_servicio'];
const MILESTONE_LABELS = {
  salida: 'Salida', llegada_carga: 'Llegada al punto de carga', inicio_traslado: 'Inicio de traslado',
  llegada_destino: 'Llegada al destino', fin_servicio: 'Fin de servicio',
};

function view(db, user, trip, detail = true) {
  return policy.serializeTrip(db, user, db.get('SELECT * FROM trips WHERE id = ?', trip.id || trip), { detail });
}

function list(db, user, q = {}) {
  const scope = policy.tripScopeSql(user);
  const where = [scope.where];
  const params = [...scope.params];
  if (q.status) {
    const st = String(q.status).split(',');
    where.push(`t.status IN (${st.map(() => '?').join(',')})`); params.push(...st);
  }
  if (q.active === '1') where.push("t.status NOT IN ('cerrado_operativo','cerrado_financiero','cancelado')");
  if (q.from) { where.push('t.scheduled_end >= ?'); params.push(q.from); }
  if (q.to) { where.push('t.scheduled_start <= ?'); params.push(q.to); }
  if (q.vehicle_id) { where.push('(t.vehicle_id = ? OR t.trailer_id = ?)'); params.push(Number(q.vehicle_id), Number(q.vehicle_id)); }
  return db.all(`SELECT t.* FROM trips t WHERE ${where.join(' AND ')} ORDER BY t.scheduled_start DESC LIMIT 500`, ...params)
    .map((t) => policy.serializeTrip(db, user, t));
}

function nextCode(db) {
  const year = new Date().getFullYear();
  const n = db.get("SELECT COUNT(*) AS c FROM trips WHERE code LIKE ?", `TV-${year}-%`).c + 1;
  return `TV-${year}-${String(n).padStart(4, '0')}`;
}

function create(db, user, body) {
  req(body, 'origin', 'destination', 'scheduled_start', 'scheduled_end');
  const start = date(body.scheduled_start, 'scheduled_start');
  const end = date(body.scheduled_end, 'scheduled_end');
  if (end <= start) throw bad('La hora de fin debe ser posterior al inicio');
  if ((body.revenue_agreed != null || body.budget_cost != null) && !user.has('trips.set_revenue')) {
    throw forbidden('No tiene permiso para registrar ingresos o presupuesto del viaje');
  }
  const clientId = body.client_id ? toId(body.client_id) : null;
  if (body.client_id && !db.get('SELECT id FROM clients WHERE id = ?', clientId)) throw bad('Cliente inexistente');
  return db.tx(() => {
    const now = nowIso();
    const id = db.insert('trips', {
      code: nextCode(db), client_id: clientId, origin: body.origin, destination: body.destination,
      cargo: body.cargo || null, instructions: body.instructions || null,
      scheduled_start: start, scheduled_end: end, status: 'programado', coordinator_id: user.id,
      revenue_agreed: body.revenue_agreed != null ? num(body.revenue_agreed, 'revenue_agreed', { min: 0 }) : null,
      budget_cost: body.budget_cost != null ? num(body.budget_cost, 'budget_cost', { min: 0 }) : null,
      created_by: user.id, created_at: now, updated_at: now,
    });
    audit(db, { user, action: 'viaje_creado', entity: 'trip', id, data: { origin: body.origin, destination: body.destination, start, end } });
    if (body.vehicle_id || body.driver_id) assign(db, user, id, body);
    return view(db, user, { id });
  });
}

function assign(db, user, tripId, body) {
  return db.tx(() => {
    const trip = db.get('SELECT * FROM trips WHERE id = ?', Number(tripId));
    if (!trip) throw bad('Viaje inexistente');
    if (!ASSIGNABLE.includes(trip.status)) throw conflict('El viaje ya no admite cambios de asignación');
    const vehicleId = body.vehicle_id !== undefined ? toId(body.vehicle_id) : trip.vehicle_id;
    const trailerId = body.trailer_id !== undefined ? toId(body.trailer_id) : trip.trailer_id;
    const driverId = body.driver_id !== undefined ? toId(body.driver_id) : trip.driver_id;
    if (!vehicleId || !driverId) throw bad('Debe asignar vehículo y conductor');

    // Restricción técnica crítica: ninguna aprobación la levanta.
    fleet.checkVehicleUsable(db, vehicleId, 'tractor');
    if (trailerId) fleet.checkVehicleUsable(db, trailerId, 'remolque');

    const driver = db.get(`SELECT u.id, u.name FROM users u JOIN user_roles r ON r.user_id = u.id AND r.role = 'conductor' WHERE u.id = ? AND u.active = 1`, driverId);
    if (!driver) throw bad('El conductor no existe o no está activo');

    const clashes = [];
    for (const [col, rid, label] of [['vehicle_id', vehicleId, 'vehículo'], ['trailer_id', trailerId, 'remolque']]) {
      if (!rid) continue;
      const o = fleet.overlapping(db, col, rid, trip.scheduled_start, trip.scheduled_end, trip.id);
      if (o.length) clashes.push(`El ${label} ya está reservado en ${o.map((x) => x.code).join(', ')}`);
    }
    if (clashes.length) throw conflict(clashes.join('. '), { code: 'recurso_ocupado' });
    const driverClash = fleet.overlapping(db, 'driver_id', driverId, trip.scheduled_start, trip.scheduled_end, trip.id);
    if (driverClash.length && !approvals.approvedException(db, trip.id, 'solapamiento_conductor')) {
      throw conflict(`El conductor tiene servicios superpuestos (${driverClash.map((x) => x.code).join(', ')}). Requiere una excepción autorizada.`, { code: 'conductor_ocupado' });
    }

    const changed = vehicleId !== trip.vehicle_id || trailerId !== trip.trailer_id || driverId !== trip.driver_id;
    if (!changed) return view(db, user, trip);
    const changes = { vehicle_id: vehicleId, trailer_id: trailerId || null, driver_id: driverId, updated_at: nowIso() };
    // Un cambio de recursos exige nueva confirmación del conductor (y nueva inspección).
    changes.status = 'asignado';
    changes.confirmed_at = null;
    db.update('trips', trip.id, changes);
    audit(db, { user, action: 'viaje_asignado', entity: 'trip', id: trip.id, reason: body.reason,
      data: { before: { vehicle_id: trip.vehicle_id, trailer_id: trip.trailer_id, driver_id: trip.driver_id, status: trip.status }, after: changes } });
    notify(db, [driverId], { type: 'asignacion', title: `Nuevo viaje asignado ${trip.code}`, body: `${trip.origin} → ${trip.destination}. Confirme la recepción.`, entity: 'trip', id: trip.id });
    if (trip.driver_id && trip.driver_id !== driverId) {
      notify(db, [trip.driver_id], { type: 'asignacion', title: `Viaje ${trip.code} reasignado`, body: 'Este viaje ya no está a su cargo.', entity: 'trip', id: trip.id });
    }
    return view(db, user, trip);
  });
}

function reschedule(db, user, tripId, body) {
  return db.tx(() => {
    const trip = db.get('SELECT * FROM trips WHERE id = ?', Number(tripId));
    if (!trip) throw bad('Viaje inexistente');
    if (!ASSIGNABLE.includes(trip.status)) throw conflict('Solo se reprograman servicios que no han iniciado');
    const reason = reqReason(body.reason);
    const start = date(body.scheduled_start, 'scheduled_start');
    const end = date(body.scheduled_end, 'scheduled_end');
    if (end <= start) throw bad('La hora de fin debe ser posterior al inicio');
    const minHours = getConfig(db, 'reprogram_min_hours');
    const limit = new Date(Date.now() + minHours * 3600e3).toISOString();
    if ((trip.scheduled_start < limit || start < limit) && !approvals.approvedException(db, trip.id, 'reprogramacion_tardia')) {
      throw conflict(`Reprogramar con menos de ${minHours} h de anticipación requiere una excepción autorizada.`, { code: 'requiere_excepcion' });
    }
    for (const [col, rid, label] of [['vehicle_id', trip.vehicle_id, 'vehículo'], ['trailer_id', trip.trailer_id, 'remolque']]) {
      if (rid && fleet.overlapping(db, col, rid, start, end, trip.id).length) throw conflict(`El ${label} asignado no está disponible en el nuevo horario`);
    }
    if (trip.driver_id && fleet.overlapping(db, 'driver_id', trip.driver_id, start, end, trip.id).length
      && !approvals.approvedException(db, trip.id, 'solapamiento_conductor')) throw conflict('El conductor no está disponible en el nuevo horario');
    db.update('trips', trip.id, { scheduled_start: start, scheduled_end: end, updated_at: nowIso() });
    audit(db, { user, action: 'viaje_reprogramado', entity: 'trip', id: trip.id, reason,
      data: { before: { start: trip.scheduled_start, end: trip.scheduled_end }, after: { start, end } } });
    if (trip.driver_id) notify(db, [trip.driver_id], { type: 'reprogramacion', title: `Viaje ${trip.code} reprogramado`, body: `Nuevo horario: ${start} → ${end}. Motivo: ${reason}`, entity: 'trip', id: trip.id });
    return view(db, user, trip);
  });
}

function cancel(db, user, tripId, body) {
  const trip = db.get('SELECT * FROM trips WHERE id = ?', Number(tripId));
  if (!trip) throw bad('Viaje inexistente');
  if (!ASSIGNABLE.includes(trip.status)) throw conflict('Solo se cancelan servicios que no han iniciado');
  const reason = reqReason(body.reason);
  db.update('trips', trip.id, { status: 'cancelado', cancel_reason: reason, updated_at: nowIso() });
  audit(db, { user, action: 'viaje_cancelado', entity: 'trip', id: trip.id, reason });
  if (trip.driver_id) notify(db, [trip.driver_id], { type: 'cancelacion', title: `Viaje ${trip.code} cancelado`, body: reason, entity: 'trip', id: trip.id });
  return view(db, user, trip);
}

// ---------- Conductor ----------

function addEvent(db, user, trip, type, { odometer = null, notes = null, client_uuid = null } = {}) {
  return db.insert('trip_events', { trip_id: trip.id, type, at: nowIso(), user_id: user.id, odometer, notes, client_uuid });
}

function existingSubmission(db, table, userCol, user, uuid) {
  return uuid ? db.get(`SELECT * FROM ${table} WHERE ${userCol} = ? AND client_uuid = ?`, user.id, uuid) : null;
}

function confirm(db, user, tripId, body = {}) {
  const trip = policy.loadOwnTrip(db, user, tripId);
  const uuid = clientUuid(body.client_uuid);
  if (existingSubmission(db, 'trip_events', 'user_id', user, uuid)) return { ...view(db, user, trip), duplicate_submission: true };
  if (trip.status !== 'asignado') throw conflict('La asignación ya fue confirmada o no está pendiente');
  db.tx(() => {
    db.update('trips', trip.id, { status: 'confirmado', confirmed_at: nowIso(), updated_at: nowIso() });
    addEvent(db, user, trip, 'confirmacion', { client_uuid: uuid });
    audit(db, { user, action: 'asignacion_confirmada', entity: 'trip', id: trip.id });
  });
  if (trip.coordinator_id) notify(db, [trip.coordinator_id], { type: 'viaje', title: `${trip.code}: asignación confirmada`, body: `${user.name} confirmó la asignación.`, entity: 'trip', id: trip.id });
  return view(db, user, trip);
}

function inspection(db, user, tripId, body) {
  const trip = policy.loadOwnTrip(db, user, tripId);
  const uuid = clientUuid(body.client_uuid);
  const dup = existingSubmission(db, 'inspections', 'driver_id', user, uuid);
  if (dup) return { ...view(db, user, trip), inspection_id: dup.id, result: dup.result, duplicate_submission: true };
  if (!['confirmado', 'bloqueado'].includes(trip.status)) {
    throw conflict(trip.status === 'asignado' ? 'Primero confirme la asignación' : 'La inspección previa ya no corresponde en este estado');
  }
  const imm = fleet.openImmobilization(db, trip.vehicle_id);
  if (imm) throw conflict('La unidad sigue inmovilizada. Espere la liberación técnica de mantenimiento.', { code: 'unidad_inmovilizada' });

  const checklist = getConfig(db, 'inspection_checklist');
  const items = body.items || {};
  const missing = checklist.filter((c) => !['ok', 'falla', 'na'].includes(items[c.code]));
  if (missing.length) throw bad(`Complete todos los puntos del checklist: ${missing.map((m) => m.label).join(', ')}`);
  const photos = Array.isArray(body.photo_ids) ? body.photo_ids.map(Number) : [];
  const minPhotos = getConfig(db, 'inspection_min_photos');
  if (photos.length < minPhotos) throw bad(`Adjunte al menos ${minPhotos} fotografía(s)`);
  for (const pid of photos) {
    const f = db.get('SELECT owner_id, entity_type FROM files WHERE id = ?', pid);
    if (!f || f.owner_id !== user.id || f.entity_type) throw bad('Fotografía inválida');
  }
  const fails = checklist.filter((c) => items[c.code] === 'falla');
  const critical = fails.filter((c) => c.critical);
  const result = critical.length ? 'falla_critica' : fails.length ? 'observaciones' : 'aprobada';
  const odometer = body.odometer != null && body.odometer !== '' ? Math.round(num(body.odometer, 'odometer', { min: 0 })) : null;
  const now = nowIso();

  const out = db.tx(() => {
    const insId = db.insert('inspections', {
      trip_id: trip.id, vehicle_id: trip.vehicle_id, driver_id: user.id, items: JSON.stringify(items),
      photo_ids: JSON.stringify(photos), odometer, result, notes: body.notes || null, created_at: now, client_uuid: uuid,
    });
    for (const pid of photos) db.run("UPDATE files SET entity_type = 'inspection', entity_id = ? WHERE id = ?", insId, pid);
    const plate = db.get('SELECT plate FROM vehicles WHERE id = ?', trip.vehicle_id).plate;
    if (critical.length) {
      // Falla crítica: se bloquea el inicio y se deriva a mantenimiento.
      const desc = `Falla crítica en inspección previa (${critical.map((c) => c.label).join(', ')}). ${body.notes || ''}`.trim();
      const incId = db.insert('incidents', {
        trip_id: trip.id, vehicle_id: trip.vehicle_id, type: 'averia', severity: 'critica', description: desc,
        reported_by: user.id, created_at: now,
      });
      db.insert('immobilizations', { vehicle_id: trip.vehicle_id, reason: desc, source: 'inspeccion', created_by: user.id, created_at: now });
      db.insert('work_orders', {
        vehicle_id: trip.vehicle_id, kind: 'correctivo', status: 'pendiente_evaluacion', title: `Evaluar falla crítica — ${trip.code}`,
        diagnosis: null, incident_id: incId, created_by: user.id, created_at: now, updated_at: now,
      });
      db.update('trips', trip.id, { status: 'bloqueado', updated_at: now });
      audit(db, { user, action: 'inspeccion_falla_critica', entity: 'trip', id: trip.id, data: { inspection: insId, items: critical.map((c) => c.code) } });
      notifyPermission(db, 'maintenance.manage', { type: 'falla_critica', title: `Falla crítica: unidad ${plate}`, body: desc, entity: 'vehicle', id: trip.vehicle_id });
      notify(db, [trip.coordinator_id], { type: 'falla_critica', title: `${trip.code} bloqueado`, body: `Inicio bloqueado por falla crítica en ${plate}. Derivado a mantenimiento.`, entity: 'trip', id: trip.id });
    } else {
      if (fails.length) {
        db.insert('incidents', {
          trip_id: trip.id, vehicle_id: trip.vehicle_id, type: 'averia', severity: 'baja',
          description: `Observaciones en inspección previa: ${fails.map((c) => c.label).join(', ')}. ${body.notes || ''}`.trim(),
          reported_by: user.id, created_at: now,
        });
      }
      db.update('trips', trip.id, { status: 'inspeccion_aprobada', updated_at: now });
      audit(db, { user, action: 'inspeccion_registrada', entity: 'trip', id: trip.id, data: { inspection: insId, result } });
    }
    return insId;
  });
  return { ...view(db, user, trip), inspection_id: out, result };
}

function milestone(db, user, tripId, type, body = {}) {
  const trip = policy.loadOwnTrip(db, user, tripId);
  if (!MILESTONES.includes(type)) throw bad('Hito inválido');
  const uuid = clientUuid(body.client_uuid);
  if (existingSubmission(db, 'trip_events', 'user_id', user, uuid)) return { ...view(db, user, trip), duplicate_submission: true };

  const done = db.all(`SELECT type FROM trip_events WHERE trip_id = ? AND type IN (${MILESTONES.map(() => '?').join(',')})`, trip.id, ...MILESTONES).map((e) => e.type);
  const expected = MILESTONES[done.length];
  if (type !== expected) throw conflict(expected ? `El siguiente paso es: ${MILESTONE_LABELS[expected]}` : 'El servicio ya fue finalizado');
  const changes = { updated_at: nowIso() };
  let odometer = null;
  if (type === 'salida') {
    if (trip.status !== 'inspeccion_aprobada') throw conflict('Debe completar una inspección previa aprobada antes de salir');
    if (fleet.openImmobilization(db, trip.vehicle_id)) throw conflict('La unidad está inmovilizada', { code: 'unidad_inmovilizada' });
    odometer = Math.round(num(body.odometer, 'odometer', { min: 0 }));
    const v = db.get('SELECT odometer FROM vehicles WHERE id = ?', trip.vehicle_id);
    if (odometer < v.odometer) throw bad(`El kilometraje inicial no puede ser menor al último registrado (${v.odometer})`);
    Object.assign(changes, { status: 'en_curso', started_at: nowIso(), km_start: odometer });
  } else {
    if (trip.status !== 'en_curso') throw conflict('El viaje no está en curso');
    if (type === 'fin_servicio') {
      odometer = Math.round(num(body.odometer, 'odometer', { min: 0 }));
      if (odometer < trip.km_start) throw bad('El kilometraje final no puede ser menor al inicial');
      Object.assign(changes, { status: 'fin_reportado', driver_end_reported_at: nowIso(), km_end: odometer });
    } else if (body.odometer) odometer = Math.round(num(body.odometer, 'odometer', { min: 0 }));
  }
  db.tx(() => {
    db.update('trips', trip.id, changes);
    addEvent(db, user, trip, type, { odometer, notes: body.notes || null, client_uuid: uuid });
    audit(db, { user, action: `hito_${type}`, entity: 'trip', id: trip.id, data: { odometer } });
  });
  if (['salida', 'fin_servicio'].includes(type) && trip.coordinator_id) {
    notify(db, [trip.coordinator_id], { type: 'viaje', title: `${trip.code}: ${MILESTONE_LABELS[type]}`, body: `Reportado por ${user.name}.`, entity: 'trip', id: trip.id });
  }
  return view(db, user, trip);
}

function requestClose(db, user, tripId, body = {}) {
  const trip = policy.loadOwnTrip(db, user, tripId);
  const uuid = clientUuid(body.client_uuid);
  if (existingSubmission(db, 'trip_events', 'user_id', user, uuid)) return { ...view(db, user, trip), duplicate_submission: true };
  if (trip.status !== 'fin_reportado') throw conflict('Primero reporte el fin del servicio');
  db.tx(() => {
    db.update('trips', trip.id, { status: 'cierre_solicitado', close_requested_at: nowIso(), updated_at: nowIso() });
    addEvent(db, user, trip, 'solicitud_cierre', { notes: body.notes || null, client_uuid: uuid });
    audit(db, { user, action: 'cierre_operativo_solicitado', entity: 'trip', id: trip.id });
  });
  notify(db, [trip.coordinator_id], { type: 'cierre', title: `${trip.code}: cierre operativo solicitado`, body: `${user.name} solicitó el cierre operativo.`, entity: 'trip', id: trip.id });
  notifyPermission(db, 'trips.validate_close', { type: 'cierre', title: `${trip.code}: cierre por validar`, body: 'El conductor solicitó el cierre operativo.', entity: 'trip', id: trip.id, exclude: [trip.coordinator_id] });
  return view(db, user, trip);
}

// ---------- Operaciones ----------

function validateClose(db, user, tripId, body = {}) {
  const trip = db.get('SELECT * FROM trips WHERE id = ?', Number(tripId));
  if (!trip) throw bad('Viaje inexistente');
  if (trip.driver_id === user.id) throw forbidden('No puede validar el cierre de un viaje que usted condujo');
  if (!['fin_reportado', 'cierre_solicitado'].includes(trip.status)) throw conflict('El conductor aún no reportó el fin del servicio');
  db.tx(() => {
    // La finalización operativa libera vehículo, remolque y conductor (estado no ocupante).
    db.update('trips', trip.id, { status: 'cerrado_operativo', ops_closed_at: nowIso(), ops_closed_by: user.id, updated_at: nowIso() });
    if (trip.km_end) db.run('UPDATE vehicles SET odometer = MAX(odometer, ?) WHERE id = ?', trip.km_end, trip.vehicle_id);
    db.insert('trip_events', { trip_id: trip.id, type: 'cierre_operativo', at: nowIso(), user_id: user.id, notes: body.notes || null });
    audit(db, { user, action: 'cierre_operativo_validado', entity: 'trip', id: trip.id, reason: body.notes });
  });
  notify(db, [trip.driver_id], { type: 'cierre', title: `${trip.code}: cierre operativo validado`, body: 'Operaciones validó el cierre.', entity: 'trip', id: trip.id });
  notifyPermission(db, 'trips.financial_close', { type: 'cierre', title: `${trip.code}: pendiente de cierre financiero`, body: 'El viaje tiene cierre operativo validado.', entity: 'trip', id: trip.id });
  return view(db, user, trip);
}

function rejectClose(db, user, tripId, body = {}) {
  const trip = db.get('SELECT * FROM trips WHERE id = ?', Number(tripId));
  if (!trip) throw bad('Viaje inexistente');
  if (trip.status !== 'cierre_solicitado') throw conflict('No hay una solicitud de cierre pendiente');
  const reason = reqReason(body.reason);
  db.tx(() => {
    db.update('trips', trip.id, { status: 'fin_reportado', updated_at: nowIso() });
    db.insert('trip_events', { trip_id: trip.id, type: 'cierre_observado', at: nowIso(), user_id: user.id, notes: reason });
    audit(db, { user, action: 'cierre_operativo_observado', entity: 'trip', id: trip.id, reason });
  });
  notify(db, [trip.driver_id], { type: 'cierre', title: `${trip.code}: cierre observado`, body: reason, entity: 'trip', id: trip.id });
  return view(db, user, trip);
}

// Corrección trazable: no se modifica el evento original.
function correctEvent(db, user, tripId, body) {
  const trip = db.get('SELECT * FROM trips WHERE id = ?', Number(tripId));
  if (!trip) throw bad('Viaje inexistente');
  if (['cerrado_operativo', 'cerrado_financiero'].includes(trip.status)) throw conflict('El viaje ya tiene cierre operativo');
  const ev = db.get('SELECT * FROM trip_events WHERE id = ? AND trip_id = ?', toId(body.event_id), trip.id);
  if (!ev) throw bad('Evento inexistente');
  const reason = reqReason(body.reason);
  db.insert('trip_events', {
    trip_id: trip.id, type: 'correccion', at: nowIso(), user_id: user.id,
    odometer: body.odometer != null && body.odometer !== '' ? Math.round(num(body.odometer, 'odometer', { min: 0 })) : null,
    notes: JSON.stringify({ event_id: ev.id, event_type: ev.type, reason, corrected_at: body.corrected_at || null }),
  });
  audit(db, { user, action: 'evento_corregido', entity: 'trip', id: trip.id, reason, data: { event: ev } });
  return view(db, user, trip);
}

// ---------- Finanzas ----------

function setRevenue(db, user, tripId, body) {
  const trip = db.get('SELECT * FROM trips WHERE id = ?', Number(tripId));
  if (!trip) throw bad('Viaje inexistente');
  if (trip.status === 'cerrado_financiero') throw conflict('Viaje con cierre financiero: registre un ajuste');
  const changes = { updated_at: nowIso() };
  if (body.revenue_agreed !== undefined) changes.revenue_agreed = num(body.revenue_agreed, 'revenue_agreed', { min: 0 });
  if (body.budget_cost !== undefined) changes.budget_cost = num(body.budget_cost, 'budget_cost', { min: 0 });
  db.update('trips', trip.id, changes);
  audit(db, { user, action: 'ingreso_presupuesto_registrado', entity: 'trip', id: trip.id, reason: body.reason,
    data: { before: { revenue_agreed: trip.revenue_agreed, budget_cost: trip.budget_cost }, after: changes } });
  return view(db, user, trip);
}

function addCost(db, user, tripId, body) {
  const trip = db.get('SELECT * FROM trips WHERE id = ?', Number(tripId));
  if (!trip) throw bad('Viaje inexistente');
  req(body, 'concept', 'amount');
  const amount = round2(num(body.amount, 'amount'));
  const afterClose = trip.status === 'cerrado_financiero';
  // Los costos cerrados no se modifican: se registra un ajuste con motivo.
  const reason = afterClose ? reqReason(body.reason, 'motivo del ajuste') : body.reason || null;
  const id = db.insert('cost_entries', {
    trip_id: trip.id, kind: afterClose ? 'ajuste' : 'asignado', concept: body.concept, amount, reason,
    after_close: afterClose ? 1 : 0, created_by: user.id, created_at: nowIso(),
  });
  audit(db, { user, action: afterClose ? 'ajuste_costo' : 'costo_asignado', entity: 'trip', id: trip.id, reason, data: { cost_entry: id, concept: body.concept, amount } });
  return listCosts(db, trip.id);
}

function listCosts(db, tripId) {
  return db.all(`SELECT c.*, u.name AS created_by_name FROM cost_entries c JOIN users u ON u.id = c.created_by WHERE trip_id = ? ORDER BY c.id`, tripId);
}

function financialClose(db, user, tripId, body = {}) {
  return db.tx(() => {
    const trip = db.get('SELECT * FROM trips WHERE id = ?', Number(tripId));
    if (!trip) throw bad('Viaje inexistente');
    if (trip.status !== 'cerrado_operativo') throw conflict('El viaje requiere cierre operativo validado por operaciones');
    if (trip.revenue_agreed == null) throw conflict('Registre el ingreso acordado antes del cierre financiero');
    const pending = db.get(`SELECT COUNT(*) AS c FROM expenses WHERE trip_id = ? AND (validation_status = 'pendiente' OR approval_status = 'pendiente')`, trip.id).c;
    if (pending) throw conflict(`Hay ${pending} gasto(s) sin validar o pendientes de aprobación`);
    const c = policy.tripCosts(db, trip.id);
    const cost = round2(c.expenses_validated + c.allocated);
    const margin = round2(trip.revenue_agreed - cost);
    db.update('trips', trip.id, {
      status: 'cerrado_financiero', fin_closed_at: nowIso(), fin_closed_by: user.id,
      fin_revenue: trip.revenue_agreed, fin_cost: cost, fin_margin: margin, updated_at: nowIso(),
    });
    audit(db, { user, action: 'cierre_financiero', entity: 'trip', id: trip.id, reason: body.notes, data: { revenue: trip.revenue_agreed, cost, margin } });
    notifyPermission(db, 'reports.view', {
      type: 'cierre', title: `${trip.code}: cierre financiero`, body: 'El viaje fue cerrado financieramente.',
      sensitive: `El viaje fue cerrado financieramente. Margen: ${margin}`, entity: 'trip', id: trip.id, exclude: [user.id],
    });
    return view(db, user, trip);
  });
}

module.exports = {
  MILESTONES, MILESTONE_LABELS, list, create, assign, reschedule, cancel, confirm, inspection, milestone,
  requestClose, validateClose, rejectClose, correctEvent, setRevenue, addCost, listCosts, financialClose, view,
};
