// Cola de envíos del conductor. Cada registro lleva un identificador único (client_uuid):
// si se reenvía tras una pérdida de conexión, el servidor devuelve el registro existente
// en lugar de crear un duplicado.
import { api, ApiError, state, ls, uuid } from './lib.js';

const key = () => `tv_outbox_${state.me?.id || 'anon'}`;
let syncing = false;

export const outbox = {
  onChange: null,
  items() { return ls.get(key(), []); },
  count() { return this.items().filter((i) => i.status === 'pendiente').length; },
  save(items) { ls.set(key(), items); this.onChange?.(); },

  /**
   * Envía un registro; si no hay conexión, lo deja pendiente de sincronización.
   * files: { campo: dataUrl | [dataUrl] } se suben antes del envío.
   */
  async submit({ label, method = 'POST', path, body = {}, files = {} }) {
    const item = { id: uuid(), label, method, path, body, files, created_at: new Date().toISOString(), status: 'pendiente' };
    const items = this.items(); items.push(item); this.save(items);
    const r = await this.send(item);
    return r;
  },

  async send(item) {
    try {
      const body = { ...item.body, client_uuid: item.id };
      for (const [field, val] of Object.entries(item.files || {})) {
        if (Array.isArray(val)) {
          body[field] = [];
          for (const dataUrl of val) body[field].push((await api('POST', '/api/files', { data: dataUrl })).id);
        } else if (val) body[field] = (await api('POST', '/api/files', { data: val })).id;
      }
      const result = await api(item.method, item.path, body);
      this.remove(item.id);
      return { sent: true, result };
    } catch (e) {
      if (e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429) {
        // El servidor rechazó el registro: no se reintenta automáticamente.
        this.update(item.id, { status: 'error', error: e.message });
        return { error: e.message };
      }
      this.update(item.id, { status: 'pendiente', error: navigator.onLine ? 'Servidor no disponible' : 'Sin conexión' });
      return { queued: true };
    }
  },

  update(id, patch) { this.save(this.items().map((i) => (i.id === id ? { ...i, ...patch } : i))); },
  remove(id) { this.save(this.items().filter((i) => i.id !== id)); },

  async sync() {
    if (syncing) return;
    syncing = true;
    try {
      for (const item of this.items().filter((i) => i.status === 'pendiente')) {
        const r = await this.send(item);
        if (r.queued) break;
      }
    } finally { syncing = false; }
  },
};
