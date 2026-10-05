// Espacio del administrador del sistema: usuarios, accesos, configuración e integraciones.
// El perfil técnico no recibe acceso financiero: debe asignarse explícitamente a otro usuario.
import { api, html, render, state, dt, chip, table, bind, modal, act, navigate, label } from '../lib.js';

let catalogCache;
const catalog = async () => (catalogCache ||= await api('GET', '/api/admin/catalog'));

export async function users(el) {
  const [rows, cat] = await Promise.all([api('GET', '/api/admin/users'), catalog()]);
  const roleLabel = (r) => cat.roles.find((x) => x.code === r)?.label || r;
  render(el, html`<div class="split"><h1>Usuarios y accesos</h1><button class="btn primary" data-act="new">+ Nuevo usuario</button></div>
    <div class="card">${table([{ h: 'Usuario', v: (u) => html`<strong>${u.name}</strong><br><span class="small muted">${u.username}</span>` },
      { h: 'Perfiles', v: (u) => u.roles.map((r) => html`<span class="chip info">${roleLabel(r)}</span> `) },
      { h: 'Permisos adicionales', v: (u) => u.permissions.length ? u.permissions.map((p) => html`<span class="chip warn">${p}</span> `) : '—' },
      { h: 'Estado', v: (u) => u.active ? chip('activo', 'Activo') : html`<span class="chip">Inactivo</span>` }], rows, { onRow: (u) => `/admin/usuario/${u.id}` })}</div>`);
  bind(el, {
    new: async () => {
      const r = await modal('Nuevo usuario', html`<div class="row"><div class="field"><label>Nombre</label><input name="name" required></div><div class="field"><label>Usuario</label><input name="username" required pattern="[a-z0-9._-]{3,40}"></div></div>
        <div class="row"><div class="field"><label>Teléfono</label><input name="phone"></div><div class="field"><label>Correo</label><input name="email" type="email"></div></div>
        <div class="field"><label>Contraseña inicial (mín. 8)</label><input name="password" type="password" required minlength="8"></div>
        ${roleChecks(cat, [])}`, {
        submitLabel: 'Crear', onSubmit: (d, form) => api('POST', '/api/admin/users', { ...d, roles: checked(form, 'role'), permissions: [] }),
      });
      if (r?.id) navigate(`/admin/usuario/${r.id}`);
    },
  });
}

const roleChecks = (cat, selected) => html`<label>Perfiles</label>${cat.roles.filter((r) => !r.future).map((r) => html`<label style="display:flex;gap:8px;font-weight:400"><input type="checkbox" style="width:auto" data-role="${r.code}" ${selected.includes(r.code) ? 'checked' : ''}> ${r.label}</label>`)}
  <p class="small muted">Puede combinar perfiles (empresas pequeñas). Nadie puede aprobar sus propias solicitudes, aunque tenga varios perfiles.</p>`;
const checked = (form, kind) => [...form.querySelectorAll(`[data-${kind}]:checked`)].map((c) => c.dataset[kind]);

export async function userDetail(el, id) {
  const [rows, cat] = await Promise.all([api('GET', '/api/admin/users'), catalog()]);
  const u = rows.find((x) => x.id === Number(id));
  if (!u) throw Object.assign(new Error('Usuario no encontrado'), { status: 404 });
  const self = u.id === state.me.id;
  const fromRoles = new Set(u.roles.flatMap((r) => cat.roles.find((x) => x.code === r)?.permissions || []));
  const groups = {};
  for (const p of cat.permissions.filter((x) => x.code !== 'portal.view_own')) (groups[p.code.split('.')[0]] ||= []).push(p);
  render(el, html`<p><a href="#/admin/usuarios">← Usuarios</a></p>
    <div class="split"><div><h1>${u.name}</h1><span class="muted">${u.username}</span> ${u.active ? chip('activo', 'Activo') : html`<span class="chip">Inactivo</span>`}</div>
      <div class="actions">${!self ? html`<button class="btn ${u.active ? 'danger' : ''}" data-act="toggle">${u.active ? 'Desactivar' : 'Reactivar'}</button>` : ''}<button class="btn" data-act="pw">Restablecer contraseña</button></div></div>
    ${self ? html`<div class="notice warn">No puede modificar sus propios perfiles ni permisos: solicítelo a otro administrador.</div>` : ''}
    <form class="card" id="f">
      <div class="row"><div class="field"><label>Nombre</label><input name="name" value="${u.name}"></div><div class="field"><label>Teléfono</label><input name="phone" value="${u.phone || ''}"></div><div class="field"><label>Correo</label><input name="email" value="${u.email || ''}"></div></div>
      ${roleChecks(cat, u.roles)}
      <h3>Permisos adicionales explícitos</h3>
      <p class="small muted">Marcados en gris: ya incluidos por sus perfiles. Los permisos financieros (finance.*) nunca se otorgan automáticamente al perfil técnico.</p>
      ${Object.entries(groups).map(([g, ps]) => html`<details ${ps.some((p) => u.permissions.includes(p.code)) ? 'open' : ''}><summary><strong>${label(g)}</strong></summary>
        ${ps.map((p) => html`<label style="display:flex;gap:8px;font-weight:400;${fromRoles.has(p.code) ? 'opacity:.55' : ''}"><input type="checkbox" style="width:auto" data-perm="${p.code}" ${u.permissions.includes(p.code) || fromRoles.has(p.code) ? 'checked' : ''} ${fromRoles.has(p.code) || self ? 'disabled' : ''}> ${p.label} <code class="small muted">${p.code}</code></label>`)}</details>`)}
      <div class="field" style="margin-top:12px"><label>Motivo del cambio</label><input name="reason"></div>
      <button class="btn primary">Guardar</button>
    </form>`);
  const f = el.querySelector('#f');
  if (self) f.querySelectorAll('[data-role]').forEach((c) => { c.disabled = true; });
  f.onsubmit = async (e) => {
    e.preventDefault();
    const body = { name: f.name.value, phone: f.phone.value, email: f.email.value, reason: f.reason.value };
    if (!self) Object.assign(body, { roles: checked(f, 'role'), permissions: [...f.querySelectorAll('[data-perm]:checked:not(:disabled)')].map((c) => c.dataset.perm) });
    if (await act(() => api('PATCH', `/api/admin/users/${u.id}`, body), 'Usuario actualizado')) userDetail(el, id);
  };
  bind(el, {
    toggle: async () => { if (await act(() => api('PATCH', `/api/admin/users/${u.id}`, { active: !u.active }), u.active ? 'Usuario desactivado' : 'Usuario reactivado')) userDetail(el, id); },
    pw: async () => { await modal('Restablecer contraseña', html`<div class="field"><label>Nueva contraseña (mín. 8)</label><input name="password" type="password" minlength="8" required></div>`, { onSubmit: (d) => api('PATCH', `/api/admin/users/${u.id}`, d) }); },
  });
}

export async function config(el) {
  const c = await api('GET', '/api/admin/config');
  const numbers = [['extraordinary_expense_threshold', 'Umbral de gasto extraordinario'], ['maintenance_approval_threshold', 'Umbral de aprobación de mantenimiento'],
    ['reprogram_min_hours', 'Anticipación mínima para reprogramar (h)'], ['inspection_min_photos', 'Fotos mínimas en inspección'],
    ['service_due_km_window', 'Aviso de servicio (km antes)'], ['service_due_days_window', 'Aviso de servicio (días antes)']];
  const lists = [['expense_categories', 'Categorías de gasto'], ['incident_types', 'Tipos de incidencia'], ['exception_types', 'Excepciones operativas permitidas'],
    ['inspection_checklist', 'Checklist de inspección (critical: true bloquea la salida)'], ['extraordinary_categories', 'Categorías siempre extraordinarias']];
  render(el, html`<h1>Configuración</h1>
    <div class="card"><h2 style="margin-top:0">Umbrales y parámetros</h2>
      ${numbers.map(([k, l]) => html`<form class="actions" data-act="num" data-k="${k}" style="align-items:flex-end"><div style="flex:1"><label>${l}</label><input type="number" min="0" step="any" name="v" value="${c[k]}"></div><button class="btn">Guardar</button></form>`)}
      <form class="actions" data-act="str" data-k="currency" style="align-items:flex-end"><div style="flex:1"><label>Moneda (código ISO)</label><input name="v" value="${c.currency}" maxlength="3"></div><button class="btn">Guardar</button></form>
    </div>
    ${lists.map(([k, l]) => html`<form class="card" data-act="json" data-k="${k}"><h3 style="margin-top:0">${l}</h3><textarea name="v" rows="8" style="font-family:monospace;font-size:.85rem">${JSON.stringify(c[k], null, 2)}</textarea><button class="btn">Guardar</button></form>`)}`);
  const save = (k, value) => act(() => api('PUT', `/api/admin/config/${k}`, { value }), 'Configuración guardada');
  bind(el, {
    num: (ds, f) => save(ds.k, Number(f.v.value)),
    str: (ds, f) => save(ds.k, f.v.value.toUpperCase()),
    json: (ds, f) => { let v; try { v = JSON.parse(f.v.value); } catch { return act(() => { throw new Error('JSON inválido'); }); } return save(ds.k, v); },
  });
}

export async function integrations(el) {
  const rows = await api('GET', '/api/admin/integrations');
  const names = { email: 'Correo electrónico', whatsapp: 'WhatsApp' };
  render(el, html`<h1>Integraciones</h1>
    <p class="notice">Opcionales. Las notificaciones siempre se registran dentro de la aplicación; si activa un canal, se encola el mismo texto ya filtrado según los permisos del destinatario.</p>
    ${rows.map((i) => html`<div class="card split"><div><strong>${names[i.code] || i.code}</strong><br><span class="small muted">${i.updated_at ? 'Actualizado ' + dt(i.updated_at) : 'Sin configurar'}</span></div>
      <button class="btn ${i.enabled ? 'danger' : 'primary'}" data-act="toggle" data-c="${i.code}" data-on="${i.enabled ? 1 : 0}">${i.enabled ? 'Desactivar' : 'Activar'}</button></div>`)}`);
  bind(el, { toggle: async (ds) => { if (await act(() => api('PUT', `/api/admin/integrations/${ds.c}`, { enabled: ds.on !== '1' }), 'Integración actualizada')) integrations(el); } });
}

export async function audit(el) {
  const kind = new URLSearchParams(location.hash.split('?')[1] || '').get('tipo') || 'acceso';
  const rows = await api('GET', `/api/audit?kind=${kind}`);
  render(el, html`<div class="split"><h1>Auditoría</h1><select id="k" style="width:auto"><option value="acceso" ${kind === 'acceso' ? 'selected' : ''}>Accesos</option><option value="tecnico" ${kind === 'tecnico' ? 'selected' : ''}>Técnica</option></select></div>
    <div class="card">${table([{ h: 'Fecha', v: (a) => html`<span class="nowrap">${dt(a.at)}</span>` }, { h: 'Usuario', v: (a) => a.user_name || '—' }, { h: 'Acción', v: (a) => label(a.action) },
      { h: 'Detalle', v: (a) => html`<code class="small">${a.data ? JSON.stringify(a.data).slice(0, 200) : ''}</code>` }, { h: 'Motivo', v: (a) => a.reason || '' }], rows)}</div>`);
  el.querySelector('#k').onchange = (e) => navigate(`/admin/auditoria?tipo=${e.target.value}`);
}
