'use strict';
// Criterios de aceptación por perfil, verificados con cuentas de demostración independientes
// y mediante solicitudes directas al servidor (no a través de la interfaz).
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');

let s;
test.before(async () => { s = await startServer(); });
test.after(() => s.close());

const tripByCode = (suffix) => s.db.get('SELECT * FROM trips WHERE code LIKE ?', `%-${suffix}`);

test('Gerencia consulta resultados globales y exporta, pero no opera ni borra historial', async () => {
  const g = await s.as('gerencia');
  const dash = await g.get('/api/dashboard/executive');
  assert.equal(dash.status, 200);
  assert.ok(dash.data.profitability, 'incluye rentabilidad');
  assert.ok(dash.data.profitability.by_vehicle.length > 0);
  assert.ok(dash.data.profitability.by_client.length > 0);
  assert.ok(dash.data.costs.fuel > 0);
  assert.ok(dash.data.stopped_units.some((u) => u.plate === 'T-104' && u.reason));
  const t = await g.get(`/api/trips/${tripByCode('0003').id}`);
  assert.equal(typeof t.data.revenue_agreed, 'number');
  assert.equal(typeof t.data.margin, 'number');
  const csv = await g.get('/api/reports/trips.csv');
  assert.equal(csv.status, 200);
  assert.match(csv.data, /Margen/);
  assert.equal((await g.get('/api/audit?kind=negocio')).status, 200);
  // No opera: no crea viajes ni valida gastos ni cierra financieramente.
  assert.equal((await g.post('/api/trips', { origin: 'A', destination: 'B', scheduled_start: s.hours(10), scheduled_end: s.hours(20) })).status, 403);
  assert.equal((await g.post('/api/expenses/1/validate', { decision: 'validado' })).status, 403);
  assert.equal((await g.post(`/api/trips/${tripByCode('0003').id}/financial-close`, {})).status, 403);
  // No existe ninguna vía para borrar historial; la base lo impide.
  assert.equal((await g.del('/api/audit/1')).status, 404);
  assert.throws(() => s.db.run('DELETE FROM audit_log'), /no se puede eliminar/);
  assert.throws(() => s.db.run("UPDATE trip_events SET notes = 'x'"), /no se modifican/);
});

test('Operaciones organiza viajes sin acceso financiero por defecto', async () => {
  const o = await s.as('operaciones');
  const board = await o.get('/api/dashboard/operations');
  assert.equal(board.status, 200);
  for (const t of board.data.trips) {
    assert.equal(t.revenue_agreed, undefined);
    assert.equal(t.margin, undefined);
    assert.equal(t.costs, undefined);
  }
  const detail = await o.get(`/api/trips/${tripByCode('0001').id}`);
  assert.equal(detail.data.revenue_agreed, undefined);
  assert.equal(detail.data.cost_entries, undefined);
  assert.equal((await o.get('/api/dashboard/executive')).status, 403);
  assert.equal((await o.get('/api/reports/trips.csv')).status, 403);
  // No puede fijar ingresos al crear un viaje.
  assert.equal((await o.post('/api/trips', { origin: 'A', destination: 'B', scheduled_start: s.hours(50), scheduled_end: s.hours(60), revenue_agreed: 999 })).status, 403);
  // Crea y asigna.
  const created = await o.post('/api/trips', { origin: 'Lima', destination: 'Ica', scheduled_start: s.hours(100), scheduled_end: s.hours(110) });
  assert.equal(created.status, 200);
  const a = await o.post(`/api/trips/${created.data.id}/assign`, { vehicle_id: s.db.get("SELECT id FROM vehicles WHERE plate='T-103'").id, driver_id: s.ids.conductor2 });
  assert.equal(a.status, 200, JSON.stringify(a.data));
  assert.equal(a.data.status, 'asignado');
  // No valida gastos, no cierra financieramente, no libera unidades.
  assert.equal((await o.post('/api/expenses/1/validate', { decision: 'validado' })).status, 403);
  assert.equal((await o.post(`/api/trips/${tripByCode('0003').id}/financial-close`, {})).status, 403);
  assert.equal((await o.post(`/api/vehicles/${s.db.get("SELECT id FROM vehicles WHERE plate='T-104'").id}/release`, { notes: 'listo ok' })).status, 403);
});

test('El permiso adicional de ingresos y márgenes se concede explícitamente', async () => {
  const o2 = await s.as('operaciones2');
  const t = await o2.get(`/api/trips/${tripByCode('0001').id}`);
  assert.equal(t.data.revenue_agreed, 4800);
  assert.equal(typeof t.data.margin, 'number');
});

test('Operaciones no puede asignar una unidad inmovilizada (ni con una excepción aprobada)', async () => {
  const o = await s.as('operaciones');
  const g = await s.as('gerencia');
  const trip = tripByCode('0005');
  const t104 = s.db.get("SELECT id FROM vehicles WHERE plate='T-104'").id;
  const r = await o.post(`/api/trips/${trip.id}/assign`, { vehicle_id: t104, driver_id: s.ids.conductor2 });
  assert.equal(r.status, 409);
  assert.equal(r.data.code, 'unidad_inmovilizada');
  // Una aprobación comercial no levanta una restricción técnica crítica.
  const ex = await o.post(`/api/trips/${trip.id}/exceptions`, { subtype: 'solapamiento_conductor', reason: 'Cliente prioritario' });
  assert.equal(ex.status, 200);
  assert.equal((await g.post(`/api/approvals/${ex.data.id}/decide`, { decision: 'aprobada', reason: 'Autorizado por urgencia' })).status, 200);
  const again = await o.post(`/api/trips/${trip.id}/assign`, { vehicle_id: t104, driver_id: s.ids.conductor2 });
  assert.equal(again.status, 409);
  assert.equal(again.data.code, 'unidad_inmovilizada');
  // Tampoco existe un tipo de excepción para restricciones técnicas.
  assert.equal((await o.post(`/api/trips/${trip.id}/exceptions`, { subtype: 'restriccion_tecnica', reason: 'Necesito el camión' })).status, 400);
});

test('Conductor: solo consulta y opera sus asignaciones', async () => {
  const d = await s.as('conductor');
  const list = await d.get('/api/trips');
  assert.equal(list.status, 200);
  assert.ok(list.data.length > 0);
  assert.ok(list.data.every((t) => t.driver.id === s.ids.conductor));
  for (const t of list.data) {
    assert.equal(t.revenue_agreed, undefined);
    assert.equal(t.margin, undefined);
    assert.equal(t.costs, undefined);
    assert.equal(t.budget_cost, undefined);
  }
  const own = await d.get(`/api/trips/${tripByCode('0001').id}`);
  assert.equal(own.status, 200);
  assert.ok(own.data.coordinator.phone, 'incluye contacto del coordinador');
  assert.ok(own.data.instructions);
  // Vehículo asignado: visible. Otro vehículo: no.
  assert.equal((await d.get(`/api/vehicles/${own.data.vehicle.id}`)).status, 200);
  assert.equal((await d.get(`/api/vehicles/${s.db.get("SELECT id FROM vehicles WHERE plate='T-104'").id}`)).status, 404);
  assert.equal((await d.get('/api/vehicles')).status, 403);
  // Sin finanzas, sin cambios de asignación, sin aprobaciones, sin mantenimiento.
  assert.equal((await d.get('/api/dashboard/executive')).status, 403);
  assert.equal((await d.post(`/api/trips/${own.data.id}/assign`, { vehicle_id: 1, driver_id: s.ids.conductor })).status, 403);
  assert.equal((await d.post('/api/expenses/1/validate', { decision: 'validado' })).status, 403);
  assert.equal((await d.get('/api/work-orders')).status, 403);
  assert.equal((await d.patch('/api/work-orders/1', { labor_cost: 0 })).status, 403);
  assert.equal((await d.post(`/api/trips/${own.data.id}/financial-close`, {})).status, 403);
  assert.equal((await d.post(`/api/trips/${tripByCode('0003').id}/validate-close`, {})).status, 403);
  // No existen rutas para eliminar registros enviados.
  assert.ok([404, 405].includes((await d.del('/api/expenses/4')).status));
  assert.ok([404, 405].includes((await d.del(`/api/trips/${own.data.id}`)).status));
  assert.ok(s.db.get('SELECT id FROM expenses WHERE id = 4'));
  assert.throws(() => s.db.run('DELETE FROM expenses WHERE id = 4'), /no se eliminan/);
});

test('Mantenimiento inmoviliza y libera técnicamente, sin márgenes ni cierres financieros', async () => {
  const m = await s.as('mantenimiento');
  const home = await m.get('/api/dashboard/maintenance');
  assert.equal(home.status, 200);
  assert.ok(home.data.in_workshop.length >= 1);
  const t101 = s.db.get("SELECT id FROM vehicles WHERE plate='T-101'").id;
  const trip1 = tripByCode('0001');
  assert.equal((await m.post(`/api/vehicles/${t101}/immobilize`, {})).status, 400, 'exige motivo');
  const imm = await m.post(`/api/vehicles/${t101}/immobilize`, { reason: 'Fuga en sistema de frenos detectada en patio' });
  assert.equal(imm.status, 200);
  assert.equal(imm.data.availability.status, 'inmovilizado');
  // La reserva existente no se cancela ni se reasigna automáticamente.
  const afterImm = tripByCode('0001');
  assert.equal(afterImm.vehicle_id, trip1.vehicle_id);
  assert.equal(afterImm.status, trip1.status);
  const rel = await m.post(`/api/vehicles/${t101}/release`, { notes: 'Se reemplazó la cañería; prueba de frenado correcta' });
  assert.equal(rel.status, 200);
  assert.equal(rel.data.availability.status, 'reservado');
  const afterRel = tripByCode('0001');
  assert.equal(afterRel.vehicle_id, trip1.vehicle_id);
  assert.equal(afterRel.driver_id, trip1.driver_id);
  assert.equal(afterRel.status, trip1.status);
  // Programación visible, sin datos comerciales.
  const trips = await m.get('/api/trips');
  assert.equal(trips.status, 200);
  assert.ok(trips.data.every((t) => t.revenue_agreed === undefined && t.margin === undefined));
  // Ve costos de mantenimiento.
  const wos = await m.get('/api/work-orders');
  assert.ok(wos.data.some((w) => typeof w.total_cost === 'number'));
  assert.equal((await m.get('/api/dashboard/executive')).status, 403);
  assert.equal((await m.post(`/api/trips/${tripByCode('0003').id}/financial-close`, {})).status, 403);
  assert.equal((await m.post(`/api/trips/${tripByCode('0005').id}/assign`, { vehicle_id: t101, driver_id: s.ids.conductor })).status, 403);
});

test('Finanzas cierra costos sin cambiar la operación', async () => {
  const f = await s.as('finanzas');
  const t3 = tripByCode('0003');
  const pending = (await f.get(`/api/expenses?trip_id=${t3.id}&validation_status=pendiente`)).data;
  assert.equal(pending.length, 2);
  const dup = pending.find((e) => e.possible_duplicate_of);
  assert.ok(dup, 'detecta el comprobante duplicado');
  // Cierre bloqueado mientras haya gastos pendientes.
  assert.equal((await f.post(`/api/trips/${t3.id}/financial-close`, {})).status, 409);
  assert.equal((await f.post(`/api/expenses/${dup.id}/validate`, { decision: 'rechazado' })).status, 400, 'rechazo exige motivo');
  const rej = await f.post(`/api/expenses/${dup.id}/validate`, { decision: 'rechazado', reason: 'Comprobante duplicado' });
  assert.equal(rej.data.validation_status, 'rechazado');
  const other = pending.find((e) => !e.possible_duplicate_of);
  assert.equal((await f.post(`/api/expenses/${other.id}/validate`, { decision: 'validado' })).status, 200);
  assert.equal((await f.post(`/api/trips/${t3.id}/costs`, { concept: 'Depreciación', amount: 300 })).status, 200);
  const close = await f.post(`/api/trips/${t3.id}/financial-close`, {});
  assert.equal(close.status, 200, JSON.stringify(close.data));
  assert.equal(close.data.status, 'cerrado_financiero');
  assert.equal(close.data.fin_cost, 980 + 96 + 300);
  // El gasto rechazado se conserva con su estado y explicación.
  const kept = await f.get(`/api/expenses/${dup.id}`);
  assert.equal(kept.data.validation_status, 'rechazado');
  assert.equal(kept.data.validation_reason, 'Comprobante duplicado');
  // Corrección posterior: ajuste trazable con motivo, sin alterar el cierre.
  assert.equal((await f.post(`/api/trips/${t3.id}/costs`, { concept: 'Peaje omitido', amount: 20 })).status, 400);
  const adj = await f.post(`/api/trips/${t3.id}/costs`, { concept: 'Peaje omitido', amount: 20, reason: 'Comprobante recibido tarde' });
  assert.equal(adj.status, 200);
  const t = await f.get(`/api/trips/${t3.id}`);
  assert.equal(t.data.fin_cost, 1376);
  assert.equal(t.data.costs.adjustments, 20);
  assert.equal(t.data.adjusted_margin, t.data.fin_margin - 20);
  assert.throws(() => s.db.run('UPDATE cost_entries SET amount = 0'), /no se modifican/);
  // No cambia asignaciones, no libera unidades, no altera eventos operativos.
  const t104 = s.db.get("SELECT id FROM vehicles WHERE plate='T-104'").id;
  assert.equal((await f.post(`/api/trips/${tripByCode('0005').id}/assign`, { vehicle_id: 1, driver_id: s.ids.conductor })).status, 403);
  assert.equal((await f.post(`/api/vehicles/${t104}/release`, { notes: 'liberar unidad' })).status, 403);
  assert.equal((await f.post(`/api/trips/${tripByCode('0002').id}/corrections`, { event_id: 1, reason: 'ajuste de hora' })).status, 403);
  assert.equal((await f.post(`/api/trips/${tripByCode('0002').id}/milestones/llegada_destino`, {})).status, 403);
  // Exporta para conciliación.
  const csv = await f.get('/api/reports/expenses.csv');
  assert.equal(csv.status, 200);
  assert.match(csv.data, /Posible duplicado de/);
});

test('Administrador gestiona accesos sin recibir permisos financieros automáticamente', async () => {
  const a = await s.as('admin');
  assert.equal((await a.get('/api/admin/users')).status, 200);
  // Sin acceso financiero ni operativo.
  assert.equal((await a.get('/api/trips')).status, 403);
  assert.equal((await a.get('/api/trips/1')).status, 404);
  assert.equal((await a.get('/api/dashboard/executive')).status, 403);
  assert.equal((await a.get('/api/expenses')).status, 403);
  assert.equal((await a.get('/api/reports/expenses.csv')).status, 403);
  assert.equal((await a.get('/api/audit?kind=negocio')).status, 403);
  assert.equal((await a.get('/api/audit?kind=acceso')).status, 200);
  // No puede concederse permisos a sí mismo.
  const self = await a.patch(`/api/admin/users/${s.ids.admin}`, { permissions: ['finance.view_revenue'] });
  assert.equal(self.status, 403);
  assert.equal((await a.patch(`/api/admin/users/${s.ids.admin}`, { roles: ['admin', 'finanzas'] })).status, 403);
  assert.equal((await a.patch(`/api/admin/users/${s.ids.admin}`, { active: false })).status, 403, 'no se desactiva a sí mismo');
  const created = await a.post('/api/admin/users', { username: 'admin2', name: 'Admin 2', password: 'secreto123', roles: ['admin'] });
  assert.equal(created.status, 200);
  const login2 = await s.raw('POST', '/api/auth/login', { body: { username: 'admin2', password: 'secreto123' } });
  const tok2 = login2.data.token;
  // Con dos administradores, uno puede desactivar al otro.
  assert.equal((await s.raw('PATCH', `/api/admin/users/${s.ids.admin}`, { token: tok2, body: { active: false } })).status, 200);
  assert.equal((await a.get('/api/admin/users')).status, 401, 'la sesión del usuario desactivado deja de valer');
  // Un gestor con permiso explícito de usuarios no puede dejar el sistema sin administradores.
  const gestor = await s.raw('POST', '/api/admin/users', { token: tok2, body: { username: 'gestor', name: 'Gestor', password: 'secreto123', roles: ['gerencia'], permissions: ['users.manage'] } });
  assert.equal(gestor.status, 200);
  const lg = await s.raw('POST', '/api/auth/login', { body: { username: 'gestor', password: 'secreto123' } });
  const r1 = await s.raw('PATCH', `/api/admin/users/${created.data.id}`, { token: lg.data.token, body: { active: false } });
  assert.equal(r1.status, 409);
  assert.match(r1.data.message, /último administrador/);
  const r2 = await s.raw('PATCH', `/api/admin/users/${created.data.id}`, { token: lg.data.token, body: { roles: ['conductor'] } });
  assert.equal(r2.status, 409);
  // Restablece al administrador original para las demás pruebas.
  assert.equal((await s.raw('PATCH', `/api/admin/users/${s.ids.admin}`, { token: tok2, body: { active: true } })).status, 200);
});

test('Admin concede funciones financieras solo explícitamente a otro usuario', async () => {
  const login = await s.raw('POST', '/api/auth/login', { body: { username: 'admin2', password: 'secreto123' } });
  const tok = login.data.token;
  const u = await s.raw('POST', '/api/admin/users', { token: tok, body: { username: 'conta', name: 'Contadora', password: 'secreto123', roles: ['admin'] } });
  assert.equal(u.status, 200);
  const lc = await s.raw('POST', '/api/auth/login', { body: { username: 'conta', password: 'secreto123' } });
  assert.equal((await s.raw('GET', '/api/expenses', { token: lc.data.token })).status, 403);
  const upd = await s.raw('PATCH', `/api/admin/users/${u.data.id}`, { token: tok, body: { roles: ['admin', 'finanzas'] } });
  assert.equal(upd.status, 200);
  assert.equal((await s.raw('GET', '/api/expenses', { token: lc.data.token })).status, 200, 'efecto inmediato');
  // El portal de clientes no se habilita en el MVP.
  assert.equal((await s.raw('PATCH', `/api/admin/users/${u.data.id}`, { token: tok, body: { roles: ['cliente'] } })).status, 400);
});
