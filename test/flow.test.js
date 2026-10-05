'use strict';
// Circuito completo entre áreas.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, PNG, uuid } = require('./helpers');

let s;
test.before(async () => { s = await startServer(); });
test.after(() => s.close());

const ALL_OK = (checklist, overrides = {}) => Object.fromEntries(checklist.map((c) => [c.code, overrides[c.code] || 'ok']));

test('Circuito: operaciones → conductor → mantenimiento → operaciones → finanzas → gerencia', async () => {
  const o = await s.as('operaciones');
  const d = await s.as('conductor2');
  const m = await s.as('mantenimiento');
  const f = await s.as('finanzas');
  const g = await s.as('gerencia');
  const cfg = (await d.get('/api/config/public')).data;
  const tractor = s.db.get("SELECT id, odometer FROM vehicles WHERE plate='T-105'");
  const trailer = s.db.get("SELECT id FROM vehicles WHERE plate='R-204'");

  // 1. Operaciones crea y asigna.
  const t = (await o.post('/api/trips', {
    client_id: 1, origin: 'Lima', destination: 'Piura', cargo: 'Electrodomésticos', instructions: 'Entregar en muelle 2',
    scheduled_start: s.hours(8), scheduled_end: s.hours(40), vehicle_id: tractor.id, trailer_id: trailer.id, driver_id: s.ids.conductor2,
  })).data;
  assert.equal(t.status, 'asignado');
  assert.ok((await d.get('/api/notifications')).data.items.some((n) => n.entity_id === t.id && n.type === 'asignacion'));

  // 2. El conductor confirma; no puede saltarse la inspección.
  assert.equal((await d.post(`/api/trips/${t.id}/milestones/salida`, { odometer: tractor.odometer })).status, 409);
  assert.equal((await d.post(`/api/trips/${t.id}/confirm`, { client_uuid: uuid() })).data.status, 'confirmado');

  // Inspección incompleta o sin foto: rechazada.
  assert.equal((await d.post(`/api/trips/${t.id}/inspection`, { items: { frenos: 'ok' }, photo_ids: [] })).status, 400);
  const photo = (await d.post('/api/files', { data: PNG })).data;

  // 3. Falla crítica: se bloquea el inicio y se deriva a mantenimiento.
  const insp = await d.post(`/api/trips/${t.id}/inspection`, { items: ALL_OK(cfg.inspection_checklist, { frenos: 'falla' }), photo_ids: [photo.id], notes: 'Pedal esponjoso', client_uuid: uuid() });
  assert.equal(insp.status, 200, JSON.stringify(insp.data));
  assert.equal(insp.data.result, 'falla_critica');
  assert.equal(insp.data.status, 'bloqueado');
  assert.equal((await d.post(`/api/trips/${t.id}/milestones/salida`, { odometer: tractor.odometer })).status, 409);
  const mdash = (await m.get('/api/dashboard/maintenance')).data;
  assert.ok(mdash.immobilized.some((v) => v.id === tractor.id));
  const wo = mdash.pending_evaluation.find((w) => w.vehicle.id === tractor.id);
  assert.ok(wo, 'orden de evaluación creada');
  assert.ok((await m.get('/api/notifications')).data.items.some((n) => n.type === 'falla_critica'));
  // Mantenimiento ve la inspección y la foto; un conductor ajeno no.
  assert.equal((await m.get(`/api/files/${photo.id}`)).status, 200);
  assert.equal((await (await s.as('conductor')).get(`/api/files/${photo.id}`)).status, 404);
  // Nadie puede asignar la unidad inmovilizada a otro viaje.
  const other = (await o.post('/api/trips', { origin: 'X', destination: 'Y', scheduled_start: s.hours(200), scheduled_end: s.hours(210) })).data;
  assert.equal((await o.post(`/api/trips/${other.id}/assign`, { vehicle_id: tractor.id, driver_id: s.ids.conductor })).status, 409);

  // 4. Mantenimiento evalúa, repara y libera técnicamente.
  assert.equal((await m.post(`/api/vehicles/${tractor.id}/release`, { notes: '' })).status, 400, 'la liberación exige detalle');
  assert.equal((await m.post(`/api/vehicles/${tractor.id}/release`, { notes: 'Revisado' })).status, 409, 'evaluación pendiente');
  await m.post(`/api/work-orders/${wo.id}/enter`, {});
  assert.equal((await m.post(`/api/vehicles/${tractor.id}/release`, { notes: 'Frenos purgados' })).status, 409, 'primero sale de taller');
  await m.patch(`/api/work-orders/${wo.id}`, { diagnosis: 'Aire en el circuito', works: 'Purga de frenos', labor_cost: 120 });
  assert.equal((await m.post(`/api/work-orders/${wo.id}/exit`, {})).status, 200);
  const rel = await m.post(`/api/vehicles/${tractor.id}/release`, { notes: 'Frenos purgados; prueba en ruta OK' });
  assert.equal(rel.status, 200);
  // La liberación no cambia la asignación ni el estado del viaje.
  const afterRel = (await d.get(`/api/trips/${t.id}`)).data;
  assert.equal(afterRel.status, 'bloqueado');
  assert.equal(afterRel.vehicle.id, tractor.id);

  // 5. El conductor repite la inspección y registra avances, gastos e incidencias.
  const photo2 = (await d.post('/api/files', { data: PNG })).data;
  assert.equal((await d.post(`/api/trips/${t.id}/inspection`, { items: ALL_OK(cfg.inspection_checklist), photo_ids: [photo2.id] })).data.status, 'inspeccion_aprobada');
  assert.equal((await d.post(`/api/trips/${t.id}/milestones/salida`, { odometer: tractor.odometer - 10 })).status, 400, 'km menor al registrado');
  assert.equal((await d.post(`/api/trips/${t.id}/milestones/llegada_carga`, {})).status, 409, 'orden de hitos');
  assert.equal((await d.post(`/api/trips/${t.id}/milestones/salida`, { odometer: tractor.odometer + 5 })).data.status, 'en_curso');
  for (const h of ['llegada_carga', 'inicio_traslado', 'llegada_destino']) {
    assert.equal((await d.post(`/api/trips/${t.id}/milestones/${h}`, { client_uuid: uuid() })).status, 200, h);
  }
  const receipt = (await d.post('/api/files', { data: PNG })).data;
  const fuel = await d.post('/api/expenses', { trip_id: t.id, category: 'combustible', amount: 450, liters: 110, supplier: 'Grifo Piura', receipt_number: 'F9-1', receipt_file_id: receipt.id });
  assert.equal(fuel.data.extraordinary, false);
  // 6. Gasto extraordinario según umbral configurable.
  const big = await d.post('/api/expenses', { trip_id: t.id, category: 'hospedaje', amount: 520, description: 'Hospedaje por cierre de vía', supplier: 'Hostal', receipt_number: 'H-7' });
  assert.equal(big.data.extraordinary, true);
  assert.equal(big.data.approval_status, 'pendiente');
  assert.equal((await d.post(`/api/approvals/${big.data.approval.id ?? 0}/decide`, { decision: 'aprobada' })).status, 403);
  const inc = await d.post('/api/incidents', { trip_id: t.id, type: 'retraso', severity: 'media', description: 'Cierre de vía por derrumbe' });
  assert.equal(inc.status, 200);

  // 7. Fin de servicio y solicitud de cierre.
  assert.equal((await d.post(`/api/trips/${t.id}/milestones/fin_servicio`, { odometer: tractor.odometer })).status, 400, 'km final < inicial');
  const end = await d.post(`/api/trips/${t.id}/milestones/fin_servicio`, { odometer: tractor.odometer + 1010 });
  assert.equal(end.data.status, 'fin_reportado');
  assert.equal(end.data.status_label, 'Conductor reportó fin del servicio');
  assert.equal((await d.post(`/api/trips/${t.id}/request-close`, {})).data.status, 'cierre_solicitado');
  // El conductor no cierra financieramente ni valida el cierre.
  assert.equal((await d.post(`/api/trips/${t.id}/validate-close`, {})).status, 403);
  assert.equal((await d.post(`/api/trips/${t.id}/financial-close`, {})).status, 403);

  // 8. Operaciones valida el cierre: los recursos quedan libres aunque falte el cierre financiero.
  const closed = await o.post(`/api/trips/${t.id}/validate-close`, { notes: 'Conforme' });
  assert.equal(closed.data.status, 'cerrado_operativo');
  assert.equal(closed.data.status_label, 'Operaciones validó cierre');
  const v = (await o.get('/api/vehicles')).data.find((x) => x.id === tractor.id);
  assert.equal(v.availability.status, 'disponible');
  assert.equal(v.odometer, tractor.odometer + 1010);
  const overlap = (await o.post('/api/trips', { origin: 'Piura', destination: 'Lima', scheduled_start: s.hours(9), scheduled_end: s.hours(30) })).data;
  const reuse = await o.post(`/api/trips/${overlap.id}/assign`, { vehicle_id: tractor.id, trailer_id: trailer.id, driver_id: s.ids.conductor2 });
  assert.equal(reuse.status, 200, 'el camión no queda ocupado por el cierre financiero pendiente');

  // 9. Finanzas revisa ingresos y costos y cierra.
  assert.equal((await f.post(`/api/trips/${t.id}/financial-close`, {})).status, 409, 'falta ingreso');
  await f.post(`/api/trips/${t.id}/revenue`, { revenue_agreed: 5200, budget_cost: 2400 });
  assert.equal((await f.post(`/api/trips/${t.id}/financial-close`, {})).status, 409, 'gastos pendientes');
  assert.equal((await f.post(`/api/expenses/${big.data.id}/validate`, { decision: 'validado' })).status, 409, 'aprobación pendiente');
  assert.equal((await g.post(`/api/approvals/${big.data.approval.id}/decide`, { decision: 'aprobada' })).status, 200);
  assert.equal((await f.post(`/api/expenses/${big.data.id}/validate`, { decision: 'validado' })).status, 200);
  assert.equal((await f.post(`/api/expenses/${fuel.data.id}/validate`, { decision: 'validado' })).status, 200);
  const fc = await f.post(`/api/trips/${t.id}/financial-close`, {});
  assert.equal(fc.status, 200);
  assert.equal(fc.data.fin_cost, 970);
  assert.equal(fc.data.fin_margin, 5200 - 970);

  // 10. Gerencia consulta resultados.
  const dash = (await g.get(`/api/dashboard/executive?to=${encodeURIComponent(s.hours(100))}`)).data;
  assert.ok(dash.profitability.by_trip.some((x) => x.id === t.id && x.margin === 4230));
  const hist = (await g.get(`/api/audit?entity=trip&entity_id=${t.id}`)).data.map((a) => a.action);
  for (const a of ['viaje_creado', 'viaje_asignado', 'inspeccion_falla_critica', 'cierre_operativo_validado', 'cierre_financiero']) assert.ok(hist.includes(a), a);
});

test('Reenvíos sin conexión no generan duplicados', async () => {
  const d = await s.as('conductor2');
  const trip = s.db.get("SELECT id FROM trips WHERE code LIKE '%-0002'");
  const key = uuid();
  const body = { trip_id: trip.id, category: 'peaje', amount: 12.5, supplier: 'Peaje Sur', receipt_number: 'PX-1', client_uuid: key };
  const a = await d.post('/api/expenses', body);
  const b = await d.post('/api/expenses', body);
  assert.equal(a.data.id, b.data.id);
  assert.equal(b.data.duplicate_submission, true);
  assert.equal(s.db.get('SELECT COUNT(*) c FROM expenses WHERE client_uuid = ?', key).c, 1);
  const ikey = uuid();
  const i1 = await d.post('/api/incidents', { trip_id: trip.id, type: 'retraso', description: 'Tráfico', client_uuid: ikey });
  const i2 = await d.post('/api/incidents', { trip_id: trip.id, type: 'retraso', description: 'Tráfico', client_uuid: ikey });
  assert.equal(i1.data.id, i2.data.id);
  const mkey = uuid();
  const m1 = await d.post(`/api/trips/${trip.id}/milestones/llegada_destino`, { client_uuid: mkey });
  const m2 = await d.post(`/api/trips/${trip.id}/milestones/llegada_destino`, { client_uuid: mkey });
  assert.equal(m1.status, 200);
  assert.equal(m2.status, 200);
  assert.equal(m2.data.duplicate_submission, true);
  assert.equal(s.db.get("SELECT COUNT(*) c FROM trip_events WHERE trip_id = ? AND type = 'llegada_destino'", trip.id).c, 1);
  // Un comprobante con los mismos datos enviado como registro nuevo se marca como posible duplicado.
  const again = await d.post('/api/expenses', { ...body, client_uuid: uuid() });
  assert.equal(again.status, 200);
  assert.equal(s.db.get('SELECT possible_duplicate_of FROM expenses WHERE id = ?', again.data.id).possible_duplicate_of, a.data.id);
});

test('Borradores: se guardan por usuario y solo en viajes propios', async () => {
  const d = await s.as('conductor');
  const own = s.db.get('SELECT id FROM trips WHERE driver_id = ? LIMIT 1', s.ids.conductor);
  const foreign = s.db.get('SELECT id FROM trips WHERE driver_id = ? LIMIT 1', s.ids.conductor2);
  assert.equal((await d.put('/api/drafts', { kind: 'gasto', trip_id: own.id, payload: { amount: 10 } })).status, 200);
  assert.equal((await d.put('/api/drafts', { kind: 'gasto', trip_id: foreign.id, payload: { amount: 10 } })).status, 404);
  const list = (await d.get('/api/drafts')).data;
  assert.equal(list.length, 1);
  const d2 = await s.as('conductor2');
  assert.equal((await d2.get('/api/drafts')).data.length, 0);
});

test('Conflictos de recursos y reasignación', async () => {
  const o = await s.as('operaciones');
  const t1 = s.db.get("SELECT * FROM trips WHERE code LIKE '%-0001'");
  // Mismo conductor en horario superpuesto: requiere excepción autorizada.
  const n = (await o.post('/api/trips', { origin: 'A', destination: 'B', scheduled_start: t1.scheduled_start, scheduled_end: t1.scheduled_end })).data;
  const free = s.db.get("SELECT id FROM vehicles WHERE plate = 'T-102'");
  const r = await o.post(`/api/trips/${n.id}/assign`, { vehicle_id: free.id, driver_id: t1.driver_id });
  assert.equal(r.status, 409);
  assert.equal(r.data.code, 'conductor_ocupado');
  // Mismo vehículo superpuesto: no admite excepción.
  const r2 = await o.post(`/api/trips/${n.id}/assign`, { vehicle_id: t1.vehicle_id, driver_id: s.ids.conductor2 });
  assert.equal(r2.status, 409);
  // Un remolque no puede usarse como tractor.
  const trailer = s.db.get("SELECT id FROM vehicles WHERE plate = 'R-203'");
  assert.equal((await o.post(`/api/trips/${n.id}/assign`, { vehicle_id: trailer.id, driver_id: s.ids.conductor2 })).status, 400);
});
