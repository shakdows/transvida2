// Espacio de administración / finanzas.
import { api, html, render, money, dt, tripChip, table, bind, toLocalInput, fromLocalInput } from '../lib.js';
import { expenseTable, bindExpenseActions } from './common.js';

const kpi = (v, l, alert) => html`<div class="kpi ${alert && v ? 'alert' : ''}"><div class="v">${v}</div><div class="l">${l}</div></div>`;

export async function home(el) {
  const [d, toValidate] = await Promise.all([api('GET', '/api/dashboard/finance'), api('GET', '/api/expenses?validation_status=pendiente')]);
  render(el, html`<h1>Pendientes de finanzas</h1>
    <div class="grid">${kpi(d.expenses_to_validate, 'Gastos por validar', true)}${kpi(d.expenses_awaiting_approval, 'Esperando aprobación de gerencia')}
      ${kpi(d.possible_duplicates, 'Posibles duplicados', true)}${kpi(d.trips_pending_close.length, 'Viajes pendientes de cierre financiero', true)}</div>
    <h2>Viajes pendientes de cierre financiero</h2>
    <div class="card">${table([{ h: 'Viaje', v: (t) => html`<strong>${t.code}</strong>` }, { h: 'Cliente', v: (t) => t.client?.name || '—' },
      { h: 'Cierre operativo', v: (t) => dt(t.ops_closed_at) }, { h: 'Ingreso', cls: 'right', v: (t) => money(t.revenue_agreed) },
      { h: 'Costos', cls: 'right', v: (t) => money(t.costs.total) }, { h: 'Pendiente', cls: 'right', v: (t) => money(t.costs.expenses_pending) },
      { h: 'Margen', cls: 'right', v: (t) => money(t.margin) }], d.trips_pending_close, { onRow: (t) => `/finanzas/viaje/${t.id}`, empty: 'Sin viajes pendientes' })}</div>
    <h2>Gastos por validar</h2>
    <div class="card">${expenseTable(toValidate)}</div>`);
  bindExpenseActions(el, () => home(el));
}

export async function results(el) {
  const d = await api('GET', '/api/dashboard/finance');
  render(el, html`<h1>Resultados económicos</h1>
    <div class="card">${table([{ h: 'Viaje', v: (t) => t.code }, { h: 'Cliente', v: (t) => t.client?.name || '—' }, { h: 'Cierre', v: (t) => dt(t.fin_closed_at) },
      { h: 'Ingreso', cls: 'right', v: (t) => money(t.fin_revenue) }, { h: 'Costo', cls: 'right', v: (t) => money(t.fin_cost) },
      { h: 'Margen', cls: 'right', v: (t) => money(t.fin_margin) }, { h: 'Ajustes', cls: 'right', v: (t) => money(t.costs.adjustments) },
      { h: 'Margen ajustado', cls: 'right', v: (t) => html`<strong>${money(t.adjusted_margin)}</strong>` }, { h: 'Estado', v: (t) => tripChip(t) }],
    d.recently_closed, { onRow: (t) => `/finanzas/viaje/${t.id}`, empty: 'Sin cierres financieros' })}</div>`);
  bind(el, {});
}

export async function exports(el) {
  const from = toLocalInput(new Date(Date.now() - 30 * 86400e3).toISOString());
  const to = toLocalInput(new Date().toISOString());
  render(el, html`<h1>Exportar para conciliación</h1>
    <form class="card" id="f"><div class="row"><div class="field"><label>Desde</label><input type="datetime-local" name="from" value="${from}"></div>
      <div class="field"><label>Hasta</label><input type="datetime-local" name="to" value="${to}"></div></div>
      <div class="actions"><button class="btn primary" name="r" value="expenses">Gastos y comprobantes (CSV)</button><button class="btn" name="r" value="trips">Viajes y resultados (CSV)</button></div>
      <p class="small muted">Cada exportación queda registrada en el historial.</p></form>`);
  const f = el.querySelector('#f');
  f.onsubmit = (e) => {
    e.preventDefault();
    const r = e.submitter?.value || 'expenses';
    location.href = `/api/reports/${r}.csv?from=${encodeURIComponent(fromLocalInput(f.from.value))}&to=${encodeURIComponent(fromLocalInput(f.to.value))}`;
  };
}
