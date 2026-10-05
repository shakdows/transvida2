'use strict';
const http = require('node:http');
const path = require('node:path');
const { HttpError, readBody, parseCookies, send, serveStatic } = require('./http');
const { userFromToken } = require('./auth');
const { audit } = require('./core');
const routes = require('./routes');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function createApp(db) {
  const router = routes.build();
  // Rutas públicas (sin sesión).
  const PUBLIC = new Set(['POST /api/auth/login']);

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');

    if (!pathname.startsWith('/api/')) {
      if (req.method === 'GET' && serveStatic(PUBLIC_DIR, pathname, res)) return;
      if (req.method === 'GET' && serveStatic(PUBLIC_DIR, '/index.html', res)) return;
      return send(res, 404, { error: 'no_encontrado' });
    }

    let user = null;
    try {
      const m = router.match(req.method, pathname);
      if (!m) throw new HttpError(404, 'no_encontrado', 'Ruta inexistente');
      if (m.methodNotAllowed) throw new HttpError(405, 'metodo', 'Método no permitido');

      // Protección CSRF: las mutaciones deben enviarse como JSON (no posible desde formularios de otro sitio).
      if (req.method !== 'GET' && req.headers['content-length'] !== '0' && req.headers['content-length'] !== undefined
        && !String(req.headers['content-type'] || '').startsWith('application/json')) {
        throw new HttpError(415, 'tipo', 'Se requiere application/json');
      }

      const cookies = parseCookies(req.headers.cookie);
      const bearer = /^Bearer (.+)$/.exec(req.headers.authorization || '');
      const token = bearer ? bearer[1] : cookies.tv_session;
      if (!PUBLIC.has(`${req.method} ${pathname}`)) {
        user = userFromToken(db, token);
        if (!user) throw new HttpError(401, 'sin_sesion', 'Sesión no válida o expirada');
      }
      const body = req.method === 'GET' ? {} : await readBody(req);
      const query = Object.fromEntries(url.searchParams);
      const result = await m.handler({ db, req, res, user, token, body, query, params: m.params, ip: req.socket.remoteAddress });
      if (result !== undefined && !res.headersSent) send(res, 200, result);
    } catch (err) {
      if (err instanceof HttpError) {
        // Registro de intentos de acceso indebido (403/404 sobre registros).
        if (user && (err.status === 403 || (err.status === 404 && pathname.match(/\/\d+/)))) {
          try { audit(db, { kind: 'acceso', user, action: err.status === 403 ? 'acceso_denegado' : 'registro_no_disponible', data: { method: req.method, path: pathname } }); } catch { /* noop */ }
        }
        return send(res, err.status, { error: err.code, message: err.message, ...(err.extra || {}) });
      }
      console.error(err);
      return send(res, 500, { error: 'interno', message: 'Error interno' });
    }
  });
}

module.exports = { createApp };
