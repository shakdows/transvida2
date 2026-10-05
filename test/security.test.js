'use strict';
// Accesos indebidos a registros ajenos y aprobación de solicitudes propias.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, PNG } = require('./helpers');

let s;
test.before(async () => { s = await startServer(); });
test.after(() => s.close());

const tripByCode = (suffix) => s.db.get('SELECT * FROM trips WHERE code LIKE ?', `%-${suffix}`);

test('Un conductor no accede a viajes ajenos modificando la URL o la solicitud', async () => {
  const d = await s.as('conductor');
  const foreign = tripByCode('0002'); // asignado a conductor2
  assert.notEqual(foreign.driver_id, s.ids.conductor);
  assert.equal((await d.get(`/api/trips/${foreign.id}`)).status, 404);
  for (const path of ['confirm', 'request-close', 'milestones/llegada_destino']) {
    assert.equal((await d.post(`/api/trips/${foreign.id}/${path}`, {})).status, 404, path);
  }
  assert.equal((await d.post(`/api/trips/${foreign.id}/inspection`, { items: {}, photo_ids: [] })).status, 404);
  // Gastos e incidencias sobre viajes ajenos.
  assert.equal((await d.post('/api/expenses', { trip_id: foreign.id, category: 'peaje', amount: 10 })).status, 404);
  assert.equal((await d.post('/api/incidents', { trip_id: foreign.id, type: 'retraso', description: 'x' })).status, 404);
  // Lectura de gastos, incidencias y archivos ajenos.
  const foreignExpense = s.db.get('SELECT id FROM expenses WHERE created_by = ?', s.ids.conductor2);
  assert.equal((await d.get(`/api/expenses/${foreignExpense.id}`)).status, 404);
  const mine = await d.get('/api/expenses');
  assert.ok(mine.data.every((e) => e.created_by.id === s.ids.conductor));
  assert.ok(mine.data.every((e) => e.possible_duplicate_of === undefined));
  const foreignInc = s.db.get('SELECT id FROM incidents WHERE reported_by = ?', s.ids.conductor2);
  assert.equal((await d.get(`/api/incidents/${foreignInc.id}`)).status, 404);
  assert.ok((await d.get('/api/incidents')).data.every((i) => i.reported_by.id === s.ids.conductor));
  // Filtros de consulta no amplían el alcance.
  const viaFilter = await d.get(`/api/trips?vehicle_id=${foreign.vehicle_id}`);
  assert.equal(viaFilter.data.length, 0);
  const viaExpFilter = await d.get(`/api/expenses?trip_id=${foreign.id}`);
  assert.equal(viaExpFilter.data.length, 0);
  // Archivos de otro conductor.
  const d2 = await s.as('conductor2');
  const f = await d2.post('/api/files', { data: PNG });
  assert.equal(f.status, 200);
  assert.equal((await d.get(`/api/files/${f.data.id}`)).status, 404);
  assert.equal((await d2.get(`/api/files/${f.data.id}`)).status, 200);
  // No puede usar el archivo de otro como comprobante propio.
  const ownTrip = s.db.get("SELECT id FROM trips WHERE driver_id = ? AND status = 'asignado'", s.ids.conductor);
  s.db.run("UPDATE trips SET status = 'en_curso' WHERE id = ?", ownTrip.id);
  const steal = await d.post('/api/expenses', { trip_id: ownTrip.id, category: 'peaje', amount: 5, receipt_file_id: f.data.id });
  assert.equal(steal.status, 400);
  s.db.run("UPDATE trips SET status = 'asignado' WHERE id = ?", ownTrip.id);
  // Intentos indebidos quedan registrados en la auditoría de accesos.
  const denied = s.db.get("SELECT COUNT(*) c FROM audit_log WHERE kind = 'acceso' AND user_id = ? AND action IN ('acceso_denegado','registro_no_disponible')", s.ids.conductor).c;
  assert.ok(denied >= 5);
});

test('Sin sesión no hay acceso; las mutaciones exigen JSON (CSRF)', async () => {
  assert.equal((await s.raw('GET', '/api/trips')).status, 401);
  assert.equal((await s.raw('GET', '/api/trips/1', { token: 'inventado' })).status, 401);
  const d = await s.as('conductor');
  const res = await fetch(`${s.base}/api/trips/1/confirm`, { method: 'POST', headers: { authorization: `Bearer ${d.token}`, 'content-type': 'text/plain' }, body: '{}' });
  assert.equal(res.status, 415);
});

test('Nadie aprueba su propia solicitud, aunque tenga varios perfiles', async () => {
  const dueno = await s.as('dueno'); // gerencia + operaciones
  const g = await s.as('gerencia');
  const trip = tripByCode('0002');
  // Gasto extraordinario registrado por quien también es gerente.
  const exp = await dueno.post('/api/expenses', { trip_id: trip.id, category: 'reparacion_ruta', amount: 900, description: 'Grúa por falla en ruta', supplier: 'Grúas Sur', receipt_number: 'G-1' });
  assert.equal(exp.status, 200, JSON.stringify(exp.data));
  assert.equal(exp.data.approval_status, 'pendiente');
  const appr = s.db.get("SELECT id FROM approvals WHERE entity_type = 'expense' AND entity_id = ?", exp.data.id);
  const self = await dueno.post(`/api/approvals/${appr.id}/decide`, { decision: 'aprobada' });
  assert.equal(self.status, 403);
  assert.match(self.data.message, /propia/);
  const list = await dueno.get('/api/approvals?status=pendiente');
  assert.equal(list.data.find((a) => a.id === appr.id).can_decide, false);
  // Otro responsable sí puede.
  assert.equal((await g.post(`/api/approvals/${appr.id}/decide`, { decision: 'aprobada' })).status, 200);

  // Excepción operativa solicitada y autoaprobada.
  const ex = await dueno.post(`/api/trips/${tripByCode('0005').id}/exceptions`, { subtype: 'reprogramacion_tardia', reason: 'Cliente adelantó la carga' });
  assert.equal(ex.status, 200);
  assert.equal((await dueno.post(`/api/approvals/${ex.data.id}/decide`, { decision: 'aprobada', reason: 'ok por mi' })).status, 403);
  // El rechazo también exige que decida otra persona y con motivo.
  assert.equal((await g.post(`/api/approvals/${ex.data.id}/decide`, { decision: 'rechazada' })).status, 400);
  assert.equal((await g.post(`/api/approvals/${ex.data.id}/decide`, { decision: 'rechazada', reason: 'No hay conductores de reserva' })).status, 200);
  assert.equal((await g.post(`/api/approvals/${ex.data.id}/decide`, { decision: 'aprobada', reason: 'cambio de idea' })).status, 409, 'ya resuelta');
});

test('Mantenimiento no aprueba su propio presupuesto (ni con perfil de gerencia)', async () => {
  const a = await s.as('admin');
  const u = await a.post('/api/admin/users', { username: 'jefetaller', name: 'Jefe de taller', password: 'secreto123', roles: ['mantenimiento', 'gerencia'] });
  assert.equal(u.status, 200);
  const login = await s.raw('POST', '/api/auth/login', { body: { username: 'jefetaller', password: 'secreto123' } });
  const tok = login.data.token;
  const wo = await s.raw('POST', '/api/work-orders', { token: tok, body: { vehicle_id: s.db.get("SELECT id FROM vehicles WHERE plate='T-105'").id, title: 'Cambio de turbo', kind: 'correctivo' } });
  assert.equal(wo.status, 200);
  const b = await s.raw('POST', `/api/work-orders/${wo.data.id}/budget`, { token: tok, body: { amount: 4200, reason: 'Turbo con juego axial' } });
  assert.equal(b.status, 200);
  const appr = s.db.get("SELECT id FROM approvals WHERE entity_type = 'work_order' AND entity_id = ?", wo.data.id);
  assert.equal((await s.raw('POST', `/api/approvals/${appr.id}/decide`, { token: tok, body: { decision: 'aprobada' } })).status, 403);
  // El responsable de mantenimiento estándar no tiene permiso de aprobación.
  const m = await s.as('mantenimiento');
  assert.equal((await m.post(`/api/approvals/${appr.id}/decide`, { decision: 'aprobada' })).status, 403);
  // Ni un conductor ni finanzas pueden aprobar presupuestos.
  assert.equal((await (await s.as('finanzas')).post(`/api/approvals/${appr.id}/decide`, { decision: 'aprobada' })).status, 403);
  assert.equal((await (await s.as('conductor')).post(`/api/approvals/${appr.id}/decide`, { decision: 'aprobada' })).status, 403);
  // Una solicitud pendiente no permite cerrar la orden.
  await s.raw('PATCH', `/api/work-orders/${wo.data.id}`, { token: tok, body: { diagnosis: 'Turbo dañado', labor_cost: 800, parts: [{ name: 'Turbo', qty: 1, unit_cost: 3400 }] } });
  await s.raw('POST', `/api/work-orders/${wo.data.id}/enter`, { token: tok, body: {} });
  const exit = await s.raw('POST', `/api/work-orders/${wo.data.id}/exit`, { token: tok, body: {} });
  assert.equal(exit.status, 409);
  assert.equal(exit.data.code, 'requiere_aprobacion');
  const g = await s.as('gerencia');
  assert.equal((await g.post(`/api/approvals/${appr.id}/decide`, { decision: 'aprobada' })).status, 200);
  assert.equal((await s.raw('POST', `/api/work-orders/${wo.data.id}/exit`, { token: tok, body: {} })).status, 200);
  // Costos cerrados: no se editan.
  assert.equal((await s.raw('PATCH', `/api/work-orders/${wo.data.id}`, { token: tok, body: { labor_cost: 1 } })).status, 409);
});

test('Una solicitud pendiente no equivale a una autorización', async () => {
  const f = await s.as('finanzas');
  // El gasto extraordinario sembrado sigue pendiente de aprobación.
  const pending = s.db.get("SELECT id FROM expenses WHERE approval_status = 'pendiente' ORDER BY id LIMIT 1");
  const r = await f.post(`/api/expenses/${pending.id}/validate`, { decision: 'validado' });
  assert.equal(r.status, 409);
  // Reprogramación con poca anticipación: requiere excepción aprobada, no solo solicitada.
  const o = await s.as('operaciones');
  const trip = tripByCode('0001'); // empieza en ~3 h
  const body = { scheduled_start: s.hours(5), scheduled_end: s.hours(32), reason: 'Cliente pidió retrasar la carga' };
  assert.equal((await o.post(`/api/trips/${trip.id}/reschedule`, body)).status, 409);
  const ex = await o.post(`/api/trips/${trip.id}/exceptions`, { subtype: 'reprogramacion_tardia', reason: 'Cliente pidió retrasar' });
  assert.equal(ex.data.status, 'pendiente');
  assert.equal((await o.post(`/api/trips/${trip.id}/reschedule`, body)).status, 409, 'pendiente no autoriza');
  const g = await s.as('gerencia');
  assert.equal((await g.post(`/api/approvals/${ex.data.id}/decide`, { decision: 'aprobada', reason: 'Cliente estratégico' })).status, 200);
  const ok = await o.post(`/api/trips/${trip.id}/reschedule`, body);
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  // Sin motivo no se reprograma.
  assert.equal((await o.post(`/api/trips/${trip.id}/reschedule`, { ...body, reason: '' })).status, 400);
});

test('Las notificaciones no muestran datos sensibles a perfiles sin permiso', async () => {
  const a = await s.as('admin');
  const u = await a.post('/api/admin/users', { username: 'analista', name: 'Analista', password: 'secreto123', roles: [], permissions: ['reports.view'] });
  assert.equal(u.status, 200);
  const { notify } = require('../src/core');
  notify(s.db, [u.data.id, s.ids.gerencia], { type: 't', title: 'Cierre', body: 'Viaje cerrado.', sensitive: 'Viaje cerrado. Margen: 1234' });
  const forAnalyst = s.db.get('SELECT body FROM notifications WHERE user_id = ? ORDER BY id DESC', u.data.id).body;
  const forManager = s.db.get('SELECT body FROM notifications WHERE user_id = ? ORDER BY id DESC', s.ids.gerencia).body;
  assert.doesNotMatch(forAnalyst, /Margen/);
  assert.match(forManager, /Margen/);
  // Cada usuario solo lee sus notificaciones.
  const d = await s.as('conductor');
  const n = await d.get('/api/notifications');
  assert.ok(n.data.items.every((x) => x.user_id === s.ids.conductor));
});
