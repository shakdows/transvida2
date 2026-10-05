'use strict';
// Datos y cuentas de demostración. Contraseña común: demo1234 (solo para demostración).
const { hashPassword } = require('./auth');

const DEMO_PASSWORD = 'demo1234';

const DEMO_USERS = [
  { username: 'gerencia', name: 'Laura Méndez', phone: '+51 900 000 001', roles: ['gerencia'] },
  { username: 'operaciones', name: 'Carlos Rivas', phone: '+51 900 000 002', roles: ['operaciones'] },
  { username: 'operaciones2', name: 'Marta Salas', phone: '+51 900 000 008', roles: ['operaciones'], permissions: ['finance.view_revenue'] },
  { username: 'conductor', name: 'Juan Pérez', phone: '+51 900 000 003', roles: ['conductor'] },
  { username: 'conductor2', name: 'Pedro Gómez', phone: '+51 900 000 004', roles: ['conductor'] },
  { username: 'mantenimiento', name: 'Rosa Díaz', phone: '+51 900 000 005', roles: ['mantenimiento'] },
  { username: 'finanzas', name: 'Ana Torres', phone: '+51 900 000 006', roles: ['finanzas'] },
  { username: 'admin', name: 'Soporte Sistemas', phone: '+51 900 000 007', roles: ['admin'] },
  // Empresa pequeña: una persona con varios perfiles.
  { username: 'dueno', name: 'Elena Quispe', phone: '+51 900 000 009', roles: ['gerencia', 'operaciones'] },
];

function seed(db, { reset = false } = {}) {
  if (reset) {
    db.exec(`PRAGMA foreign_keys = OFF;
      DROP TRIGGER IF EXISTS audit_no_delete; DROP TRIGGER IF EXISTS events_no_delete; DROP TRIGGER IF EXISTS expenses_no_delete;
      DELETE FROM notifications; DELETE FROM drafts; DELETE FROM cost_entries; DELETE FROM approvals; DELETE FROM work_orders;
      DELETE FROM incidents; DELETE FROM expenses; DELETE FROM files; DELETE FROM inspections; DELETE FROM trip_events;
      DELETE FROM trips; DELETE FROM immobilizations; DELETE FROM vehicles; DELETE FROM clients; DELETE FROM outbox;
      DELETE FROM integrations; DELETE FROM config; DELETE FROM sessions; DELETE FROM user_permissions; DELETE FROM user_roles;
      DELETE FROM users; DELETE FROM audit_log; PRAGMA foreign_keys = ON;`);
  }
  const now = Date.now();
  const at = (h) => new Date(now + h * 3600e3).toISOString();
  const ts = at(0);
  const pw = hashPassword(DEMO_PASSWORD);

  return db.tx(() => {
    const u = {};
    for (const d of DEMO_USERS) {
      const id = db.insert('users', { username: d.username, name: d.name, phone: d.phone, password_hash: pw, active: 1, created_at: ts });
      for (const r of d.roles) db.insert('user_roles', { user_id: id, role: r, granted_at: ts });
      for (const p of d.permissions || []) db.insert('user_permissions', { user_id: id, permission: p, granted_at: ts });
      u[d.username] = id;
    }
    for (const code of ['email', 'whatsapp']) db.insert('integrations', { code, enabled: 0, settings: '{}' });

    const c = {
      andina: db.insert('clients', { name: 'Minera Andina S.A.', tax_id: '20100000001', contact: 'logistica@andina.example', created_at: ts }),
      costa: db.insert('clients', { name: 'Agroexport Costa', tax_id: '20100000002', contact: 'despachos@costa.example', created_at: ts }),
      norte: db.insert('clients', { name: 'Distribuidora del Norte', tax_id: '20100000003', contact: 'compras@norte.example', created_at: ts }),
    };
    const v = {};
    const veh = [
      ['T-101', 'tractor', 'Volvo', 'FH 500', 2021, 182400, 185000, null],
      ['T-102', 'tractor', 'Scania', 'R 450', 2020, 240100, 250000, null],
      ['T-103', 'tractor', 'Mercedes-Benz', 'Actros 2645', 2022, 98000, 100000, null],
      ['T-104', 'tractor', 'Volvo', 'FH 460', 2019, 310500, 320000, null],
      ['T-105', 'tractor', 'Freightliner', 'Cascadia', 2023, 45200, 60000, null],
      ['R-201', 'remolque', 'Randon', 'Plataforma 3 ejes', 2020, 0, null, at(24 * 60)],
      ['R-202', 'remolque', 'Facchini', 'Furgón', 2021, 0, null, at(24 * 10)],
      ['R-203', 'remolque', 'Randon', 'Cisterna', 2019, 0, null, at(24 * 90)],
      ['R-204', 'remolque', 'Guerra', 'Cama baja', 2022, 0, null, at(24 * 120)],
    ];
    for (const [plate, kind, brand, model, year, odometer, nextKm, nextDate] of veh) {
      v[plate] = db.insert('vehicles', { plate, kind, brand, model, year, odometer, next_service_km: nextKm, next_service_date: nextDate ? nextDate.slice(0, 10) : null, created_at: ts });
    }

    // Unidad inmovilizada y en taller.
    db.insert('immobilizations', { vehicle_id: v['T-104'], reason: 'Embrague con desgaste severo; no apta para operar', source: 'mantenimiento', created_by: u.mantenimiento, created_at: at(-30) });
    db.insert('work_orders', {
      vehicle_id: v['T-104'], kind: 'correctivo', status: 'en_taller', title: 'Cambio de kit de embrague',
      diagnosis: 'Disco y prensa con desgaste. Volante sin daño.', works: 'Desmontaje de caja, cambio de kit.',
      parts: JSON.stringify([{ name: 'Kit de embrague', qty: 1, unit_cost: 1350 }, { name: 'Rodamiento collarín', qty: 1, unit_cost: 120 }]),
      labor_cost: 450, parts_cost: 1470, entered_at: at(-28), created_by: u.mantenimiento, created_at: at(-30), updated_at: at(-28),
    });
    db.insert('work_orders', {
      vehicle_id: v['T-102'], kind: 'preventivo', status: 'programado', title: 'Servicio de 250.000 km', scheduled_date: at(24 * 5).slice(0, 10),
      created_by: u.mantenimiento, created_at: at(-48), updated_at: at(-48),
    });

    const trip = (o) => db.insert('trips', { coordinator_id: u.operaciones, created_by: u.operaciones, created_at: at(-200), updated_at: ts, ...o });
    const ev = (tripId, type, h, userId, odometer = null) => db.insert('trip_events', { trip_id: tripId, type, at: at(h), user_id: userId, odometer });
    const year = new Date().getFullYear();

    // 1. Asignado al conductor demo, sale en unas horas.
    trip({ code: `TV-${year}-0001`, client_id: c.andina, origin: 'Callao — Almacén central', destination: 'Arequipa — Planta Cerro Verde',
      cargo: 'Repuestos mineros (18 t)', instructions: 'Ingreso por garita 3 con EPP completo. Contactar a almacén al llegar.',
      scheduled_start: at(3), scheduled_end: at(30), vehicle_id: v['T-101'], trailer_id: v['R-201'], driver_id: u.conductor,
      status: 'asignado', revenue_agreed: 4800, budget_cost: 2600 });

    // 2. En curso con conductor2.
    const t2 = trip({ code: `TV-${year}-0002`, client_id: c.costa, origin: 'Ica — Packing Costa', destination: 'Callao — Terminal portuario',
      cargo: 'Uva de exportación refrigerada', instructions: 'Mantener cadena de frío. Cita en terminal 14:00.',
      scheduled_start: at(-6), scheduled_end: at(4), vehicle_id: v['T-103'], trailer_id: v['R-202'], driver_id: u.conductor2,
      status: 'en_curso', revenue_agreed: 2100, budget_cost: 1100, confirmed_at: at(-8), started_at: at(-6), km_start: 97700 });
    ev(t2, 'confirmacion', -8, u.conductor2); ev(t2, 'salida', -6, u.conductor2, 97700); ev(t2, 'llegada_carga', -5, u.conductor2);
    ev(t2, 'inicio_traslado', -4, u.conductor2);
    db.insert('expenses', { trip_id: t2, vehicle_id: v['T-103'], category: 'combustible', amount: 420, liters: 105, supplier: 'Grifo Panamericana', receipt_number: 'F001-2231', receipt_date: at(-5).slice(0, 10), created_by: u.conductor2, created_at: at(-5) });
    db.insert('expenses', { trip_id: t2, vehicle_id: v['T-103'], category: 'peaje', amount: 38.5, supplier: 'Peaje Chilca', receipt_number: 'P-88812', receipt_date: at(-4).slice(0, 10), created_by: u.conductor2, created_at: at(-4) });
    const ex = db.insert('expenses', { trip_id: t2, vehicle_id: v['T-103'], category: 'reparacion_ruta', amount: 650, description: 'Cambio de neumático reventado en ruta', supplier: 'Llantería El Sol', receipt_number: 'B002-115', receipt_date: at(-3).slice(0, 10), extraordinary: 1, approval_status: 'pendiente', created_by: u.conductor2, created_at: at(-3) });
    db.insert('approvals', { type: 'gasto_extraordinario', entity_type: 'expense', entity_id: ex, amount: 650, reason: 'Cambio de neumático reventado en ruta', status: 'pendiente', requested_by: u.conductor2, requested_at: at(-3) });
    db.insert('incidents', { trip_id: t2, vehicle_id: v['T-103'], type: 'retraso', severity: 'media', description: 'Demora de 1 h por neumático reventado', reported_by: u.conductor2, created_at: at(-3) });

    // 3. Cierre operativo validado, pendiente de cierre financiero (no ocupa recursos).
    const t3 = trip({ code: `TV-${year}-0003`, client_id: c.norte, origin: 'Lima — CD Ate', destination: 'Trujillo — Almacén Norte',
      cargo: 'Abarrotes paletizados', scheduled_start: at(-72), scheduled_end: at(-50), vehicle_id: v['T-105'], trailer_id: v['R-203'],
      driver_id: u.conductor, status: 'cerrado_operativo', revenue_agreed: 3200, budget_cost: 1700, confirmed_at: at(-74), started_at: at(-72),
      km_start: 44640, km_end: 45200, driver_end_reported_at: at(-51), close_requested_at: at(-50), ops_closed_at: at(-48), ops_closed_by: u.operaciones });
    for (const [type, h, km] of [['confirmacion', -74], ['salida', -72, 44640], ['llegada_carga', -71], ['inicio_traslado', -70], ['llegada_destino', -52], ['fin_servicio', -51, 45200], ['solicitud_cierre', -50]]) ev(t3, type, h, u.conductor, km ?? null);
    ev(t3, 'cierre_operativo', -48, u.operaciones);
    db.insert('expenses', { trip_id: t3, vehicle_id: v['T-105'], category: 'combustible', amount: 980, liters: 240, supplier: 'Grifo Norte', receipt_number: 'F010-5512', receipt_date: at(-70).slice(0, 10), validation_status: 'validado', validated_by: u.finanzas, validated_at: at(-40), created_by: u.conductor, created_at: at(-70) });
    const toll = db.insert('expenses', { trip_id: t3, vehicle_id: v['T-105'], category: 'peaje', amount: 96, supplier: 'Peajes Norte', receipt_number: 'P-77120', receipt_date: at(-69).slice(0, 10), created_by: u.conductor, created_at: at(-69) });
    db.insert('expenses', { trip_id: t3, vehicle_id: v['T-105'], category: 'peaje', amount: 96, supplier: 'Peajes Norte', receipt_number: 'P-77120', receipt_date: at(-69).slice(0, 10), possible_duplicate_of: toll, created_by: u.conductor, created_at: at(-68) });
    db.insert('expenses', { trip_id: t3, vehicle_id: v['T-105'], category: 'alimentacion', amount: 45, supplier: 'Restaurante Km 400', receipt_number: 'B001-3321', receipt_date: at(-60).slice(0, 10), validation_status: 'rechazado', validation_reason: 'Comprobante ilegible; reenviar foto', validated_by: u.finanzas, validated_at: at(-40), created_by: u.conductor, created_at: at(-60) });

    // 4. Cerrado financieramente la semana pasada.
    const t4 = trip({ code: `TV-${year}-0004`, client_id: c.andina, origin: 'Callao — Almacén central', destination: 'Huancayo — Planta',
      cargo: 'Bolas de molienda', scheduled_start: at(-200), scheduled_end: at(-180), vehicle_id: v['T-102'], trailer_id: v['R-204'],
      driver_id: u.conductor2, status: 'cerrado_financiero', revenue_agreed: 3900, budget_cost: 2000, confirmed_at: at(-202), started_at: at(-200),
      km_start: 239600, km_end: 240100, driver_end_reported_at: at(-181), ops_closed_at: at(-178), ops_closed_by: u.operaciones,
      fin_closed_at: at(-150), fin_closed_by: u.finanzas, fin_revenue: 3900, fin_cost: 2310, fin_margin: 1590 });
    ev(t4, 'salida', -200, u.conductor2, 239600); ev(t4, 'fin_servicio', -181, u.conductor2, 240100); ev(t4, 'cierre_operativo', -178, u.operaciones);
    db.insert('expenses', { trip_id: t4, vehicle_id: v['T-102'], category: 'combustible', amount: 1650, supplier: 'Grifo Central', receipt_number: 'F003-1001', receipt_date: at(-199).slice(0, 10), validation_status: 'validado', validated_by: u.finanzas, validated_at: at(-160), created_by: u.conductor2, created_at: at(-199) });
    db.insert('cost_entries', { trip_id: t4, kind: 'asignado', concept: 'Depreciación prorrateada', amount: 660, created_by: u.finanzas, created_at: at(-155) });

    // 5. Programado sin recursos para mañana.
    trip({ code: `TV-${year}-0005`, client_id: c.costa, origin: 'Chincha — Fundo San José', destination: 'Lima — Mercado mayorista',
      cargo: 'Cítricos', scheduled_start: at(26), scheduled_end: at(36), status: 'programado' });

    const notif = (userId, title, body) => db.insert('notifications', { user_id: userId, type: 'demo', title, body, created_at: ts });
    notif(u.conductor, `Nuevo viaje asignado TV-${year}-0001`, 'Callao → Arequipa. Confirme la recepción.');
    notif(u.gerencia, 'Solicitud pendiente: Gasto extraordinario', 'Pedro Gómez solicita autorización (Gasto extraordinario).');
    return u;
  });
}

module.exports = { seed, DEMO_USERS, DEMO_PASSWORD };

if (require.main === module) {
  const path = require('node:path');
  const { open } = require('./db');
  const file = process.env.TRANSVIDA_DB || path.join(__dirname, '..', 'data', 'transvida.db');
  const db = open(file);
  seed(db, { reset: process.argv.includes('--reset') });
  db.close();
  open(file).close(); // recrea triggers eliminados durante el reinicio
  console.log(`Datos de demostración cargados en ${file}. Contraseña: ${DEMO_PASSWORD}`);
}
