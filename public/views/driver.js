// Espacio del conductor: móvil, botones grandes y pocos pasos.
import { api, html, render, state, money, dt, num, chip, tripChip, bind, toast, ls, fileToDataUrl, label, navigate } from '../lib.js';
import { outbox } from '../outbox.js';

const MILESTONES = [
  ['salida', 'Reportar salida'], ['llegada_carga', 'Llegué al punto de carga'], ['inicio_traslado', 'Inicio de traslado'],
  ['llegada_destino', 'Llegué al destino'], ['fin_servicio', 'Fin de servicio'],
];
const DISCLAIMER = 'Este formulario no es un servicio de emergencias ni un canal vigilado permanentemente. Ante una emergencia, llame a los servicios de emergencia y luego a su coordinador.';

// Lectura con respaldo local: sin conexión se muestran los últimos datos recibidos.
let offlineSince = null;
async function cachedGet(path) {
  const key = `tv_cache_${state.me.id}_${path}`;
  try {
    const data = await api('GET', path);
    ls.set(key, { at: new Date().toISOString(), data });
    offlineSince = null;
    return data;
  } catch (e) {
    const c = ls.get(key, null);
    if (e instanceof TypeError && c) { offlineSince = c.at; return c.data; }
    throw e;
  }
}
const offlineNotice = () => (offlineSince ? html`<div class="notice warn">Sin conexión. Datos guardados el ${dt(offlineSince)}.</div>` : '');

const pendingFor = (tripId) => outbox.items().filter((i) => i.status === 'pendiente' && i.path.startsWith(`/api/trips/${tripId}/`));

async function submit(opts, okMsg) {
  const r = await outbox.submit(opts);
  if (r.sent) toast(okMsg);
  else if (r.queued) toast('Sin conexión: quedó pendiente de sincronización');
  else toast(r.error, true);
  return r;
}

export async function myTrip(el) {
  const trips = await cachedGet('/api/trips?active=1');
  trips.sort((a, b) => a.scheduled_start.localeCompare(b.scheduled_start));
  const current = trips.find((t) => ['en_curso', 'fin_reportado', 'cierre_solicitado'].includes(t.status)) || trips[0];
  if (!current) {
    render(el, html`<h1>Mi viaje</h1><div class="card"><p>No tiene viajes asignados por ahora.</p></div>`);
    return;
  }
  const t = await cachedGet(`/api/trips/${current.id}`);
  const queued = pendingFor(t.id);
  const done = new Set([...t.events.map((e) => e.type), ...queued.map((q) => q.path.split('/').pop())]);
  const nextMs = MILESTONES.find(([k]) => !done.has(k));
  const queuedTypes = queued.map((q) => q.label).join(', ');

  let main;
  const st = t.status;
  if (st === 'asignado' && !done.has('confirm')) main = html`<button class="big-btn" data-act="confirm">Confirmar que recibí la asignación</button>`;
  else if (['asignado', 'confirmado', 'bloqueado'].includes(st)) {
    main = html`${st === 'bloqueado' ? html`<div class="notice bad">Inicio bloqueado por una falla crítica. Mantenimiento debe liberar la unidad; después repita la inspección.</div>` : ''}
      <button class="big-btn" data-act="inspect">Inspección previa</button>`;
  } else if (['inspeccion_aprobada', 'en_curso'].includes(st) && nextMs) {
    main = html`<button class="big-btn" data-act="ms" data-k="${nextMs[0]}">${nextMs[1]}</button>`;
  } else if (st === 'fin_reportado' || (st === 'en_curso' && !nextMs)) {
    main = html`<div class="notice">Reportó el fin del servicio. Revise que sus gastos estén registrados y solicite el cierre.</div>
      <button class="big-btn" data-act="close">Solicitar cierre operativo</button>`;
  } else if (st === 'cierre_solicitado') {
    main = html`<div class="notice ok">Cierre solicitado. Operaciones debe validarlo; el cierre financiero lo realiza administración.</div>`;
  }

  render(el, html`${offlineNotice()}
    <div class="card trip-hero">
      <div class="split"><strong>${t.code}</strong>${tripChip(t)}</div>
      <p class="route">${t.origin}<br>↓<br>${t.destination}</p>
      <p>${dt(t.scheduled_start)} — ${dt(t.scheduled_end)}</p>
      <p>Unidad: <strong>${t.vehicle?.plate || '—'}</strong>${t.trailer ? html` + <strong>${t.trailer.plate}</strong>` : ''} ${t.vehicle ? html`<a href="#/conductor/unidad/${t.vehicle.id}" class="small">ficha</a>` : ''}</p>
      ${t.cargo ? html`<p>Carga: ${t.cargo}</p>` : ''}
      ${t.instructions ? html`<div class="notice">${t.instructions}</div>` : ''}
      ${t.coordinator ? html`<p>Coordinador: ${t.coordinator.name} ${t.coordinator.phone ? html`· <a href="tel:${t.coordinator.phone.replace(/\s/g, '')}">${t.coordinator.phone}</a>` : ''}</p>` : ''}
    </div>
    ${queued.length ? html`<div class="notice warn">Pendiente de sincronización: ${queuedTypes}</div>` : ''}
    ${main || ''}
    ${['inspeccion_aprobada', 'en_curso', 'fin_reportado', 'cierre_solicitado'].includes(st) ? html`<div class="big-row">
      <button class="big-btn secondary" data-act="expense">Registrar gasto</button>
      <button class="big-btn secondary" data-act="incident">Reportar incidencia</button></div>` : html`<button class="big-btn secondary" data-act="incident">Reportar incidencia</button>`}
    <div class="card"><h3 style="margin-top:0">Avances</h3>
      <ul class="timeline">${t.events.filter((e) => e.type !== 'correccion').map((e) => html`<li>${label(e.type)} <span class="muted small">${dt(e.at)}${e.odometer ? ` · ${num(e.odometer)} km` : ''}</span></li>`)}
      ${queued.map((q) => html`<li>${q.label} <span class="chip warn">Pendiente de sincronización</span></li>`)}</ul>
    </div>
    ${trips.length > 1 ? html`<div class="card"><h3 style="margin-top:0">Próximos viajes</h3>${trips.filter((x) => x.id !== t.id).map((x) => html`<p><strong>${x.code}</strong> ${x.origin} → ${x.destination}<br><span class="small">${dt(x.scheduled_start)}</span> ${tripChip(x)}</p>`)}</div>` : ''}`);

  const reload = () => myTrip(el);
  bind(el, {
    confirm: async () => { await submit({ label: 'Confirmación', path: `/api/trips/${t.id}/confirm` }, 'Asignación confirmada'); reload(); },
    inspect: () => inspectionForm(el, t),
    ms: (ds) => milestoneForm(el, t, ds.k),
    close: async () => {
      if (!confirm('¿Solicitar el cierre operativo del viaje?')) return;
      await submit({ label: 'Solicitud de cierre', path: `/api/trips/${t.id}/request-close` }, 'Cierre solicitado'); reload();
    },
    expense: () => expenseForm(el, t),
    incident: () => incidentForm(el, t),
  });
}

// ---------- Borradores (locales + servidor cuando hay conexión) ----------
const draftKey = (kind, tripId) => `tv_draft_${state.me.id}_${kind}_${tripId}`;
function saveDraft(kind, tripId, data) {
  ls.set(draftKey(kind, tripId), data);
  const { photos, receipt, ...light } = data;
  api('PUT', '/api/drafts', { kind, trip_id: tripId, payload: light }).catch(() => {});
}
async function loadDraft(kind, tripId) {
  const local = ls.get(draftKey(kind, tripId), null);
  if (local) return local;
  try { return (await api('GET', '/api/drafts')).find((d) => d.kind === kind && d.trip_id === tripId)?.payload || null; } catch { return null; }
}
async function clearDraft(kind, tripId) {
  ls.del(draftKey(kind, tripId));
  try { const d = (await api('GET', '/api/drafts')).find((x) => x.kind === kind && x.trip_id === tripId); if (d) await api('DELETE', `/api/drafts/${d.id}`); } catch { /* sin conexión */ }
}

function formShell(el, title, body, back) {
  render(el, html`<p><a href="#" data-act="back">← Volver</a></p><h1>${title}</h1><form id="f" novalidate>${body}</form>`);
  el.querySelector('[data-act=back]').onclick = (e) => { e.preventDefault(); back(); };
  return el.querySelector('#f');
}

async function photoInput(input, list, max = 6) {
  for (const f of [...input.files].slice(0, max - list.length)) {
    try { list.push(await fileToDataUrl(f)); } catch { toast('No se pudo leer la imagen', true); }
  }
  input.value = '';
}

async function inspectionForm(el, t) {
  const checklist = state.config.inspection_checklist;
  const draft = (await loadDraft('inspeccion', t.id)) || {};
  const data = { items: draft.items || {}, notes: draft.notes || '', odometer: draft.odometer || '', photos: draft.photos || [] };
  const draw = () => {
    const f = formShell(el, 'Inspección previa', html`
      <p class="muted">Unidad ${t.vehicle?.plate}${t.trailer ? ' + ' + t.trailer.plate : ''}. Marque cada punto. Los marcados con ★ son críticos: una falla bloquea la salida y se deriva a mantenimiento.</p>
      <div class="card">${checklist.map((c) => html`<div class="check-item"><span>${c.critical ? '★ ' : ''}${c.label}</span>
        <span class="seg" role="group" aria-label="${c.label}">${['ok', 'falla', 'na'].map((v) => html`<button type="button" data-item="${c.code}" data-v="${v}" class="${data.items[c.code] === v ? 'on-' + v : ''}">${v === 'ok' ? 'OK' : v === 'falla' ? 'Falla' : 'N/A'}</button>`)}</span></div>`)}</div>
      <div class="field"><label>Kilometraje actual (opcional)</label><input name="odometer" type="number" inputmode="numeric" value="${data.odometer}"></div>
      <div class="field"><label>Observaciones</label><textarea name="notes">${data.notes}</textarea></div>
      <div class="field"><label>Fotografías (mínimo ${state.config.inspection_min_photos})</label><input type="file" accept="image/*" capture="environment" multiple id="ph">
        <div class="thumbs" style="margin-top:8px">${data.photos.map((p, i) => html`<img src="${p}" alt="Foto ${i + 1}">`)}</div></div>
      <button class="big-btn" type="submit">Enviar inspección</button>
      <button class="big-btn secondary" type="button" id="sd">Guardar borrador</button>`, () => myTrip(el));
    const sync = () => { data.notes = f.notes.value; data.odometer = f.odometer.value; };
    f.querySelectorAll('[data-item]').forEach((b) => b.onclick = () => { sync(); data.items[b.dataset.item] = b.dataset.v; saveDraft('inspeccion', t.id, data); draw(); });
    f.querySelector('#ph').onchange = async (e) => { sync(); await photoInput(e.target, data.photos); saveDraft('inspeccion', t.id, data); draw(); };
    f.querySelector('#sd').onclick = () => { sync(); saveDraft('inspeccion', t.id, data); toast('Borrador guardado'); };
    f.onsubmit = async (e) => {
      e.preventDefault(); sync();
      const missing = checklist.filter((c) => !data.items[c.code]);
      if (missing.length) return toast(`Falta marcar: ${missing.map((m) => m.label).join(', ')}`, true);
      if (data.photos.length < state.config.inspection_min_photos) return toast('Agregue las fotografías requeridas', true);
      const critical = checklist.filter((c) => c.critical && data.items[c.code] === 'falla');
      if (critical.length && !confirm(`Reporta falla crítica (${critical.map((c) => c.label).join(', ')}). La salida quedará bloqueada y se avisará a mantenimiento. ¿Enviar?`)) return;
      const r = await submit({ label: 'Inspección previa', path: `/api/trips/${t.id}/inspection`, body: { items: data.items, notes: data.notes, odometer: data.odometer || null }, files: { photo_ids: data.photos } }, 'Inspección enviada');
      if (!r.error) { await clearDraft('inspeccion', t.id); myTrip(el); }
    };
  };
  draw();
}

function milestoneForm(el, t, kind) {
  const needsKm = kind === 'salida' || kind === 'fin_servicio';
  const lbl = MILESTONES.find((m) => m[0] === kind)[1];
  const f = formShell(el, lbl, html`
    ${needsKm ? html`<div class="field"><label>${kind === 'salida' ? 'Kilometraje inicial' : 'Kilometraje final'}</label><input name="odometer" type="number" inputmode="numeric" required min="${kind === 'fin_servicio' && t.km_start ? t.km_start : 0}"></div>` : ''}
    <div class="field"><label>Comentario (opcional)</label><textarea name="notes"></textarea></div>
    ${kind === 'fin_servicio' ? html`<p class="notice">Esto informa que terminó el servicio. El cierre lo valida operaciones; no es un cierre financiero.</p>` : ''}
    <button class="big-btn" type="submit">${lbl}</button>`, () => myTrip(el));
  f.onsubmit = async (e) => {
    e.preventDefault();
    if (needsKm && !f.odometer.value) return toast('Indique el kilometraje', true);
    const r = await submit({ label: lbl, path: `/api/trips/${t.id}/milestones/${kind}`, body: { odometer: needsKm ? Number(f.odometer.value) : undefined, notes: f.notes.value || undefined } }, 'Registrado');
    if (!r.error) myTrip(el);
  };
}

async function expenseForm(el, t) {
  const draft = (await loadDraft('gasto', t.id)) || {};
  const cats = state.config.expense_categories;
  const thr = state.config.extraordinary_expense_threshold;
  const data = { receipt: draft.receipt || null };
  const f = formShell(el, 'Registrar gasto', html`
    <div class="field"><label>Categoría</label><select name="category">${cats.map((c) => html`<option value="${c.code}" ${draft.category === c.code ? 'selected' : ''}>${c.label}</option>`)}</select></div>
    <div class="field"><label>Monto</label><input name="amount" type="number" step="0.01" min="0.01" inputmode="decimal" required value="${draft.amount || ''}"></div>
    <div class="row"><div class="field"><label>Litros (combustible)</label><input name="liters" type="number" step="0.01" inputmode="decimal" value="${draft.liters || ''}"></div>
      <div class="field"><label>Kilometraje</label><input name="odometer" type="number" inputmode="numeric" value="${draft.odometer || ''}"></div></div>
    <div class="row"><div class="field"><label>Proveedor</label><input name="supplier" value="${draft.supplier || ''}"></div>
      <div class="field"><label>N.º de comprobante</label><input name="receipt_number" value="${draft.receipt_number || ''}"></div></div>
    <div class="field"><label>Fecha del comprobante</label><input name="receipt_date" type="date" value="${draft.receipt_date || new Date().toISOString().slice(0, 10)}"></div>
    <div class="field"><label>Descripción / motivo</label><textarea name="description">${draft.description || ''}</textarea></div>
    <p class="small muted" id="xnote">Montos mayores a ${money(thr)} o categorías extraordinarias requieren aprobación de gerencia; indique el motivo.</p>
    <div class="field"><label>Foto del comprobante</label><input type="file" accept="image/*,application/pdf" capture="environment" id="rc">
      <div class="thumbs" id="rcp" style="margin-top:8px">${data.receipt && data.receipt.startsWith('data:image') ? html`<img src="${data.receipt}" alt="Comprobante">` : ''}</div></div>
    <button class="big-btn" type="submit">Enviar gasto</button>
    <button class="big-btn secondary" type="button" id="sd">Guardar borrador</button>`, () => myTrip(el));
  const values = () => Object.fromEntries(new FormData(f));
  f.querySelector('#rc').onchange = async (e) => {
    const file = e.target.files[0]; if (!file) return;
    data.receipt = await fileToDataUrl(file);
    f.querySelector('#rcp').innerHTML = data.receipt.startsWith('data:image') ? `<img src="${data.receipt}" alt="Comprobante">` : 'PDF adjunto';
    saveDraft('gasto', t.id, { ...values(), receipt: data.receipt });
  };
  f.oninput = () => saveDraft('gasto', t.id, { ...values(), receipt: data.receipt });
  f.querySelector('#sd').onclick = () => { saveDraft('gasto', t.id, { ...values(), receipt: data.receipt }); toast('Borrador guardado'); };
  f.onsubmit = async (e) => {
    e.preventDefault();
    const v = values();
    if (!(Number(v.amount) > 0)) return toast('Indique el monto', true);
    const extra = Number(v.amount) > thr || state.config.extraordinary_categories.includes(v.category);
    if (extra && (v.description || '').trim().length < 3) return toast('Gasto extraordinario: indique el motivo en la descripción', true);
    const body = Object.fromEntries(Object.entries({ ...v, trip_id: t.id }).filter(([, x]) => x !== ''));
    const r = await submit({ label: `Gasto ${label(v.category)} ${money(v.amount)}`, path: '/api/expenses', body, files: { receipt_file_id: data.receipt } }, extra ? 'Gasto enviado: pendiente de aprobación' : 'Gasto enviado');
    if (!r.error) { await clearDraft('gasto', t.id); myTrip(el); }
  };
}

async function incidentForm(el, t) {
  const draft = (await loadDraft('incidencia', t.id)) || {};
  const f = formShell(el, 'Reportar incidencia', html`
    <div class="notice warn">${DISCLAIMER}</div>
    <div class="field"><label>Tipo</label><select name="type">${state.config.incident_types.map((x) => html`<option value="${x.code}" ${draft.type === x.code ? 'selected' : ''}>${x.label}</option>`)}</select></div>
    <div class="field"><label>Gravedad</label><select name="severity">${['baja', 'media', 'alta', 'critica'].map((x) => html`<option value="${x}" ${(draft.severity || 'media') === x ? 'selected' : ''}>${label(x)}</option>`)}</select></div>
    <div class="field"><label>¿Qué pasó?</label><textarea name="description" required>${draft.description || ''}</textarea></div>
    <button class="big-btn" type="submit">Enviar incidencia</button>`, () => myTrip(el));
  f.oninput = () => saveDraft('incidencia', t.id, Object.fromEntries(new FormData(f)));
  f.onsubmit = async (e) => {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(f));
    if ((v.description || '').trim().length < 3) return toast('Describa la incidencia', true);
    const r = await submit({ label: `Incidencia: ${label(v.type)}`, path: '/api/incidents', body: { ...v, trip_id: t.id } }, 'Incidencia enviada');
    if (!r.error) { await clearDraft('incidencia', t.id); myTrip(el); }
  };
}

export async function history(el) {
  const trips = await cachedGet('/api/trips');
  render(el, html`<h1>Mis viajes</h1>${offlineNotice()}${trips.map((t) => html`<div class="card"><div class="split"><strong>${t.code}</strong>${tripChip(t)}</div>
    <p>${t.origin} → ${t.destination}<br><span class="small muted">${dt(t.scheduled_start)}</span></p>
    ${t.km_end && t.km_start ? html`<p class="small">${num(t.km_end - t.km_start)} km recorridos</p>` : ''}</div>`)}`);
}

export async function expenses(el) {
  const rows = await cachedGet('/api/expenses');
  render(el, html`<h1>Mis gastos</h1>${offlineNotice()}${rows.length ? rows.map((e) => html`<div class="card"><div class="split"><strong>${label(e.category)} · ${money(e.amount)}</strong>${chip(e.validation_status)}</div>
    <p class="small">${e.trip?.code} · ${dt(e.created_at)} ${e.extraordinary ? html`· Extraordinario: ${chip(e.approval_status)}` : ''}</p>
    ${e.validation_reason ? html`<p class="small">Motivo: ${e.validation_reason}</p>` : ''}</div>`) : html`<p class="muted">Sin gastos registrados.</p>`}`);
}

export async function incidents(el) {
  const rows = await cachedGet('/api/incidents');
  render(el, html`<h1>Mis incidencias</h1>${offlineNotice()}<p class="small muted">${DISCLAIMER}</p>
    ${rows.length ? rows.map((i) => html`<div class="card"><div class="split"><strong>${label(i.type)}</strong>${chip(i.status)}</div>
    <p>${i.description}</p><p class="small muted">${i.trip?.code || ''} · ${dt(i.created_at)}</p>${i.resolution ? html`<p class="small">Resolución: ${i.resolution}</p>` : ''}</div>`) : html`<p class="muted">Sin incidencias.</p>`}`);
}

export async function pending(el) {
  const items = outbox.items();
  render(el, html`<h1>Envíos pendientes</h1>
    <p class="small muted">Los registros hechos sin conexión se guardan en este dispositivo y se envían al recuperar la señal. Cada uno tiene un identificador único, por lo que reenviarlo no crea duplicados.</p>
    ${items.length ? html`<button class="big-btn" data-act="sync">Sincronizar ahora</button>` : html`<div class="notice ok">Todo sincronizado.</div>`}
    ${items.map((i) => html`<div class="card"><div class="split"><strong>${i.label}</strong>${i.status === 'error' ? html`<span class="chip bad">Rechazado</span>` : html`<span class="chip warn">Pendiente de sincronización</span>`}</div>
      <p class="small muted">${dt(i.created_at)}${i.error ? ' · ' + i.error : ''}</p>
      ${i.status === 'error' ? html`<button class="btn small" data-act="discard" data-id="${i.id}">Descartar</button>` : ''}</div>`)}`);
  bind(el, {
    sync: async () => { await outbox.sync(); toast(outbox.count() ? 'Algunos registros siguen pendientes' : 'Sincronizado'); navigate('/conductor/pendientes'); pending(el); },
    discard: (ds) => { outbox.remove(ds.id); pending(el); },
  });
}
