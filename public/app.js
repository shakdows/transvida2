import { state, api, html, render, toast, dt, ls, bind, navigate } from './lib.js';
import { outbox } from './outbox.js';
import * as common from './views/common.js';
import * as driver from './views/driver.js';
import * as ops from './views/ops.js';
import * as mgmt from './views/mgmt.js';
import * as maint from './views/maint.js';
import * as fin from './views/finance.js';
import * as admin from './views/admin.js';

// Navegación y pantalla inicial de cada espacio de trabajo.
const WORKSPACES = {
  gerencia: { nav: [['resumen', 'Resumen ejecutivo', mgmt.executive], ['rentabilidad', 'Rentabilidad', mgmt.profitability], ['viajes', 'Viajes', common.tripList],
    ['flota', 'Flota', common.fleet], ['aprobaciones', 'Aprobaciones', common.approvals], ['historial', 'Historial de decisiones', mgmt.history], ['reportes', 'Reportes', mgmt.reports]] },
  operaciones: { nav: [['tablero', 'Tablero operativo', ops.board], ['viajes', 'Viajes', common.tripList], ['disponibilidad', 'Disponibilidad', ops.availability],
    ['incidencias', 'Incidencias', common.incidents], ['gastos', 'Gastos por revisar', common.expenses], ['aprobaciones', 'Autorizaciones', common.approvals]] },
  conductor: { nav: [['mi-viaje', 'Mi viaje', driver.myTrip, '🚚'], ['historial', 'Historial', driver.history, '🗂'], ['gastos', 'Gastos', driver.expenses, '🧾'],
    ['incidencias', 'Incidencias', driver.incidents, '⚠'], ['pendientes', 'Envíos', driver.pending, '⇅']] },
  mantenimiento: { nav: [['taller', 'Taller', maint.workshop], ['unidades', 'Unidades', common.fleet], ['ordenes', 'Órdenes de trabajo', maint.orders],
    ['inspecciones', 'Inspecciones e incidencias', maint.inspections], ['programacion', 'Programación de viajes', common.tripList], ['aprobaciones', 'Mis solicitudes', common.approvals]] },
  finanzas: { nav: [['por-validar', 'Pendientes', fin.home], ['gastos', 'Gastos', common.expenses], ['resultados', 'Resultados', fin.results],
    ['aprobaciones', 'Autorizaciones', common.approvals], ['exportar', 'Exportar', fin.exports]] },
  admin: { nav: [['usuarios', 'Usuarios y accesos', admin.users], ['configuracion', 'Configuración', admin.config], ['integraciones', 'Integraciones', admin.integrations],
    ['auditoria', 'Auditoría', admin.audit]] },
};
// Vistas de detalle accesibles desde cualquier espacio (el servidor decide qué datos devuelve).
const DETAIL = { viaje: common.tripDetail, unidad: common.vehicleDetail, orden: maint.orderDetail, usuario: admin.userDetail };

async function boot() {
  try { state.me = await api('GET', '/api/me'); state.config = await api('GET', '/api/config/public'); }
  catch { state.me = null; }
  window.addEventListener('hashchange', route);
  route();
}

async function route() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const app = document.getElementById('app');
  if (!state.me) {
    if (parts[0] !== 'login') return navigate('/login');
    return loginView(app);
  }
  if (parts[0] === 'login' || !parts.length) return goHome();
  const [ws, view, id] = parts;
  const w = state.me.workspaces.find((x) => x.code === ws);
  if (!w) return goHome();
  state.workspace = ws;
  ls.set('tv_ws', ws);
  const def = WORKSPACES[ws];
  let renderFn = def.nav.find((n) => n[0] === view)?.[2];
  if (DETAIL[view]) renderFn = (el) => DETAIL[view](el, id);
  if (!renderFn) return navigate(`/${ws}/${w.home}`);

  document.documentElement.classList.toggle('driver', ws === 'conductor');
  render(app, layout(ws, view));
  bindLayout(app);
  const content = app.querySelector('.content');
  content.innerHTML = '<p class="muted">Cargando…</p>';
  try { await renderFn(content, id); }
  catch (e) {
    content.innerHTML = html`<div class="notice bad">${e.status === 404 ? 'El registro no existe o no tiene acceso a él.' : e.status === 403 ? 'No tiene permiso para ver esta sección.' : e instanceof TypeError ? 'Sin conexión con el servidor.' : e.message}</div>`.s;
  }
}

function goHome() {
  if (!state.me.workspaces.length) {
    render(document.getElementById('app'), html`<div class="login card"><h1>TRANSVIDA</h1><p>Su usuario no tiene un espacio de trabajo asignado. Contacte al administrador.</p><button class="btn" id="lo">Salir</button></div>`);
    document.getElementById('lo').onclick = logout;
    return;
  }
  const saved = ls.get('tv_ws');
  const w = state.me.workspaces.find((x) => x.code === saved) || state.me.workspaces[0];
  navigate(`/${w.code}/${w.home}`);
}

function layout(ws, view) {
  const def = WORKSPACES[ws];
  const pending = outbox.count();
  const wsSel = state.me.workspaces.length > 1
    ? html`<select id="ws-switch" aria-label="Espacio de trabajo" style="width:auto">${state.me.workspaces.map((w) => html`<option value="${w.code}" ${w.code === ws ? 'selected' : ''}>${w.label}</option>`)}</select>`
    : html`<span class="muted small">${state.me.workspaces[0].label}</span>`;
  return html`<div class="shell">
    <nav class="side" aria-label="Navegación">
      <div class="logo">TRANSVIDA</div>
      ${def.nav.map(([k, l]) => html`<a href="#/${ws}/${k}" class="${k === view ? 'active' : ''}">${l}</a>`)}
      <div class="ws">${state.me.name}</div>
    </nav>
    <div class="main">
      ${ws === 'conductor' || pending ? html`<div class="sync-bar" ${pending ? '' : 'hidden'}><span>${pending} registro(s) pendiente(s) de sincronización</span><a href="#/conductor/pendientes">Ver</a></div>` : ''}
      <header class="top">
        <strong class="grow">${ws === 'conductor' ? 'TRANSVIDA' : ''}</strong>
        ${wsSel}
        <button class="btn ghost bell" id="bell" aria-label="Notificaciones">🔔${state.me.unread ? html`<span class="dot">${state.me.unread}</span>` : ''}</button>
        <button class="btn ghost" id="logout">Salir</button>
      </header>
      <main class="content"></main>
    </div>
    ${ws === 'conductor' ? html`<nav class="bottom-nav">${def.nav.map(([k, l, , ic]) => html`<a href="#/${ws}/${k}" class="${k === view ? 'active' : ''}"><span class="ic">${ic}</span>${l}${k === 'pendientes' ? html`<span class="badge" ${pending ? '' : 'hidden'}>${pending}</span>` : ''}</a>`)}</nav>` : ''}
  </div>`;
}

function bindLayout(app) {
  app.querySelector('#logout').onclick = logout;
  const sw = app.querySelector('#ws-switch');
  if (sw) sw.onchange = () => { const w = state.me.workspaces.find((x) => x.code === sw.value); navigate(`/${w.code}/${w.home}`); };
  app.querySelector('#bell').onclick = toggleNotifications;
}

async function toggleNotifications() {
  const existing = document.querySelector('.panel');
  if (existing) { existing.remove(); return; }
  const data = await api('GET', '/api/notifications');
  const p = document.createElement('div');
  p.className = 'panel';
  const link = (n) => (n.entity_type === 'trip' ? `#/${state.workspace}/viaje/${n.entity_id}` : n.entity_type === 'approval' ? `#/${state.workspace}/aprobaciones` : null);
  p.innerHTML = html`<div class="n split"><strong>Notificaciones</strong><button class="btn ghost small" id="readall">Marcar todo como leído</button></div>
    ${data.items.length ? data.items.map((n) => html`<div class="n ${n.read_at ? '' : 'unread'}"><div><strong>${n.title}</strong></div><div class="small">${n.body}</div>
      <div class="small muted">${dt(n.created_at)} ${link(n) ? html`· <a href="${link(n)}">Abrir</a>` : ''}</div></div>`) : html`<div class="n muted">Sin notificaciones</div>`}`.s;
  document.body.appendChild(p);
  p.querySelector('#readall').onclick = async () => { await api('POST', '/api/notifications/read', {}); state.me.unread = 0; p.remove(); route(); };
  p.querySelectorAll('a').forEach((a) => a.addEventListener('click', () => p.remove()));
}

async function logout() {
  try { await api('POST', '/api/auth/logout', {}); } catch { /* noop */ }
  state.me = null;
  navigate('/login');
}

const DEMO = [['gerencia', 'Gerencia'], ['operaciones', 'Operaciones'], ['operaciones2', 'Operaciones + márgenes'], ['conductor', 'Conductor (Juan)'],
  ['conductor2', 'Conductor (Pedro)'], ['mantenimiento', 'Mantenimiento'], ['finanzas', 'Finanzas'], ['admin', 'Administrador'], ['dueno', 'Gerencia + Operaciones']];

function loginView(app) {
  document.documentElement.classList.remove('driver');
  render(app, html`<div class="login">
    <div class="card">
      <h1>TRANSVIDA</h1><p class="muted">Gestión de flota y viajes</p>
      <form data-act="login">
        <div class="field"><label for="u">Usuario</label><input id="u" name="username" autocomplete="username" required></div>
        <div class="field"><label for="p">Contraseña</label><input id="p" name="password" type="password" autocomplete="current-password" required></div>
        <button class="btn primary" style="width:100%;justify-content:center">Ingresar</button>
      </form>
    </div>
    <div class="card demo-accounts"><p class="small muted">Cuentas de demostración (contraseña <code>demo1234</code>):</p>
      ${DEMO.map(([u, l]) => html`<button class="btn small" data-act="demo" data-u="${u}">${l}</button>`)}</div>
  </div>`);
  const doLogin = async (username, password) => {
    try {
      await api('POST', '/api/auth/login', { username, password });
      state.me = await api('GET', '/api/me');
      state.config = await api('GET', '/api/config/public');
      ls.del('tv_ws');
      goHome();
    } catch (e) { toast(e.message, true); }
  };
  bind(app, {
    login: (_, form) => { const f = new FormData(form); doLogin(f.get('username'), f.get('password')); },
    demo: (ds) => doLogin(ds.u, 'demo1234'),
  });
}

// Sincronización de registros pendientes (conductor sin conexión).
// Actualiza los indicadores sin volver a dibujar la pantalla (no se pierde un formulario abierto).
outbox.onChange = () => {
  const n = outbox.count();
  const bar = document.querySelector('.sync-bar span');
  if (bar) bar.textContent = `${n} registro(s) pendiente(s) de sincronización`;
  document.querySelector('.sync-bar')?.toggleAttribute('hidden', !n);
  const badge = document.querySelector('.bottom-nav .badge');
  if (badge) { badge.textContent = n; badge.hidden = !n; }
};
window.addEventListener('online', () => outbox.sync());
// Filas navegables (delegación global).
document.addEventListener('click', (e) => {
  const row = e.target.closest('[data-href]');
  if (row && !e.target.closest('a,button,input,select')) navigate(row.dataset.href);
});
setInterval(() => { if (state.me && outbox.count()) outbox.sync(); }, 30000);

boot();
