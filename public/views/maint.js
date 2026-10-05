// Espacio de mantenimiento: taller, órdenes de trabajo, inspecciones.
import { api, html, render, state, money, dt, num, chip, table, bind, modal, reasonField, act, label, can, navigate } from '../lib.js';

const ws = () => state.workspace;
const woTable = (rows, empty) => table([
  { h: '#', v: (w) => w.id }, { h: 'Unidad', v: (w) => w.vehicle.plate }, { h: 'Trabajo', v: (w) => w.title }, { h: 'Tipo', v: (w) => w.kind },
  { h: 'Estado', v: (w) => chip(w.status) }, { h: 'Presupuesto', v: (w) => chip(w.budget_status) },
  ...(can('maintenance.view_costs') ? [{ h: 'Costo', cls: 'right', v: (w) => money(w.total_cost) }] : []),
  { h: 'Fecha', v: (w) => w.entered_at ? `Ingreso ${dt(w.entered_at)}` : w.scheduled_date || dt(w.created_at) },
], rows, { onRow: (w) => `/${ws()}/orden/${w.id}`, empty });

export async function workshop(el) {
  const d = await api('GET', '/api/dashboard/maintenance');
  render(el, html`<h1>Taller</h1>
    ${d.pending_evaluation.length ? html`<div class="card"><h2 style="margin-top:0">Fallas por evaluar</h2>${woTable(d.pending_evaluation)}</div>` : ''}
    <div class="card"><h2 style="margin-top:0">Unidades en taller</h2>${woTable(d.in_workshop, 'Ninguna unidad en taller')}</div>
    <div class="grid-2">
      <div class="card"><h2 style="margin-top:0">Unidades inmovilizadas</h2>${table([{ h: 'Unidad', v: (v) => v.plate }, { h: 'Motivo', v: (v) => v.availability.immobilization.reason },
        { h: 'Desde', v: (v) => dt(v.availability.immobilization.since) }], d.immobilized, { onRow: (v) => `/${ws()}/unidad/${v.id}`, empty: 'Ninguna' })}</div>
      <div class="card"><h2 style="margin-top:0">Servicios próximos</h2>${table([{ h: 'Unidad', v: (v) => v.plate }, { h: 'Km actual', cls: 'right', v: (v) => (v.kind === 'tractor' ? num(v.odometer) : '—') },
        { h: 'Próximo', v: (v) => `${v.next_service_km ? num(v.next_service_km) + ' km' : ''} ${v.next_service_date || ''}` }, { h: 'Reservas', v: (v) => v.availability.reservations.map((r) => r.code).join(', ') || '—' }],
      d.service_due, { onRow: (v) => `/${ws()}/unidad/${v.id}`, empty: 'Sin servicios próximos' })}</div>
    </div>
    <div class="card"><h2 style="margin-top:0">Intervenciones programadas</h2>${woTable(d.scheduled, 'Sin intervenciones programadas')}</div>`);
}

export async function orders(el) {
  const rows = await api('GET', '/api/work-orders');
  render(el, html`<div class="split"><h1>Órdenes de trabajo</h1>${can('maintenance.manage') ? html`<button class="btn primary" data-act="new">+ Nueva orden</button>` : ''}</div>
    <div class="card">${woTable(rows)}</div>`);
  bind(el, {
    new: async () => {
      const vs = await api('GET', '/api/vehicles');
      const r = await modal('Nueva orden de trabajo', html`<div class="field"><label>Unidad</label><select name="vehicle_id">${vs.map((v) => html`<option value="${v.id}">${v.plate} (${label(v.availability.status)})</option>`)}</select></div>
        <div class="field"><label>Título</label><input name="title" required></div>
        <div class="row"><div class="field"><label>Tipo</label><select name="kind"><option value="preventivo">Preventivo</option><option value="correctivo">Correctivo</option></select></div>
        <div class="field"><label>Fecha programada</label><input type="date" name="scheduled_date"></div></div>
        <p class="small muted">Consulte la programación de viajes para coordinar la intervención.</p>`, { onSubmit: (d) => api('POST', '/api/work-orders', d) });
      if (r?.id) navigate(`/${ws()}/orden/${r.id}`);
    },
  });
}

export async function orderDetail(el, id) {
  const w = await api('GET', `/api/work-orders/${id}`);
  const open = ['programado', 'pendiente_evaluacion', 'en_taller'].includes(w.status);
  const manage = can('maintenance.manage');
  render(el, html`<p><a href="#/${ws()}/${ws() === 'mantenimiento' ? 'ordenes' : 'flota'}">← Órdenes</a></p>
    <div class="split"><div><h1>OT #${w.id} · ${w.title}</h1>${chip(w.status)} ${chip(w.budget_status)}</div>
      <div class="actions">${manage && open ? html`
        ${['programado', 'pendiente_evaluacion'].includes(w.status) ? html`<button class="btn" data-act="enter">Registrar ingreso a taller</button>` : ''}
        ${['en_taller', 'pendiente_evaluacion'].includes(w.status) ? html`<button class="btn primary" data-act="exit">${w.status === 'en_taller' ? 'Registrar salida de taller' : 'Cerrar evaluación'}</button>` : ''}
        <button class="btn" data-act="budget">Solicitar aprobación de presupuesto</button>
        ${['programado', 'pendiente_evaluacion'].includes(w.status) ? html`<button class="btn danger" data-act="cancel">Cancelar</button>` : ''}` : ''}
        <a class="btn" href="#/${ws()}/unidad/${w.vehicle.id}">Unidad ${w.vehicle.plate}</a></div></div>
    ${w.budget_status === 'pendiente' ? html`<div class="notice warn">Presupuesto pendiente de aprobación. Una solicitud pendiente no es una autorización; la aprueba un responsable distinto de quien la solicita.</div>` : ''}
    ${w.budget_status === 'excedido' ? html`<div class="notice bad">El costo superó el presupuesto aprobado: solicite una nueva aprobación.</div>` : ''}
    ${!open ? html`<div class="notice">Orden cerrada: sus costos no se modifican.</div>` : ''}
    <form class="card" id="wf">
      <div class="field"><label>Diagnóstico</label><textarea name="diagnosis" ${open && manage ? '' : 'disabled'}>${w.diagnosis || ''}</textarea></div>
      <div class="field"><label>Trabajos realizados</label><textarea name="works" ${open && manage ? '' : 'disabled'}>${w.works || ''}</textarea></div>
      ${w.total_cost !== undefined ? html`<h3>Repuestos</h3>
      <div id="parts">${(w.parts.length ? w.parts : [{ name: '', qty: 1, unit_cost: 0 }]).map((p) => partRow(p, open && manage))}</div>
      ${open && manage ? html`<button type="button" class="btn small" data-act="addpart">+ Repuesto</button>` : ''}
      <div class="row" style="margin-top:10px"><div class="field"><label>Mano de obra</label><input type="number" step="0.01" min="0" name="labor_cost" value="${w.labor_cost}" ${open && manage ? '' : 'disabled'}></div>
        <div class="field"><label>Total</label><input disabled value="${money(w.total_cost)}"></div>
        <div class="field"><label>Presupuesto</label><input disabled value="${money(w.budget_amount)}"></div></div>` : ''}
      ${open && manage ? html`<button class="btn primary">Guardar</button>` : ''}
    </form>
    <p class="small muted">Creada por ${w.created_by.name} · ${dt(w.created_at)}${w.entered_at ? ` · Ingreso ${dt(w.entered_at)}` : ''}${w.exited_at ? ` · Salida ${dt(w.exited_at)}` : ''}</p>`);
  const reload = () => orderDetail(el, id);
  const f = el.querySelector('#wf');
  f.onsubmit = async (e) => {
    e.preventDefault();
    const parts = [...f.querySelectorAll('.part')].map((r) => ({ name: r.querySelector('[name=pn]').value, qty: Number(r.querySelector('[name=pq]').value), unit_cost: Number(r.querySelector('[name=pc]').value) }));
    const body = { diagnosis: f.diagnosis.value, works: f.works.value };
    if (f.labor_cost) Object.assign(body, { parts, labor_cost: Number(f.labor_cost.value) });
    if (await act(() => api('PATCH', `/api/work-orders/${w.id}`, body), 'Orden actualizada')) reload();
  };
  bind(el, {
    addpart: () => { el.querySelector('#parts').insertAdjacentHTML('beforeend', partRow({ name: '', qty: 1, unit_cost: 0 }, true).s); },
    enter: async () => { if (await act(() => api('POST', `/api/work-orders/${w.id}/enter`, {}), 'Ingreso registrado')) reload(); },
    exit: async () => { if (await modal('Cerrar intervención', html`<div class="field"><label>Observaciones</label><textarea name="notes"></textarea></div><p class="small muted">La liberación técnica de la unidad se registra aparte, desde la ficha de la unidad.</p>`, { onSubmit: (d) => api('POST', `/api/work-orders/${w.id}/exit`, d) })) reload(); },
    budget: async () => { if (await modal('Solicitar aprobación de presupuesto', html`<div class="field"><label>Monto</label><input type="number" step="0.01" min="0.01" name="amount" required value="${w.total_cost || ''}"></div>${reasonField('Detalle / justificación')}`, { submitLabel: 'Solicitar', onSubmit: (d) => api('POST', `/api/work-orders/${w.id}/budget`, d) })) reload(); },
    cancel: async () => { if (await modal('Cancelar orden', reasonField(), { danger: true, submitLabel: 'Cancelar orden', onSubmit: (d) => api('POST', `/api/work-orders/${w.id}/cancel`, d) })) reload(); },
  });
}

const partRow = (p, editable) => html`<div class="row part"><div class="field"><input name="pn" placeholder="Repuesto" value="${p.name}" ${editable ? '' : 'disabled'}></div>
  <div class="field"><input name="pq" type="number" step="0.01" min="0" value="${p.qty}" ${editable ? '' : 'disabled'} aria-label="Cantidad"></div>
  <div class="field"><input name="pc" type="number" step="0.01" min="0" value="${p.unit_cost}" ${editable ? '' : 'disabled'} aria-label="Costo unitario"></div></div>`;

export async function inspections(el) {
  const [ins, inc] = await Promise.all([api('GET', '/api/inspections'), api('GET', '/api/incidents')]);
  render(el, html`<h1>Inspecciones e incidencias mecánicas</h1>
    <div class="card"><h2 style="margin-top:0">Incidencias mecánicas</h2>${table([{ h: 'Fecha', v: (i) => dt(i.created_at) }, { h: 'Unidad', v: (i) => i.vehicle?.plate || '—' },
      { h: 'Viaje', v: (i) => i.trip?.code || '—' }, { h: 'Severidad', v: (i) => chip(i.severity) }, { h: 'Descripción', v: (i) => i.description }, { h: 'Estado', v: (i) => chip(i.status) }],
    inc, { empty: 'Sin incidencias mecánicas' })}</div>
    <div class="card"><h2 style="margin-top:0">Inspecciones previas</h2>${table([{ h: 'Fecha', v: (i) => dt(i.created_at) }, { h: 'Unidad', v: (i) => i.plate },
      { h: 'Viaje', v: (i) => i.trip_code }, { h: 'Conductor', v: (i) => i.driver },
      { h: 'Resultado', v: (i) => chip(i.result === 'aprobada' ? 'aprobada_insp' : i.result, i.result === 'aprobada' ? 'Aprobada' : label(i.result)) },
      { h: 'Fallas', v: (i) => Object.entries(i.items).filter(([, v]) => v === 'falla').map(([k]) => k).join(', ') || '—' },
      { h: 'Fotos', v: (i) => i.photo_ids.map((p) => html`<a href="/api/files/${p}" target="_blank" rel="noopener">${p}</a> `) }], ins)}</div>`);
}
