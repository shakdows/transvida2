'use strict';
// Tableros y reportes. Cada uno filtra los campos según los permisos del usuario.
const { nowIso, round2 } = require('../core');
const policy = require('../policy');
const fleet = require('./fleet');

const CLOSED = ['cerrado_operativo', 'cerrado_financiero', 'cancelado'];

function period(q) {
  const to = q.to ? new Date(q.to) : new Date();
  const from = q.from ? new Date(q.from) : new Date(to.getTime() - 30 * 86400e3);
  return { from: from.toISOString(), to: to.toISOString() };
}

function tripResult(db, t) {
  const c = policy.tripCosts(db, t.id);
  const revenue = t.status === 'cerrado_financiero' ? t.fin_revenue : t.revenue_agreed;
  const cost = c.total;
  return { revenue: revenue || 0, cost, margin: round2((revenue || 0) - cost), fuel: c.fuel, budget: t.budget_cost };
}

// Resumen ejecutivo (gerencia).
function executive(db, user, q = {}) {
  const { from, to } = period(q);
  const now = nowIso();
  const vehicles = fleet.listVehicles(db, user).filter((v) => v.kind === 'tractor');
  const byStatus = {};
  for (const v of vehicles) byStatus[v.availability.status] = (byStatus[v.availability.status] || 0) + 1;

  const trips = db.all('SELECT * FROM trips WHERE scheduled_start <= ? AND scheduled_end >= ?', to, from);
  const active = db.all(`SELECT * FROM trips WHERE status NOT IN (${CLOSED.map(() => '?').join(',')})`, ...CLOSED);
  const delayed = active.filter((t) => policy.isDelayed(t, now));
  const finished = trips.filter((t) => ['cerrado_operativo', 'cerrado_financiero'].includes(t.status));

  // Utilización: horas en viaje / horas disponibles del período.
  const hours = (new Date(to) - new Date(from)) / 3600e3;
  let usedHours = 0;
  for (const t of trips.filter((x) => x.started_at && x.vehicle_id)) {
    const s = Math.max(new Date(t.started_at), new Date(from));
    const e = Math.min(new Date(t.ops_closed_at || t.driver_end_reported_at || now), new Date(to));
    if (e > s) usedHours += (e - s) / 3600e3;
  }
  const utilization = vehicles.length ? round2((usedHours / (hours * vehicles.length)) * 100) : 0;

  const out = {
    period: { from, to },
    fleet: { total: vehicles.length, by_status: byStatus, utilization_pct: utilization },
    trips: { active: active.length, delayed: delayed.length, finished: finished.length, pending_financial_close: db.get("SELECT COUNT(*) c FROM trips WHERE status = 'cerrado_operativo'").c },
    delayed_trips: delayed.map((t) => policy.serializeTrip(db, user, t)),
    stopped_units: fleet.listVehicles(db, user).filter((v) => ['inmovilizado', 'en_taller'].includes(v.availability.status))
      .map((v) => ({ id: v.id, plate: v.plate, kind: v.kind, status: v.availability.status, reason: v.availability.immobilization?.reason || v.availability.work_order?.title, since: v.availability.immobilization?.since })),
    alerts: db.all(`SELECT i.id, i.type, i.severity, i.description, i.created_at, t.code AS trip_code FROM incidents i LEFT JOIN trips t ON t.id = i.trip_id
      WHERE i.status != 'resuelta' AND i.severity IN ('alta','critica') ORDER BY i.id DESC LIMIT 20`),
    pending_approvals: db.get("SELECT COUNT(*) c FROM approvals WHERE status = 'pendiente'").c,
  };

  if (user.has('finance.view_costs')) {
    const fuel = db.get(`SELECT COALESCE(SUM(amount),0) s FROM expenses WHERE category = 'combustible' AND validation_status != 'rechazado' AND created_at BETWEEN ? AND ?`, from, to).s;
    const maint = db.get(`SELECT COALESCE(SUM(labor_cost + parts_cost),0) s FROM work_orders WHERE status != 'cancelado' AND updated_at BETWEEN ? AND ?`, from, to).s;
    out.costs = { fuel: round2(fuel), maintenance: round2(maint) };
  }
  if (user.has('finance.view_revenue')) {
    const rows = trips.filter((t) => t.status !== 'cancelado').map((t) => ({ t, r: tripResult(db, t) }));
    const sum = (k) => round2(rows.reduce((s, x) => s + (x.r[k] || 0), 0));
    out.profitability = {
      revenue: sum('revenue'), cost: sum('cost'), margin: sum('margin'),
      budget_cost: sum('budget'), budget_vs_actual: round2(sum('cost') - sum('budget')),
      by_trip: rows.map(({ t, r }) => ({ id: t.id, code: t.code, status: t.status, ...r })),
      by_vehicle: group(db, rows, (t) => t.vehicle_id, (id) => db.get('SELECT plate FROM vehicles WHERE id = ?', id)?.plate || 'Sin unidad'),
      by_client: group(db, rows, (t) => t.client_id, (id) => db.get('SELECT name FROM clients WHERE id = ?', id)?.name || 'Sin cliente'),
      by_month: group(db, rows, (t) => t.scheduled_start.slice(0, 7), (k) => k),
    };
    // Mantenimiento por unidad dentro de la rentabilidad por unidad.
    for (const g of out.profitability.by_vehicle) {
      const m = db.get('SELECT COALESCE(SUM(labor_cost + parts_cost),0) s FROM work_orders WHERE vehicle_id = ? AND status != ? AND updated_at BETWEEN ? AND ?', g.key, 'cancelado', from, to).s;
      g.maintenance = round2(m);
      g.margin_after_maintenance = round2(g.margin - m);
    }
  }
  return out;
}

function group(db, rows, keyFn, labelFn) {
  const m = new Map();
  for (const { t, r } of rows) {
    const k = keyFn(t) ?? null;
    const g = m.get(k) || { key: k, label: labelFn(k), trips: 0, revenue: 0, cost: 0, margin: 0 };
    g.trips++; g.revenue = round2(g.revenue + r.revenue); g.cost = round2(g.cost + r.cost); g.margin = round2(g.margin + r.margin);
    m.set(k, g);
  }
  return [...m.values()].sort((a, b) => b.margin - a.margin);
}

// Tablero operativo (operaciones).
function operations(db, user) {
  const now = nowIso();
  const active = db.all(`SELECT * FROM trips WHERE status NOT IN (${CLOSED.map(() => '?').join(',')}) ORDER BY scheduled_start`, ...CLOSED);
  return {
    trips: active.map((t) => policy.serializeTrip(db, user, t)),
    to_close: active.filter((t) => ['fin_reportado', 'cierre_solicitado'].includes(t.status)).length,
    blocked: active.filter((t) => t.status === 'bloqueado').length,
    delayed: active.filter((t) => policy.isDelayed(t, now)).length,
    unassigned: active.filter((t) => t.status === 'programado').length,
    vehicles: fleet.listVehicles(db, user),
    drivers: fleet.driverAvailability(db),
    open_incidents: db.get("SELECT COUNT(*) c FROM incidents WHERE status != 'resuelta'").c,
    expenses_pending: db.get("SELECT COUNT(*) c FROM expenses WHERE validation_status = 'pendiente'").c,
  };
}

// Tablero de finanzas.
function finance(db, user) {
  return {
    expenses_to_validate: db.get("SELECT COUNT(*) c FROM expenses WHERE validation_status = 'pendiente' AND approval_status IN ('no_requerida','aprobada')").c,
    expenses_awaiting_approval: db.get("SELECT COUNT(*) c FROM expenses WHERE approval_status = 'pendiente'").c,
    possible_duplicates: db.get("SELECT COUNT(*) c FROM expenses WHERE possible_duplicate_of IS NOT NULL AND validation_status = 'pendiente'").c,
    trips_pending_close: db.all("SELECT * FROM trips WHERE status = 'cerrado_operativo' ORDER BY ops_closed_at").map((t) => policy.serializeTrip(db, user, t)),
    recently_closed: db.all("SELECT * FROM trips WHERE status = 'cerrado_financiero' ORDER BY fin_closed_at DESC LIMIT 20").map((t) => policy.serializeTrip(db, user, t)),
  };
}

function csv(rows, columns) {
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    // Evita inyección de fórmulas al abrir el CSV en una hoja de cálculo.
    const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? `'${s}` : s;
    return /[",;\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return '﻿' + [columns.map((c) => c[1]).join(','), ...rows.map((r) => columns.map((c) => esc(r[c[0]])).join(','))].join('\n');
}

// Exportación para conciliación (finanzas).
function expensesCsv(db, q) {
  const { from, to } = period(q);
  const rows = db.all(`SELECT e.id, t.code AS trip, v.plate, e.category, e.amount, e.supplier, e.receipt_number, e.receipt_date,
      e.extraordinary, e.approval_status, e.validation_status, e.validation_reason, e.possible_duplicate_of, u.name AS registered_by, e.created_at
    FROM expenses e JOIN trips t ON t.id = e.trip_id LEFT JOIN vehicles v ON v.id = e.vehicle_id JOIN users u ON u.id = e.created_by
    WHERE e.created_at BETWEEN ? AND ? ORDER BY e.id`, from, to);
  return csv(rows, [['id', 'ID'], ['trip', 'Viaje'], ['plate', 'Unidad'], ['category', 'Categoría'], ['amount', 'Monto'], ['supplier', 'Proveedor'],
    ['receipt_number', 'Comprobante'], ['receipt_date', 'Fecha comprobante'], ['extraordinary', 'Extraordinario'], ['approval_status', 'Aprobación'],
    ['validation_status', 'Validación'], ['validation_reason', 'Motivo'], ['possible_duplicate_of', 'Posible duplicado de'], ['registered_by', 'Registrado por'], ['created_at', 'Registrado']]);
}

function tripsCsv(db, user, q) {
  const { from, to } = period(q);
  const trips = db.all('SELECT * FROM trips WHERE scheduled_start <= ? AND scheduled_end >= ? ORDER BY scheduled_start', to, from);
  const rows = trips.map((t) => {
    const s = policy.serializeTrip(db, user, t);
    return {
      code: t.code, client: s.client?.name, origin: t.origin, destination: t.destination, status: s.status_label,
      vehicle: s.vehicle?.plate, driver: s.driver?.name, start: t.scheduled_start, end: t.scheduled_end,
      km: t.km_end && t.km_start ? t.km_end - t.km_start : '',
      revenue: s.revenue_agreed, cost: s.costs?.total, margin: s.margin, fin_margin: s.fin_margin,
    };
  });
  const cols = [['code', 'Viaje'], ['client', 'Cliente'], ['origin', 'Origen'], ['destination', 'Destino'], ['status', 'Estado'], ['vehicle', 'Unidad'],
    ['driver', 'Conductor'], ['start', 'Inicio programado'], ['end', 'Fin programado'], ['km', 'Km recorridos']];
  if (user.has('finance.view_costs')) cols.push(['cost', 'Costo']);
  if (user.has('finance.view_revenue')) cols.push(['revenue', 'Ingreso'], ['margin', 'Margen'], ['fin_margin', 'Margen cierre']);
  return csv(rows, cols);
}

module.exports = { executive, operations, finance, expensesCsv, tripsCsv };
