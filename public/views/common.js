// Vistas compartidas entre espacios de trabajo. Los botones se muestran según permisos,
// pero el servidor vuelve a validar cada acción y el alcance de cada registro.
import { api, html, render, can, state, money, dt, num, chip, tripChip, table, bind, modal, reasonField, act,
  toLocalInput, fromLocalInput, navigate, label } from '../lib.js';

const ws = () => state.workspace;

// ---------- Viajes ----------
export async function tripList(el) {
  const filter = new URLSearchParams(location.hash.split('?')[1] || '');
  const q = filter.get('estado') || 'activos';
  const trips = await api('GET', `/api/trips${q === 'activos' ? '?active=1' : ''}`);
  const money_ = can('finance.view_revenue');
  render(el, html`<div class="split"><h1>Viajes</h1>
    <div class="actions">
      <select id="flt" style="width:auto"><option value="activos" ${q === 'activos' ? 'selected' : ''}>Activos</option><option value="todos" ${q === 'todos' ? 'selected' : ''}>Todos</option></select>
      ${can('trips.create') ? html`<button class="btn primary" data-act="new">+ Nuevo viaje</button>` : ''}
    </div></div>
    <div class="card">${table([
    { h: 'Código', v: (t) => html`<strong>${t.code}</strong>` },
    { h: 'Cliente', v: (t) => t.client?.name || '—' },
    { h: 'Ruta', v: (t) => `${t.origin} → ${t.destination}` },
    { h: 'Programado', v: (t) => html`<span class="nowrap">${dt(t.scheduled_start)}</span>` },
    { h: 'Unidad', v: (t) => [t.vehicle?.plate, t.trailer?.plate].filter(Boolean).join(' + ') || '—' },
    { h: 'Conductor', v: (t) => t.driver?.name || '—' },
    { h: 'Estado', v: (t) => tripChip(t) },
    ...(money_ ? [{ h: 'Margen', cls: 'right', v: (t) => money(t.fin_margin ?? t.margin) }] : []),
  ], trips, { onRow: (t) => `/${ws()}/viaje/${t.id}` })}</div>`);
  el.querySelector('#flt').onchange = (e) => navigate(`/${ws()}/viajes?estado=${e.target.value}`);
  bind(el, { new: () => newTrip() });
}

export async function newTrip() {
  const [clients, vehicles, drivers] = await Promise.all([api('GET', '/api/clients'), api('GET', '/api/vehicles'), api('GET', '/api/drivers')]);
  const t = await modal('Nuevo viaje', html`
    <div class="field"><label>Cliente</label><select name="client_id"><option value="">—</option>${clients.map((c) => html`<option value="${c.id}">${c.name}</option>`)}</select></div>
    <div class="row"><div class="field"><label>Origen</label><input name="origin" required></div><div class="field"><label>Destino</label><input name="destination" required></div></div>
    <div class="row"><div class="field"><label>Inicio programado</label><input type="datetime-local" name="scheduled_start" required></div>
      <div class="field"><label>Fin programado</label><input type="datetime-local" name="scheduled_end" required></div></div>
    <div class="field"><label>Carga</label><input name="cargo"></div>
    <div class="field"><label>Instrucciones para el conductor</label><textarea name="instructions"></textarea></div>
    <h3>Asignación (opcional)</h3>
    ${resourceSelects(vehicles, drivers, {})}`, {
    submitLabel: 'Crear viaje',
    onSubmit: (d) => api('POST', '/api/trips', {
      ...clean(d), scheduled_start: fromLocalInput(d.scheduled_start), scheduled_end: fromLocalInput(d.scheduled_end),
    }),
  });
  if (t?.id) navigate(`/${ws()}/viaje/${t.id}`);
}

const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== ''));

function resourceSelects(vehicles, drivers, cur) {
  const opt = (v, selected) => {
    const st = v.availability.status;
    const blocked = ['inmovilizado', 'en_taller'].includes(st);
    return html`<option value="${v.id}" ${selected === v.id ? 'selected' : ''} ${blocked ? 'disabled' : ''}>${v.plate} — ${v.brand} ${v.model} (${label(st)}${blocked && v.availability.immobilization ? ': ' + v.availability.immobilization.reason : ''})</option>`;
  };
  return html`
    <div class="field"><label>Vehículo (tractor)</label><select name="vehicle_id"><option value="">—</option>${vehicles.filter((v) => v.kind === 'tractor').map((v) => opt(v, cur.vehicle))}</select></div>
    <div class="field"><label>Remolque</label><select name="trailer_id"><option value="">—</option>${vehicles.filter((v) => v.kind === 'remolque').map((v) => opt(v, cur.trailer))}</select></div>
    <div class="field"><label>Conductor</label><select name="driver_id"><option value="">—</option>${drivers.map((d) => html`<option value="${d.id}" ${cur.driver === d.id ? 'selected' : ''}>${d.name} (${label(d.status)})</option>`)}</select></div>
    <p class="small muted">Las unidades inmovilizadas o en taller no se pueden asignar. Esta restricción técnica no se levanta con aprobaciones.</p>`;
}

export async function tripDetail(el, id) {
  const t = await api('GET', `/api/trips/${id}`);
  const st = t.status;
  const preStart = ['programado', 'asignado', 'confirmado', 'inspeccion_aprobada', 'bloqueado'].includes(st);
  const [exp, inc] = await Promise.all([
    can('expenses.view_all') ? api('GET', `/api/expenses?trip_id=${t.id}`) : Promise.resolve(null),
    can('incidents.view_all') || can('incidents.view_mechanical') ? api('GET', `/api/incidents?trip_id=${t.id}`) : Promise.resolve(null),
  ]);
  const evLabel = { confirmacion: 'Asignación confirmada', salida: 'Salida', llegada_carga: 'Llegada al punto de carga', inicio_traslado: 'Inicio de traslado',
    llegada_destino: 'Llegada al destino', fin_servicio: 'Conductor reportó fin del servicio', solicitud_cierre: 'Conductor solicitó cierre operativo',
    cierre_operativo: 'Operaciones validó cierre', cierre_observado: 'Cierre observado por operaciones', correccion: 'Corrección registrada' };

  render(el, html`
    <p><a href="#/${ws()}/viajes">← Viajes</a></p>
    <div class="split"><div><h1>${t.code}</h1><div>${tripChip(t)}</div></div>
      <div class="actions">
        ${can('trips.assign') && preStart ? html`<button class="btn primary" data-act="assign">Asignar recursos</button>` : ''}
        ${can('trips.reschedule') && preStart ? html`<button class="btn" data-act="reschedule">Reprogramar</button><button class="btn danger" data-act="cancel">Cancelar</button>` : ''}
        ${can('approvals.request') && can('trips.assign') && preStart ? html`<button class="btn" data-act="exception">Solicitar excepción</button>` : ''}
        ${can('trips.validate_close') && ['fin_reportado', 'cierre_solicitado'].includes(st) ? html`<button class="btn primary" data-act="close">Validar cierre operativo</button>` : ''}
        ${can('trips.validate_close') && st === 'cierre_solicitado' ? html`<button class="btn" data-act="rejectclose">Observar cierre</button>` : ''}
        ${can('trips.set_revenue') && st !== 'cerrado_financiero' ? html`<button class="btn" data-act="revenue">Ingreso y presupuesto</button>` : ''}
        ${can('finance.adjust') ? html`<button class="btn" data-act="cost">${st === 'cerrado_financiero' ? 'Registrar ajuste' : 'Costo asignado'}</button>` : ''}
        ${can('trips.financial_close') && st === 'cerrado_operativo' ? html`<button class="btn primary" data-act="finclose">Cierre financiero</button>` : ''}
      </div></div>
    ${st === 'bloqueado' ? html`<div class="notice bad">Inicio bloqueado por falla crítica en la inspección previa. La unidad fue derivada a mantenimiento. La asignación se mantiene: tras la liberación técnica el conductor repite la inspección, u operaciones puede reasignar otra unidad.</div>` : ''}
    ${st === 'cerrado_operativo' ? html`<div class="notice ok">Cierre operativo validado: vehículo, remolque y conductor quedaron liberados. ${can('trips.financial_close') ? 'Pendiente de cierre financiero.' : ''}</div>` : ''}
    <div class="grid-2">
      <div class="card"><h2 style="margin-top:0">Servicio</h2>
        <p><strong>${t.origin}</strong> → <strong>${t.destination}</strong></p>
        <p>Cliente: ${t.client?.name || '—'}<br>Carga: ${t.cargo || '—'}</p>
        <p>Programado: ${dt(t.scheduled_start)} — ${dt(t.scheduled_end)}</p>
        <p>Instrucciones: ${t.instructions || '—'}</p>
        <p>Vehículo: ${t.vehicle ? html`<a href="#/${ws()}/unidad/${t.vehicle.id}">${t.vehicle.plate}</a>` : '—'} · Remolque: ${t.trailer?.plate || '—'}<br>
           Conductor: ${t.driver ? `${t.driver.name} (${t.driver.phone || 's/teléfono'})` : '—'}<br>Coordinador: ${t.coordinator?.name || '—'}</p>
        <p>Km inicial: ${num(t.km_start)} · Km final: ${num(t.km_end)}${t.km_end && t.km_start ? ` · Recorrido: ${num(t.km_end - t.km_start)} km` : ''}</p>
        ${t.cancel_reason ? html`<p class="notice warn">Cancelado: ${t.cancel_reason}</p>` : ''}
      </div>
      ${t.costs ? html`<div class="card"><h2 style="margin-top:0">Resultado económico</h2>
        <table>
          ${t.revenue_agreed !== undefined ? html`<tr><td>Ingreso acordado</td><td class="right">${money(t.revenue_agreed)}</td></tr>` : ''}
          <tr><td>Presupuesto de costos</td><td class="right">${money(t.budget_cost)}</td></tr>
          <tr><td>Gastos validados</td><td class="right">${money(t.costs.expenses_validated)}</td></tr>
          <tr><td>Gastos pendientes</td><td class="right">${money(t.costs.expenses_pending)}</td></tr>
          <tr><td>Costos asignados</td><td class="right">${money(t.costs.allocated)}</td></tr>
          ${t.costs.adjustments ? html`<tr><td>Ajustes posteriores al cierre</td><td class="right">${money(t.costs.adjustments)}</td></tr>` : ''}
          ${t.margin !== undefined ? html`<tr><th>Margen actual</th><th class="right">${money(t.margin)}</th></tr>` : ''}
          ${t.fin_margin !== undefined ? html`<tr><th>Margen al cierre financiero</th><th class="right">${money(t.fin_margin)}</th></tr>
            <tr><td>Margen ajustado</td><td class="right">${money(t.adjusted_margin)}</td></tr>` : ''}
        </table>
        ${t.cost_entries?.length ? html`<h3>Costos asignados y ajustes</h3>${table([{ h: 'Tipo', v: (c) => c.kind }, { h: 'Concepto', v: (c) => c.concept },
          { h: 'Monto', cls: 'right', v: (c) => money(c.amount) }, { h: 'Motivo', v: (c) => c.reason || '—' }, { h: 'Registró', v: (c) => `${c.created_by_name} · ${dt(c.created_at)}` }], t.cost_entries)}` : ''}
      </div>` : ''}
    </div>
    <div class="grid-2">
      <div class="card"><h2 style="margin-top:0">Avances reportados</h2>
        ${t.events.length ? html`<ul class="timeline">${t.events.map((e) => html`<li><strong>${evLabel[e.type] || e.type}</strong> <span class="muted small">${dt(e.at)} · ${e.user_name}</span>
          ${e.odometer ? html`<br><span class="small">Km ${num(e.odometer)}</span>` : ''}${e.notes ? html`<br><span class="small">${fmtNotes(e)}</span>` : ''}
          ${can('trips.correct_event') && !['cerrado_operativo', 'cerrado_financiero'].includes(st) && e.type !== 'correccion' ? html` <button class="btn ghost small" data-act="correct" data-ev="${e.id}">Corregir</button>` : ''}</li>`)}</ul>` : html`<p class="muted">Sin avances reportados.</p>`}
        ${t.inspections.length ? html`<h3>Inspecciones previas</h3>${t.inspections.map((i) => html`<p>${chip(i.result === 'aprobada' ? 'aprobada_insp' : i.result, label(i.result === 'aprobada' ? 'Aprobada' : i.result))} ${dt(i.created_at)}
          ${Object.entries(i.items).filter(([, v]) => v === 'falla').length ? html`<br><span class="small">Fallas: ${Object.entries(i.items).filter(([, v]) => v === 'falla').map(([k]) => k).join(', ')}</span>` : ''}
          ${i.notes ? html`<br><span class="small">${i.notes}</span>` : ''}
          <br>${i.photo_ids.map((p) => html`<a href="/api/files/${p}" target="_blank" rel="noopener" class="small">Foto ${p}</a> `)}</p>`)}` : ''}
      </div>
      <div>
        ${exp ? html`<div class="card"><h2 style="margin-top:0">Gastos</h2>${expenseTable(exp)}</div>` : ''}
        ${inc ? html`<div class="card"><h2 style="margin-top:0">Incidencias</h2>${table([{ h: 'Tipo', v: (i) => label(i.type) }, { h: 'Severidad', v: (i) => chip(i.severity) },
          { h: 'Descripción', v: (i) => i.description }, { h: 'Estado', v: (i) => chip(i.status) }], inc)}</div>` : ''}
      </div>
    </div>`);
  bindExpenseActions(el, () => tripDetail(el, id));

  const reload = () => tripDetail(el, id);
  bind(el, {
    assign: async () => {
      const [vehicles, drivers] = await Promise.all([api('GET', '/api/vehicles'), api('GET', '/api/drivers')]);
      const r = await modal('Asignar recursos', html`${resourceSelects(vehicles, drivers, { vehicle: t.vehicle?.id, trailer: t.trailer?.id, driver: t.driver?.id })}
        <p class="small muted">Cambiar recursos exige una nueva confirmación del conductor.</p>`, {
        onSubmit: (d) => api('POST', `/api/trips/${t.id}/assign`, { vehicle_id: d.vehicle_id, trailer_id: d.trailer_id || null, driver_id: d.driver_id }),
      });
      if (r) reload();
    },
    reschedule: async () => {
      const r = await modal('Reprogramar servicio', html`<div class="row"><div class="field"><label>Inicio</label><input type="datetime-local" name="s" value="${toLocalInput(t.scheduled_start)}" required></div>
        <div class="field"><label>Fin</label><input type="datetime-local" name="e" value="${toLocalInput(t.scheduled_end)}" required></div></div>${reasonField()}`, {
        onSubmit: (d) => api('POST', `/api/trips/${t.id}/reschedule`, { scheduled_start: fromLocalInput(d.s), scheduled_end: fromLocalInput(d.e), reason: d.reason }),
      });
      if (r) reload();
    },
    cancel: async () => { if (await modal('Cancelar servicio', reasonField(), { danger: true, submitLabel: 'Cancelar servicio', onSubmit: (d) => api('POST', `/api/trips/${t.id}/cancel`, d) })) reload(); },
    exception: async () => {
      const r = await modal('Solicitar excepción operativa', html`<div class="field"><label>Tipo</label><select name="subtype">${state.config.exception_types.map((x) => html`<option value="${x.code}">${x.label}</option>`)}</select></div>
        ${reasonField()}<p class="small muted">La excepción queda pendiente hasta que la autorice un responsable distinto de usted. Las restricciones técnicas (unidad inmovilizada) no admiten excepción.</p>`, {
        submitLabel: 'Solicitar', onSubmit: (d) => api('POST', `/api/trips/${t.id}/exceptions`, d),
      });
      if (r) reload();
    },
    close: async () => { if (await modal('Validar cierre operativo', html`<div class="field"><label>Observaciones</label><textarea name="notes"></textarea></div><p class="small muted">Se liberarán vehículo, remolque y conductor. El cierre financiero lo realiza finanzas.</p>`, { submitLabel: 'Validar cierre', onSubmit: (d) => api('POST', `/api/trips/${t.id}/validate-close`, d) })) reload(); },
    rejectclose: async () => { if (await modal('Observar solicitud de cierre', reasonField('Qué debe corregir el conductor'), { onSubmit: (d) => api('POST', `/api/trips/${t.id}/reject-close`, d) })) reload(); },
    correct: async (ds) => {
      const r = await modal('Registrar corrección', html`<p class="small muted">El evento original no se modifica: la corrección queda registrada aparte.</p>
        <div class="field"><label>Fecha/hora correcta (opcional)</label><input type="datetime-local" name="at"></div>
        <div class="field"><label>Kilometraje correcto (opcional)</label><input type="number" name="odometer" min="0"></div>${reasonField()}`, {
        onSubmit: (d) => api('POST', `/api/trips/${t.id}/corrections`, { event_id: ds.ev, reason: d.reason, odometer: d.odometer, corrected_at: fromLocalInput(d.at) }),
      });
      if (r) reload();
    },
    revenue: async () => {
      const r = await modal('Ingreso acordado y presupuesto', html`<div class="row"><div class="field"><label>Ingreso acordado</label><input type="number" step="0.01" min="0" name="revenue_agreed" value="${t.revenue_agreed ?? ''}"></div>
        <div class="field"><label>Presupuesto de costos</label><input type="number" step="0.01" min="0" name="budget_cost" value="${t.budget_cost ?? ''}"></div></div>
        <div class="field"><label>Comentario</label><input name="reason"></div>`, {
        onSubmit: (d) => api('POST', `/api/trips/${t.id}/revenue`, clean(d)),
      });
      if (r) reload();
    },
    cost: async () => {
      const after = st === 'cerrado_financiero';
      const r = await modal(after ? 'Registrar ajuste posterior al cierre' : 'Registrar costo asignado', html`
        ${after ? html`<p class="notice warn">El viaje tiene cierre financiero. El ajuste se registra aparte, con motivo, sin modificar el cierre.</p>` : ''}
        <div class="row"><div class="field"><label>Concepto</label><input name="concept" required></div><div class="field"><label>Monto (negativo para reducir)</label><input type="number" step="0.01" name="amount" required></div></div>
        ${after ? reasonField() : html`<div class="field"><label>Detalle</label><input name="reason"></div>`}`, {
        onSubmit: (d) => api('POST', `/api/trips/${t.id}/costs`, d),
      });
      if (r) reload();
    },
    finclose: async () => { if (await modal('Cierre financiero', html`<p>Se fijarán ingreso, costo y margen del viaje. Las correcciones posteriores se registrarán como ajustes.</p><div class="field"><label>Observaciones</label><textarea name="notes"></textarea></div>`, { submitLabel: 'Cerrar financieramente', onSubmit: (d) => api('POST', `/api/trips/${t.id}/financial-close`, d) })) reload(); },
  });
}

function fmtNotes(e) {
  if (e.type !== 'correccion') return e.notes;
  try { const n = JSON.parse(e.notes); return `Corrige «${n.event_type}» (#${n.event_id})${n.corrected_at ? ' → ' + dt(n.corrected_at) : ''}: ${n.reason}`; } catch { return e.notes; }
}

// ---------- Gastos ----------
export function expenseTable(rows) {
  return table([
    { h: '#', v: (e) => e.id },
    { h: 'Viaje', v: (e) => e.trip ? html`<a href="#/${ws()}/viaje/${e.trip.id}">${e.trip.code}</a>` : '—' },
    { h: 'Categoría', v: (e) => label(e.category) },
    { h: 'Monto', cls: 'right', v: (e) => money(e.amount) },
    { h: 'Comprobante', v: (e) => html`${e.supplier || ''} ${e.receipt_number || ''} ${e.receipt_file_id ? html`<a href="/api/files/${e.receipt_file_id}" target="_blank" rel="noopener">ver</a>` : ''}
      ${e.possible_duplicate_of ? html`<br><span class="chip bad">Posible duplicado de #${e.possible_duplicate_of}</span>` : ''}` },
    { h: 'Aprobación', v: (e) => e.extraordinary ? chip(e.approval_status) : html`<span class="muted small">Ordinario</span>` },
    { h: 'Validación', v: (e) => html`${chip(e.validation_status)}${e.validation_reason ? html`<br><span class="small">${e.validation_reason}</span>` : ''}` },
    { h: 'Registró', v: (e) => html`<span class="small">${e.created_by.name}<br>${dt(e.created_at)}</span>` },
    ...(can('expenses.validate') ? [{ h: '', v: (e) => e.validation_status === 'pendiente' && e.created_by.id !== state.me.id
      ? (e.approval_status === 'pendiente' ? html`<span class="small muted">Esperando aprobación</span>`
        : html`<button class="btn small" data-act="val" data-id="${e.id}">Validar</button> <button class="btn small danger" data-act="rej" data-id="${e.id}">Rechazar</button>`) : '' }] : []),
  ], rows);
}

export function bindExpenseActions(el, reload) {
  bind(el, {
    val: async (ds) => { if (await act(() => api('POST', `/api/expenses/${ds.id}/validate`, { decision: 'validado' }), 'Gasto validado')) reload(); },
    rej: async (ds) => { if (await modal('Rechazar gasto', html`${reasonField('Motivo del rechazo')}<p class="small muted">El gasto se conserva con estado «rechazado» y este motivo.</p>`, { danger: true, submitLabel: 'Rechazar', onSubmit: (d) => api('POST', `/api/expenses/${ds.id}/validate`, { decision: 'rechazado', reason: d.reason }) })) reload(); },
  });
}

export async function expenses(el) {
  const f = new URLSearchParams(location.hash.split('?')[1] || '');
  const st = f.get('estado') || 'pendiente';
  const qs = st === 'duplicados' ? 'duplicates=1' : st === 'todos' ? '' : `validation_status=${st}`;
  const rows = await api('GET', `/api/expenses?${qs}`);
  render(el, html`<div class="split"><h1>Gastos</h1><select id="flt" style="width:auto">
    ${[['pendiente', 'Pendientes de validación'], ['duplicados', 'Posibles duplicados'], ['validado', 'Validados'], ['rechazado', 'Rechazados'], ['todos', 'Todos']].map(([k, l]) => html`<option value="${k}" ${k === st ? 'selected' : ''}>${l}</option>`)}
    </select></div>
    ${!can('expenses.validate') ? html`<p class="notice">Revise los gastos reportados. La validación y el rechazo los realiza finanzas; los extraordinarios requieren aprobación de gerencia.</p>` : ''}
    <div class="card">${expenseTable(rows)}</div>`);
  el.querySelector('#flt').onchange = (e) => navigate(`/${ws()}/gastos?estado=${e.target.value}`);
  bindExpenseActions(el, () => expenses(el));
}

// ---------- Incidencias ----------
export async function incidents(el) {
  const rows = await api('GET', '/api/incidents');
  render(el, html`<div class="split"><h1>Incidencias</h1>${can('incidents.report_any') ? html`<button class="btn" data-act="new">+ Registrar incidencia</button>` : ''}</div>
    <div class="card">${table([
    { h: '#', v: (i) => i.id }, { h: 'Viaje', v: (i) => i.trip ? html`<a href="#/${ws()}/viaje/${i.trip.id}">${i.trip.code}</a>` : '—' },
    { h: 'Unidad', v: (i) => i.vehicle?.plate || '—' }, { h: 'Tipo', v: (i) => label(i.type) }, { h: 'Severidad', v: (i) => chip(i.severity) },
    { h: 'Descripción', v: (i) => i.description }, { h: 'Reportó', v: (i) => html`<span class="small">${i.reported_by.name}<br>${dt(i.created_at)}</span>` },
    { h: 'Estado', v: (i) => html`${chip(i.status)}${i.resolution ? html`<br><span class="small">${i.resolution}</span>` : ''}` },
    ...(can('incidents.resolve') ? [{ h: '', v: (i) => i.status !== 'resuelta' ? html`<button class="btn small" data-act="resolve" data-id="${i.id}">Resolver</button>` : '' }] : []),
  ], rows)}</div>`);
  bind(el, {
    resolve: async (ds) => {
      const r = await modal('Resolver incidencia', html`${reasonField('Resolución', 'resolution')}
        <label style="display:flex;gap:8px;align-items:center;font-weight:400"><input type="checkbox" name="communicated_to_client" value="1" style="width:auto"> Comunicada al cliente</label>`, {
        onSubmit: (d) => api('POST', `/api/incidents/${ds.id}/resolve`, { resolution: d.resolution, communicated_to_client: !!d.communicated_to_client }),
      });
      if (r) incidents(el);
    },
    new: async () => {
      const r = await modal('Registrar incidencia', html`<div class="field"><label>Tipo</label><select name="type">${state.config.incident_types.map((x) => html`<option value="${x.code}">${x.label}</option>`)}</select></div>
        <div class="field"><label>Severidad</label><select name="severity">${['baja', 'media', 'alta', 'critica'].map((x) => html`<option value="${x}">${label(x)}</option>`)}</select></div>
        <div class="field"><label>Id de viaje (opcional)</label><input name="trip_id" type="number"></div>
        <div class="field"><label>Descripción</label><textarea name="description" required></textarea></div>`, {
        onSubmit: (d) => api('POST', '/api/incidents', clean(d)),
      });
      if (r) incidents(el);
    },
  });
}

// ---------- Flota ----------
export async function fleet(el) {
  const vs = await api('GET', '/api/vehicles');
  render(el, html`<div class="split"><h1>Flota</h1>${can('fleet.manage') ? html`<button class="btn" data-act="new">+ Nueva unidad</button>` : ''}</div>
    <div class="card">${table([
    { h: 'Placa', v: (v) => html`<strong>${v.plate}</strong>` }, { h: 'Tipo', v: (v) => v.kind },
    { h: 'Marca / modelo', v: (v) => `${v.brand || ''} ${v.model || ''} ${v.year || ''}` },
    { h: 'Km', cls: 'right', v: (v) => (v.kind === 'tractor' ? num(v.odometer) : '—') },
    { h: 'Estado', v: (v) => html`${chip(v.availability.status)}${v.availability.immobilization ? html`<br><span class="small">${v.availability.immobilization.reason}</span>` : ''}${v.availability.current_trip ? html`<br><span class="small">${v.availability.current_trip.code}</span>` : ''}` },
    { h: 'Próximo servicio', v: (v) => html`${v.next_service_km ? `${num(v.next_service_km)} km` : ''} ${v.next_service_date || ''} ${v.service_due ? html`<span class="chip warn">Próximo</span>` : ''}` },
  ], vs, { onRow: (v) => `/${ws()}/unidad/${v.id}` })}</div>`);
  bind(el, {
    new: async () => {
      const r = await modal('Nueva unidad', html`<div class="row"><div class="field"><label>Placa</label><input name="plate" required></div>
        <div class="field"><label>Tipo</label><select name="kind"><option value="tractor">Tractor</option><option value="remolque">Remolque</option></select></div></div>
        <div class="row"><div class="field"><label>Marca</label><input name="brand"></div><div class="field"><label>Modelo</label><input name="model"></div><div class="field"><label>Año</label><input name="year" type="number"></div></div>
        <div class="row"><div class="field"><label>Kilometraje</label><input name="odometer" type="number" min="0"></div><div class="field"><label>Capacidad</label><input name="capacity"></div></div>`, {
        onSubmit: (d) => api('POST', '/api/vehicles', clean(d)),
      });
      if (r) fleet(el);
    },
  });
}

export async function vehicleDetail(el, id) {
  const v = await api('GET', `/api/vehicles/${id}`);
  if (!v.availability) {
    // Vista reducida (conductor): solo datos de la unidad asignada.
    render(el, html`<h1>${v.plate}</h1><div class="card"><p>${v.brand} ${v.model} ${v.year || ''}</p><p>Tipo: ${v.kind}</p><p>Capacidad: ${v.capacity || '—'}</p></div>`);
    return;
  }
  const [wos, trips] = await Promise.all([
    can('maintenance.view') ? api('GET', `/api/work-orders?vehicle_id=${v.id}`) : Promise.resolve(null),
    can('trips.view_all') ? api('GET', `/api/trips?vehicle_id=${v.id}&active=1`) : Promise.resolve([]),
  ]);
  const a = v.availability;
  render(el, html`<p><a href="#/${ws()}/${ws() === 'mantenimiento' ? 'unidades' : 'flota'}">← Flota</a></p>
    <div class="split"><div><h1>${v.plate}</h1>${chip(a.status)}</div><div class="actions">
      ${can('fleet.manage') ? html`<button class="btn" data-act="edit">Editar ficha técnica</button>` : ''}
      ${can('maintenance.immobilize') && !a.immobilization ? html`<button class="btn danger" data-act="immobilize">Inmovilizar</button>` : ''}
      ${can('maintenance.release') && a.immobilization ? html`<button class="btn primary" data-act="release">Liberación técnica</button>` : ''}
      ${can('maintenance.manage') ? html`<button class="btn" data-act="wo">+ Orden de trabajo</button>` : ''}
    </div></div>
    ${a.immobilization ? html`<div class="notice bad">Inmovilizada desde ${dt(a.immobilization.since)}: ${a.immobilization.reason}</div>` : ''}
    <div class="grid-2"><div class="card"><h2 style="margin-top:0">Ficha técnica</h2>
      <p>${v.kind} · ${v.brand || ''} ${v.model || ''} ${v.year || ''}<br>Capacidad: ${v.capacity || '—'}<br>Kilometraje: ${num(v.odometer)} km</p>
      <p>Próximo servicio: ${v.next_service_km ? num(v.next_service_km) + ' km' : '—'} ${v.next_service_date ? '· ' + v.next_service_date : ''} ${v.service_due ? html`<span class="chip warn">Próximo</span>` : ''}</p>
      <p>${v.notes || ''}</p></div>
      <div class="card"><h2 style="margin-top:0">Reservas y viajes</h2>${table([{ h: 'Viaje', v: (t) => html`<a href="#/${ws()}/viaje/${t.id}">${t.code}</a>` },
        { h: 'Programado', v: (t) => `${dt(t.scheduled_start)} — ${dt(t.scheduled_end)}` }, { h: 'Estado', v: (t) => tripChip(t) }], trips, { empty: 'Sin reservas activas' })}</div></div>
    ${wos ? html`<div class="card"><h2 style="margin-top:0">Historial de mantenimiento</h2>${table([{ h: '#', v: (w) => w.id }, { h: 'Título', v: (w) => w.title }, { h: 'Tipo', v: (w) => w.kind },
      { h: 'Estado', v: (w) => chip(w.status) }, ...(can('maintenance.view_costs') ? [{ h: 'Costo', cls: 'right', v: (w) => money(w.total_cost) }] : []), { h: 'Actualizado', v: (w) => dt(w.updated_at) }], wos, { onRow: (w) => `/${ws()}/orden/${w.id}` })}</div>` : ''}
    <div class="card"><h2 style="margin-top:0">Inmovilizaciones</h2>${table([{ h: 'Desde', v: (i) => dt(i.created_at) }, { h: 'Motivo', v: (i) => i.reason }, { h: 'Origen', v: (i) => i.source },
      { h: 'Registró', v: (i) => i.created_by_name }, { h: 'Liberación', v: (i) => i.released_at ? `${dt(i.released_at)} · ${i.released_by_name}: ${i.release_notes}` : html`<span class="chip bad">Vigente</span>` }], v.immobilizations)}</div>`);
  const reload = () => vehicleDetail(el, id);
  bind(el, {
    immobilize: async () => { if (await modal(`Inmovilizar ${v.plate}`, html`${reasonField()}<p class="small muted">Operaciones no podrá asignar la unidad hasta la liberación técnica. Las reservas existentes no se cancelan automáticamente; se notificará a operaciones.</p>`, { danger: true, submitLabel: 'Inmovilizar', onSubmit: (d) => api('POST', `/api/vehicles/${v.id}/immobilize`, d) })) reload(); },
    release: async () => { if (await modal(`Liberación técnica de ${v.plate}`, html`${reasonField('Detalle de la intervención y verificación', 'notes')}<p class="small muted">No cancela reservas ni cambia asignaciones. Los viajes bloqueados requerirán una nueva inspección previa.</p>`, { submitLabel: 'Liberar', onSubmit: (d) => api('POST', `/api/vehicles/${v.id}/release`, d) })) reload(); },
    edit: async () => {
      const r = await modal('Ficha técnica', html`<div class="row"><div class="field"><label>Marca</label><input name="brand" value="${v.brand || ''}"></div><div class="field"><label>Modelo</label><input name="model" value="${v.model || ''}"></div><div class="field"><label>Año</label><input name="year" type="number" value="${v.year || ''}"></div></div>
        <div class="row"><div class="field"><label>Kilometraje</label><input name="odometer" type="number" value="${v.odometer}"></div><div class="field"><label>Capacidad</label><input name="capacity" value="${v.capacity || ''}"></div></div>
        <div class="row"><div class="field"><label>Próximo servicio (km)</label><input name="next_service_km" type="number" value="${v.next_service_km || ''}"></div><div class="field"><label>Próximo servicio (fecha)</label><input name="next_service_date" type="date" value="${v.next_service_date || ''}"></div></div>
        <div class="field"><label>Notas</label><textarea name="notes">${v.notes || ''}</textarea></div>`, { onSubmit: (d) => api('PATCH', `/api/vehicles/${v.id}`, d) });
      if (r) reload();
    },
    wo: async () => {
      const r = await modal('Nueva orden de trabajo', html`<div class="field"><label>Título</label><input name="title" required></div>
        <div class="row"><div class="field"><label>Tipo</label><select name="kind"><option value="preventivo">Preventivo</option><option value="correctivo">Correctivo</option></select></div>
        <div class="field"><label>Fecha programada</label><input type="date" name="scheduled_date"></div></div>`, { onSubmit: (d) => api('POST', '/api/work-orders', { ...clean(d), vehicle_id: v.id }) });
      if (r?.id) navigate(`/${ws()}/orden/${r.id}`);
    },
  });
}

// ---------- Aprobaciones ----------
export async function approvals(el) {
  const rows = await api('GET', '/api/approvals');
  const anyDecide = can('approvals.decide_expense') || can('approvals.decide_maintenance') || can('approvals.decide_exception');
  render(el, html`<h1>${anyDecide ? 'Aprobaciones' : 'Autorizaciones solicitadas'}</h1>
    <p class="notice">Una solicitud pendiente no equivale a una autorización. Nadie puede decidir sobre sus propias solicitudes.</p>
    <div class="card">${table([
    { h: '#', v: (a) => a.id }, { h: 'Tipo', v: (a) => html`${a.type_label}${a.subtype ? html`<br><span class="small muted">${label(a.subtype)}</span>` : ''}` },
    { h: 'Referencia', v: (a) => a.trip ? html`<a href="#/${ws()}/viaje/${a.trip.id}">${a.trip.code}</a>` : a.work_order ? html`<a href="#/${ws()}/orden/${a.work_order.id}">OT #${a.work_order.id} · ${a.work_order.plate}</a>` : '—' },
    { h: 'Monto', cls: 'right', v: (a) => (a.amount != null ? money(a.amount) : '—') },
    { h: 'Motivo', v: (a) => a.reason },
    { h: 'Solicitante', v: (a) => html`<span class="small">${a.requested_by.name}<br>${dt(a.requested_at)}</span>` },
    { h: 'Estado', v: (a) => html`${chip(a.status)}${a.decided_by ? html`<br><span class="small">${a.decided_by.name} · ${dt(a.decided_at)}${a.decision_reason ? ': ' + a.decision_reason : ''}</span>` : ''}` },
    { h: '', v: (a) => a.can_decide ? html`<button class="btn small primary" data-act="ok" data-id="${a.id}" data-t="${a.type}">Aprobar</button> <button class="btn small danger" data-act="no" data-id="${a.id}">Rechazar</button>`
      : a.status === 'pendiente' && a.own_request ? html`<span class="small muted">Su solicitud</span>` : '' },
  ], rows)}</div>`);
  const reload = () => approvals(el);
  bind(el, {
    ok: async (ds) => {
      const needReason = ds.t === 'excepcion_operativa';
      if (await modal('Aprobar solicitud', html`<div class="field"><label>Motivo de la decisión${needReason ? '' : ' (opcional)'}</label><textarea name="reason" ${needReason ? 'required' : ''}></textarea></div>`, { submitLabel: 'Aprobar', onSubmit: (d) => api('POST', `/api/approvals/${ds.id}/decide`, { decision: 'aprobada', reason: d.reason }) })) reload();
    },
    no: async (ds) => { if (await modal('Rechazar solicitud', reasonField(), { danger: true, submitLabel: 'Rechazar', onSubmit: (d) => api('POST', `/api/approvals/${ds.id}/decide`, { decision: 'rechazada', reason: d.reason }) })) reload(); },
  });
}
