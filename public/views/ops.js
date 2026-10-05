// Espacio de operaciones: tablero de viajes y disponibilidad.
import { api, html, render, state, dt, chip, tripChip, table, bind, can } from '../lib.js';
import { newTrip } from './common.js';

const kpi = (v, l, alert = false) => html`<div class="kpi ${alert && v ? 'alert' : ''}"><div class="v">${v}</div><div class="l">${l}</div></div>`;

export async function board(el) {
  const b = await api('GET', '/api/dashboard/operations');
  const avail = b.vehicles.filter((v) => v.kind === 'tractor' && v.availability.status === 'disponible').length;
  const freeDrivers = b.drivers.filter((d) => d.status === 'disponible').length;
  render(el, html`<div class="split"><h1>Tablero operativo</h1>${can('trips.create') ? html`<button class="btn primary" data-act="new">+ Nuevo viaje</button>` : ''}</div>
    <div class="grid">
      ${kpi(b.trips.length, 'Viajes activos')}${kpi(b.unassigned, 'Sin recursos asignados', true)}${kpi(b.delayed, 'Retrasados', true)}
      ${kpi(b.blocked, 'Bloqueados por falla', true)}${kpi(b.to_close, 'Cierres por validar', true)}
      ${kpi(avail, 'Tractores disponibles')}${kpi(freeDrivers, 'Conductores disponibles')}
      ${kpi(b.open_incidents, 'Incidencias abiertas', true)}${kpi(b.expenses_pending, 'Gastos pendientes de revisión')}
    </div>
    <h2>Programación y avance</h2>
    <div class="card">${table([
    { h: 'Viaje', v: (t) => html`<strong>${t.code}</strong>` }, { h: 'Ruta', v: (t) => `${t.origin} → ${t.destination}` },
    { h: 'Programado', v: (t) => html`<span class="nowrap">${dt(t.scheduled_start)}</span>` },
    { h: 'Recursos', v: (t) => t.vehicle ? `${t.vehicle.plate}${t.trailer ? ' + ' + t.trailer.plate : ''} · ${t.driver?.name}` : html`<span class="chip warn">Sin asignar</span>` },
    { h: 'Estado', v: (t) => tripChip(t) },
  ], b.trips, { onRow: (t) => `/operaciones/viaje/${t.id}`, empty: 'No hay viajes activos' })}</div>
    <h2>Restricciones técnicas</h2>
    <div class="card">${table([
    { h: 'Unidad', v: (v) => v.plate }, { h: 'Estado', v: (v) => chip(v.availability.status) },
    { h: 'Motivo', v: (v) => v.availability.immobilization?.reason || v.availability.work_order?.title || '—' },
  ], b.vehicles.filter((v) => ['inmovilizado', 'en_taller'].includes(v.availability.status)), { empty: 'Sin unidades restringidas' })}</div>`);
  bind(el, { new: () => newTrip() });
}

export async function availability(el) {
  const [vehicles, drivers] = await Promise.all([api('GET', '/api/vehicles'), api('GET', '/api/drivers')]);
  const res = (r) => (r.length ? r.map((x) => html`<div class="small">${x.code}: ${dt(x.scheduled_start)} – ${dt(x.scheduled_end)}</div>`) : html`<span class="muted small">—</span>`);
  render(el, html`<h1>Disponibilidad</h1>
    <p class="notice">Al validar el cierre operativo los recursos quedan libres, aunque el cierre financiero siga pendiente.</p>
    <div class="grid-2">
      <div class="card"><h2 style="margin-top:0">Unidades</h2>${table([
    { h: 'Unidad', v: (v) => html`<strong>${v.plate}</strong><br><span class="small muted">${v.kind}</span>` },
    { h: 'Estado', v: (v) => html`${chip(v.availability.status)}${v.availability.immobilization ? html`<br><span class="small">${v.availability.immobilization.reason}</span>` : ''}` },
    { h: 'Reservas', v: (v) => res(v.availability.reservations) },
  ], vehicles, { onRow: (v) => `/${state.workspace}/unidad/${v.id}` })}</div>
      <div class="card"><h2 style="margin-top:0">Conductores</h2>${table([
    { h: 'Conductor', v: (d) => html`<strong>${d.name}</strong><br><span class="small muted">${d.phone || ''}</span>` },
    { h: 'Estado', v: (d) => html`${chip(d.status)}${d.current_trip ? html`<br><span class="small">${d.current_trip.code}</span>` : ''}` },
    { h: 'Reservas', v: (d) => res(d.reservations) },
  ], drivers)}</div>
    </div>`);
}
