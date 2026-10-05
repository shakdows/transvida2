// Utilidades compartidas de la interfaz. La interfaz solo adapta la presentación:
// toda autorización se vuelve a comprobar en el servidor.

export const state = { me: null, config: null, workspace: null };

export class ApiError extends Error {
  constructor(status, data) { super(data?.message || `Error ${status}`); this.status = status; this.data = data; }
}

export async function api(method, path, body) {
  const res = await fetch(path, {
    method, credentials: 'same-origin',
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (res.status === 401 && path !== '/api/auth/login') { state.me = null; location.hash = '#/login'; }
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

export const can = (p) => !!state.me?.permissions.includes(p);

export function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
// Plantilla con escape automático. Use raw() para HTML confiable ya construido.
const RAW = Symbol('raw');
export const raw = (s) => ({ [RAW]: true, s: String(s) });
export function html(strings, ...vals) {
  let out = '';
  strings.forEach((s, i) => {
    out += s;
    if (i < vals.length) {
      const v = vals[i];
      if (Array.isArray(v)) out += v.map((x) => (x && x[RAW] ? x.s : esc(x))).join('');
      else if (v && v[RAW]) out += v.s;
      else if (v === false || v === null || v === undefined) out += '';
      else out += esc(v);
    }
  });
  return raw(out);
}
export const render = (el, tpl) => { el.innerHTML = tpl.s; };

export function money(v) {
  if (v === null || v === undefined || v === '') return '—';
  try { return new Intl.NumberFormat('es', { style: 'currency', currency: state.config?.currency || 'USD' }).format(v); }
  catch { return Number(v).toFixed(2); }
}
export const dt = (v) => (v ? new Date(v).toLocaleString('es', { dateStyle: 'short', timeStyle: 'short' }) : '—');
export const d = (v) => (v ? new Date(v).toLocaleDateString('es') : '—');
export const num = (v) => (v === null || v === undefined ? '—' : new Intl.NumberFormat('es').format(v));
export const toLocalInput = (iso) => { if (!iso) return ''; const x = new Date(iso); x.setMinutes(x.getMinutes() - x.getTimezoneOffset()); return x.toISOString().slice(0, 16); };
export const fromLocalInput = (v) => (v ? new Date(v).toISOString() : null);

const TRIP_TONE = {
  programado: '', asignado: 'info', confirmado: 'info', inspeccion_aprobada: 'ok', bloqueado: 'bad', en_curso: 'info',
  fin_reportado: 'warn', cierre_solicitado: 'warn', cerrado_operativo: 'ok', cerrado_financiero: 'ok', cancelado: '',
};
const GENERIC_TONE = {
  disponible: 'ok', reservado: 'info', en_viaje: 'info', inmovilizado: 'bad', en_taller: 'warn',
  pendiente: 'warn', aprobada: 'ok', rechazada: 'bad', validado: 'ok', rechazado: 'bad', no_requerida: '',
  abierta: 'warn', resuelta: 'ok', critica: 'bad', alta: 'bad', media: 'warn', baja: '',
  programado: '', pendiente_evaluacion: 'bad', terminado: 'ok', cancelado: '', aprobado: 'ok', excedido: 'bad', no_requerido: '',
  aprobada_insp: 'ok', activo: 'ok', falla_critica: 'bad', observaciones: 'warn',
};
const LABELS = {
  disponible: 'Disponible', reservado: 'Reservado', en_viaje: 'En viaje', inmovilizado: 'Inmovilizado', en_taller: 'En taller',
  pendiente: 'Pendiente', aprobada: 'Aprobada', rechazada: 'Rechazada', validado: 'Validado', rechazado: 'Rechazado', no_requerida: 'No requerida',
  abierta: 'Abierta', resuelta: 'Resuelta', programado: 'Programado', pendiente_evaluacion: 'Pendiente de evaluación', terminado: 'Terminado',
  cancelado: 'Cancelado', aprobado: 'Aprobado', excedido: 'Presupuesto excedido', no_requerido: 'Sin presupuesto', falla_critica: 'Falla crítica',
  observaciones: 'Con observaciones', critica: 'Crítica', alta: 'Alta', media: 'Media', baja: 'Baja',
};
const configLabel = (s) => [...(state.config?.expense_categories || []), ...(state.config?.incident_types || []), ...(state.config?.exception_types || [])].find((x) => x.code === s)?.label;
export const label = (s) => LABELS[s] || configLabel(s) || String(s ?? '').replace(/_/g, ' ');
export const chip = (s, text) => html`<span class="chip ${GENERIC_TONE[s] || ''}">${text || label(s)}</span>`;
export const tripChip = (t) => html`<span class="chip ${TRIP_TONE[t.status] || ''}">${t.status_label}</span>${t.delayed ? html` <span class="chip bad">Retrasado</span>` : ''}`;

let toastTimer;
export function toast(msg, err = false) {
  const el = document.getElementById('toast');
  el.textContent = msg; el.className = `show${err ? ' err' : ''}`;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.className = ''; }, 3800);
}

// Ejecuta una acción mostrando el resultado; devuelve el resultado o null si falló.
export async function act(fn, okMsg) {
  try { const r = await fn(); if (okMsg) toast(okMsg); return r ?? true; }
  catch (e) { toast(e.message || 'Error', true); return null; }
}

export function modal(title, bodyTpl, { onSubmit, submitLabel = 'Guardar', danger = false } = {}) {
  return new Promise((resolve) => {
    const bg = document.createElement('div');
    bg.className = 'modal-bg';
    bg.innerHTML = html`<form class="modal" novalidate>
      <h2 style="margin-top:0">${title}</h2>${bodyTpl}
      <div class="actions" style="justify-content:flex-end">
        <button type="button" class="btn ghost" data-close>Cancelar</button>
        <button class="btn ${danger ? 'danger' : 'primary'}">${submitLabel}</button>
      </div></form>`.s;
    document.body.appendChild(bg);
    const form = bg.querySelector('form');
    const close = (v) => { bg.remove(); resolve(v); };
    bg.querySelector('[data-close]').onclick = () => close(null);
    bg.onclick = (e) => { if (e.target === bg) close(null); };
    form.onsubmit = async (e) => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(form));
      const btn = form.querySelector('button:not([data-close])');
      btn.disabled = true;
      try { const r = onSubmit ? await onSubmit(data, form) : data; close(r ?? data); }
      catch (err) { toast(err.message || 'Error', true); btn.disabled = false; }
    };
    form.querySelector('input,select,textarea')?.focus();
  });
}

export const reasonField = (lbl = 'Motivo', name = 'reason') => html`<div class="field"><label>${lbl}</label><textarea name="${name}" required minlength="3"></textarea></div>`;

export function navigate(path) { location.hash = '#' + path; }

export function bind(root, handlers) {
  root.querySelectorAll('[data-act]').forEach((el) => {
    const h = handlers[el.dataset.act];
    if (h) el.addEventListener(el.tagName === 'FORM' ? 'submit' : 'click', (e) => { e.preventDefault(); h(el.dataset, el, e); });
  });
}

export function uuid() {
  return crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
}

// Reduce fotografías antes de enviarlas (conexiones móviles).
export async function fileToDataUrl(file) {
  if (file.type === 'application/pdf') return new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(file); });
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 1280 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.72);
}

export function table(cols, rows, { onRow, empty = 'Sin registros' } = {}) {
  if (!rows.length) return html`<p class="muted">${empty}</p>`;
  return html`<div class="table-wrap"><table><thead><tr>${cols.map((c) => html`<th class="${c.cls || ''}">${c.h}</th>`)}</tr></thead><tbody>
    ${rows.map((r) => html`<tr class="${onRow ? 'clickable' : ''}" ${onRow ? raw(`data-href="${esc(onRow(r))}"`) : ''}>${cols.map((c) => html`<td class="${c.cls || ''}">${c.v(r)}</td>`)}</tr>`)}
  </tbody></table></div>`;
}

export const ls = {
  get(k, def) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : def; } catch { return def; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* almacenamiento no disponible */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* noop */ } },
};
