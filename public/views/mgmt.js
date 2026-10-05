// Espacio de gerencia: resumen ejecutivo, rentabilidad, historial y reportes.
import { api, html, render, money, dt, num, chip, tripChip, table, bind, navigate, label, toLocalInput, fromLocalInput } from '../lib.js';

const kpi = (v, l, cls = '') => html`<div class="kpi ${cls}"><div class="v">${v}</div><div class="l">${l}</div></div>`;

function periodControls(q) {
  return html`<form class="actions" id="per" style="align-items:flex-end">
    <div><label>Desde</label><input type="date" name="from" value="${q.from ? q.from.slice(0, 10) : ''}"></div>
    <div><label>Hasta</label><input type="date" name="to" value="${q.to ? q.to.slice(0, 10) : ''}"></div>
    <button class="btn">Aplicar</button></form>`;
}
function bindPeriod(el, view) {
  el.querySelector('#per').onsubmit = (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const p = new URLSearchParams();
    if (f.get('from')) p.set('from', new Date(f.get('from') + 'T00:00').toISOString());
    if (f.get('to')) p.set('to', new Date(f.get('to') + 'T23:59').toISOString());
    navigate(`/gerencia/${view}?${p}`);
  };
}
const query = () => Object.fromEntries(new URLSearchParams(location.hash.split('?')[1] || ''));

export async function executive(el) {
  const q = query();
  const d = await api('GET', `/api/dashboard/executive?${new URLSearchParams(q)}`);
  const f = d.fleet.by_status;
  const p = d.profitability;
  render(el, html`<div class="split"><h1>Resumen ejecutivo</h1>${periodControls(d.period)}</div>
    <p class="muted small">Período: ${dt(d.period.from)} — ${dt(d.period.to)}</p>
    <h2>Flota</h2>
    <div class="grid">${kpi(d.fleet.total, 'Tractores')}${kpi(f.disponible || 0, 'Disponibles')}${kpi((f.en_viaje || 0) + (f.reservado || 0), 'En viaje / reservados')}
      ${kpi((f.inmovilizado || 0) + (f.en_taller || 0), 'Detenidos', (f.inmovilizado || f.en_taller) ? 'alert' : '')}${kpi(num(d.fleet.utilization_pct) + ' %', 'Utilización del período')}</div>
    <h2>Viajes</h2>
    <div class="grid">${kpi(d.trips.active, 'Activos')}${kpi(d.trips.delayed, 'Retrasados', d.trips.delayed ? 'alert' : '')}${kpi(d.trips.finished, 'Finalizados en el período')}
      ${kpi(d.trips.pending_financial_close, 'Pendientes de cierre financiero')}${kpi(d.pending_approvals, 'Aprobaciones pendientes', d.pending_approvals ? 'alert' : '')}</div>
    ${p ? html`<h2>Resultados económicos</h2>
    <div class="grid">${kpi(money(p.revenue), 'Ingresos')}${kpi(money(p.cost), 'Costos')}${kpi(money(p.margin), 'Margen')}
      ${kpi(money(d.costs.fuel), 'Combustible')}${kpi(money(d.costs.maintenance), 'Mantenimiento')}
      ${kpi(money(p.budget_vs_actual), p.budget_vs_actual > 0 ? 'Costo sobre presupuesto' : 'Costo bajo presupuesto', p.budget_vs_actual > 0 ? 'alert' : '')}</div>` : ''}
    <div class="grid-2" style="margin-top:14px">
      <div class="card"><h2 style="margin-top:0">Unidades detenidas</h2>${table([{ h: 'Unidad', v: (u) => u.plate }, { h: 'Estado', v: (u) => chip(u.status) },
        { h: 'Motivo', v: (u) => u.reason || '—' }, { h: 'Desde', v: (u) => dt(u.since) }], d.stopped_units, { onRow: (u) => `/gerencia/unidad/${u.id}`, empty: 'Ninguna' })}</div>
      <div class="card"><h2 style="margin-top:0">Alertas e incidencias relevantes</h2>${table([{ h: 'Viaje', v: (a) => a.trip_code || '—' }, { h: 'Tipo', v: (a) => label(a.type) },
        { h: 'Severidad', v: (a) => chip(a.severity) }, { h: 'Descripción', v: (a) => a.description }], d.alerts, { empty: 'Sin alertas abiertas' })}</div>
    </div>
    <div class="card"><h2 style="margin-top:0">Viajes retrasados</h2>${table([{ h: 'Viaje', v: (t) => t.code }, { h: 'Ruta', v: (t) => `${t.origin} → ${t.destination}` },
      { h: 'Fin programado', v: (t) => dt(t.scheduled_end) }, { h: 'Estado', v: (t) => tripChip(t) }], d.delayed_trips, { onRow: (t) => `/gerencia/viaje/${t.id}`, empty: 'Sin retrasos' })}</div>`);
  bindPeriod(el, 'resumen');
  bind(el, {});
}

export async function profitability(el) {
  const q = query();
  const d = await api('GET', `/api/dashboard/executive?${new URLSearchParams(q)}`);
  const p = d.profitability;
  const groupTable = (rows, h, extra = []) => table([{ h, v: (g) => g.label }, { h: 'Viajes', cls: 'right', v: (g) => g.trips },
    { h: 'Ingresos', cls: 'right', v: (g) => money(g.revenue) }, { h: 'Costos', cls: 'right', v: (g) => money(g.cost) },
    { h: 'Margen', cls: 'right', v: (g) => html`<strong>${money(g.margin)}</strong>` }, ...extra], rows);
  render(el, html`<div class="split"><h1>Rentabilidad</h1>${periodControls(d.period)}</div>
    <div class="card"><h2 style="margin-top:0">Por viaje (presupuesto vs. ejecución)</h2>${table([
    { h: 'Viaje', v: (r) => r.code }, { h: 'Estado', v: (r) => label(r.status) }, { h: 'Ingreso', cls: 'right', v: (r) => money(r.revenue) },
    { h: 'Presupuesto', cls: 'right', v: (r) => money(r.budget) }, { h: 'Costo real', cls: 'right', v: (r) => money(r.cost) },
    { h: 'Desvío', cls: 'right', v: (r) => (r.budget != null ? html`<span class="${r.cost > r.budget ? 'chip bad' : 'chip ok'}">${money(r.cost - r.budget)}</span>` : '—') },
    { h: 'Margen', cls: 'right', v: (r) => html`<strong>${money(r.margin)}</strong>` }], p.by_trip, { onRow: (r) => `/gerencia/viaje/${r.id}` })}</div>
    <div class="grid-2">
      <div class="card"><h2 style="margin-top:0">Por unidad</h2>${groupTable(p.by_vehicle, 'Unidad', [{ h: 'Mantenimiento', cls: 'right', v: (g) => money(g.maintenance) }, { h: 'Margen neto', cls: 'right', v: (g) => money(g.margin_after_maintenance) }])}</div>
      <div class="card"><h2 style="margin-top:0">Por cliente</h2>${groupTable(p.by_client, 'Cliente')}</div>
      <div class="card"><h2 style="margin-top:0">Por mes</h2>${groupTable(p.by_month, 'Mes')}</div>
    </div>`);
  bindPeriod(el, 'rentabilidad');
  bind(el, {});
}

export async function history(el) {
  const rows = await api('GET', '/api/audit?kind=negocio');
  render(el, html`<h1>Historial de decisiones</h1><p class="small muted">Registro inmutable: las correcciones se agregan como nuevos eventos; nada se elimina.</p>
    <div class="card">${table([{ h: 'Fecha', v: (a) => html`<span class="nowrap">${dt(a.at)}</span>` }, { h: 'Usuario', v: (a) => a.user_name || 'Sistema' },
      { h: 'Acción', v: (a) => label(a.action) }, { h: 'Registro', v: (a) => a.entity_type ? `${a.entity_type} #${a.entity_id ?? ''}` : '—' },
      { h: 'Motivo', v: (a) => a.reason || '—' }], rows)}</div>`);
}

export async function reports(el) {
  render(el, html`<h1>Reportes</h1>
    <div class="card"><h2 style="margin-top:0">Exportar viajes</h2>
      <form id="exp" class="actions" style="align-items:flex-end">
        <div><label>Desde</label><input type="datetime-local" name="from" value="${toLocalInput(new Date(Date.now() - 30 * 86400e3).toISOString())}"></div>
        <div><label>Hasta</label><input type="datetime-local" name="to" value="${toLocalInput(new Date().toISOString())}"></div>
        <button class="btn primary">Descargar CSV</button></form>
      <p class="small muted">Incluye costos, ingresos y márgenes según sus permisos. Cada exportación queda registrada.</p></div>`);
  el.querySelector('#exp').onsubmit = (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    location.href = `/api/reports/trips.csv?from=${encodeURIComponent(fromLocalInput(f.get('from')))}&to=${encodeURIComponent(fromLocalInput(f.get('to')))}`;
  };
}
