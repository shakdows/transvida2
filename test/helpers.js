'use strict';
const { open } = require('../src/db');
const { createApp } = require('../src/app');
const { seed, DEMO_PASSWORD } = require('../src/seed');

// PNG 1x1 para fotografías y comprobantes.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

async function startServer() {
  const db = open(':memory:');
  const ids = seed(db);
  const server = createApp(db);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  async function raw(method, path, { token, body, headers = {} } = {}) {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data = text;
    try { data = JSON.parse(text); } catch { /* csv / binario */ }
    return { status: res.status, data, headers: res.headers };
  }

  const sessions = {};
  async function as(username) {
    if (!sessions[username]) {
      const r = await raw('POST', '/api/auth/login', { body: { username, password: DEMO_PASSWORD } });
      if (r.status !== 200) throw new Error(`login ${username}: ${r.status}`);
      sessions[username] = r.data.token;
    }
    const token = sessions[username];
    const c = (m) => (path, body) => raw(m, path, { token, body });
    return { get: c('GET'), post: c('POST'), patch: c('PATCH'), put: c('PUT'), del: c('DELETE'), token, id: ids[username] };
  }

  const hours = (h) => new Date(Date.now() + h * 3600e3).toISOString();
  return { db, ids, base, raw, as, hours, close: () => new Promise((r) => server.close(r)) };
}

const uuid = () => require('node:crypto').randomUUID();

module.exports = { startServer, PNG, uuid };
