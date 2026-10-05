'use strict';
// Acceso a datos sobre SQLite nativo de Node (node:sqlite). Sin dependencias externas.
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  password_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  client_id INTEGER REFERENCES clients(id),
  created_at TEXT NOT NULL,
  created_by INTEGER
);

-- Un usuario puede tener varios perfiles (empresas pequeñas).
CREATE TABLE IF NOT EXISTS user_roles (
  user_id INTEGER NOT NULL REFERENCES users(id),
  role TEXT NOT NULL,
  granted_by INTEGER,
  granted_at TEXT NOT NULL,
  PRIMARY KEY (user_id, role)
);

-- Permisos adicionales explícitos (p. ej. ingresos y márgenes para un coordinador).
CREATE TABLE IF NOT EXISTS user_permissions (
  user_id INTEGER NOT NULL REFERENCES users(id),
  permission TEXT NOT NULL,
  granted_by INTEGER,
  granted_at TEXT NOT NULL,
  PRIMARY KEY (user_id, permission)
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by INTEGER
);

CREATE TABLE IF NOT EXISTS integrations (
  code TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0,
  settings TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT,
  updated_by INTEGER
);

CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY,
  channel TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  destination TEXT,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pendiente',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  tax_id TEXT,
  contact TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS vehicles (
  id INTEGER PRIMARY KEY,
  plate TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('tractor','remolque')),
  brand TEXT,
  model TEXT,
  year INTEGER,
  capacity TEXT,
  odometer INTEGER NOT NULL DEFAULT 0,
  next_service_km INTEGER,
  next_service_date TEXT,
  notes TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

-- Inmovilizaciones: restricción técnica crítica. Solo mantenimiento la levanta (liberación técnica).
CREATE TABLE IF NOT EXISTS immobilizations (
  id INTEGER PRIMARY KEY,
  vehicle_id INTEGER NOT NULL REFERENCES vehicles(id),
  reason TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'mantenimiento',
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  released_at TEXT,
  released_by INTEGER,
  release_notes TEXT
);

CREATE TABLE IF NOT EXISTS trips (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  client_id INTEGER REFERENCES clients(id),
  origin TEXT NOT NULL,
  destination TEXT NOT NULL,
  cargo TEXT,
  instructions TEXT,
  scheduled_start TEXT NOT NULL,
  scheduled_end TEXT NOT NULL,
  vehicle_id INTEGER REFERENCES vehicles(id),
  trailer_id INTEGER REFERENCES vehicles(id),
  driver_id INTEGER REFERENCES users(id),
  coordinator_id INTEGER REFERENCES users(id),
  status TEXT NOT NULL,
  revenue_agreed REAL,
  budget_cost REAL,
  km_start INTEGER,
  km_end INTEGER,
  confirmed_at TEXT,
  started_at TEXT,
  driver_end_reported_at TEXT,
  close_requested_at TEXT,
  ops_closed_at TEXT,
  ops_closed_by INTEGER,
  fin_closed_at TEXT,
  fin_closed_by INTEGER,
  fin_revenue REAL,
  fin_cost REAL,
  fin_margin REAL,
  cancel_reason TEXT,
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Eventos operativos reportados (inmutables). Las correcciones se agregan como nuevos eventos.
CREATE TABLE IF NOT EXISTS trip_events (
  id INTEGER PRIMARY KEY,
  trip_id INTEGER NOT NULL REFERENCES trips(id),
  type TEXT NOT NULL,
  at TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  odometer INTEGER,
  notes TEXT,
  client_uuid TEXT,
  UNIQUE (user_id, client_uuid)
);

CREATE TABLE IF NOT EXISTS inspections (
  id INTEGER PRIMARY KEY,
  trip_id INTEGER NOT NULL REFERENCES trips(id),
  vehicle_id INTEGER NOT NULL REFERENCES vehicles(id),
  driver_id INTEGER NOT NULL,
  items TEXT NOT NULL,
  photo_ids TEXT NOT NULL DEFAULT '[]',
  odometer INTEGER,
  result TEXT NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL,
  client_uuid TEXT,
  UNIQUE (driver_id, client_uuid)
);

CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY,
  owner_id INTEGER NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  data BLOB NOT NULL,
  entity_type TEXT,
  entity_id INTEGER,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY,
  trip_id INTEGER NOT NULL REFERENCES trips(id),
  vehicle_id INTEGER,
  category TEXT NOT NULL,
  amount REAL NOT NULL,
  liters REAL,
  odometer INTEGER,
  description TEXT,
  supplier TEXT,
  receipt_number TEXT,
  receipt_date TEXT,
  receipt_file_id INTEGER REFERENCES files(id),
  receipt_sha256 TEXT,
  extraordinary INTEGER NOT NULL DEFAULT 0,
  approval_status TEXT NOT NULL DEFAULT 'no_requerida',
  validation_status TEXT NOT NULL DEFAULT 'pendiente',
  validation_reason TEXT,
  validated_by INTEGER,
  validated_at TEXT,
  possible_duplicate_of INTEGER,
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  client_uuid TEXT,
  UNIQUE (created_by, client_uuid)
);

CREATE TABLE IF NOT EXISTS incidents (
  id INTEGER PRIMARY KEY,
  trip_id INTEGER REFERENCES trips(id),
  vehicle_id INTEGER REFERENCES vehicles(id),
  type TEXT NOT NULL,
  severity TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'abierta',
  resolution TEXT,
  resolved_by INTEGER,
  resolved_at TEXT,
  communicated_to_client INTEGER NOT NULL DEFAULT 0,
  reported_by INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  client_uuid TEXT,
  UNIQUE (reported_by, client_uuid)
);

CREATE TABLE IF NOT EXISTS work_orders (
  id INTEGER PRIMARY KEY,
  vehicle_id INTEGER NOT NULL REFERENCES vehicles(id),
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  title TEXT NOT NULL,
  scheduled_date TEXT,
  diagnosis TEXT,
  works TEXT,
  parts TEXT NOT NULL DEFAULT '[]',
  labor_cost REAL NOT NULL DEFAULT 0,
  parts_cost REAL NOT NULL DEFAULT 0,
  budget_amount REAL,
  budget_status TEXT NOT NULL DEFAULT 'no_requerido',
  entered_at TEXT,
  exited_at TEXT,
  incident_id INTEGER REFERENCES incidents(id),
  closed_cost REAL,
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Solicitudes de aprobación. Pendiente != autorizada.
CREATE TABLE IF NOT EXISTS approvals (
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL,
  subtype TEXT,
  entity_type TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  amount REAL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pendiente',
  requested_by INTEGER NOT NULL,
  requested_at TEXT NOT NULL,
  decided_by INTEGER,
  decided_at TEXT,
  decision_reason TEXT
);

-- Costos asignados y ajustes financieros (nunca se edita un costo cerrado: se agrega un ajuste).
CREATE TABLE IF NOT EXISTS cost_entries (
  id INTEGER PRIMARY KEY,
  trip_id INTEGER NOT NULL REFERENCES trips(id),
  kind TEXT NOT NULL CHECK (kind IN ('asignado','ajuste')),
  concept TEXT NOT NULL,
  amount REAL NOT NULL,
  reason TEXT,
  after_close INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS drafts (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  trip_id INTEGER,
  payload TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, kind, trip_id)
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  entity_type TEXT,
  entity_id INTEGER,
  created_at TEXT NOT NULL,
  read_at TEXT
);

-- Trazabilidad. kind: negocio | tecnico | acceso. Sin borrado.
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  user_id INTEGER,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id INTEGER,
  reason TEXT,
  data TEXT
);

CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'El historial de auditoría no se puede eliminar'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'El historial de auditoría no se puede modificar'); END;
CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON trip_events
BEGIN SELECT RAISE(ABORT, 'Los eventos operativos reportados no se modifican'); END;
CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON trip_events
BEGIN SELECT RAISE(ABORT, 'Los eventos operativos reportados no se eliminan'); END;
CREATE TRIGGER IF NOT EXISTS expenses_no_delete BEFORE DELETE ON expenses
BEGIN SELECT RAISE(ABORT, 'Los gastos enviados no se eliminan'); END;
CREATE TRIGGER IF NOT EXISTS cost_entries_no_change BEFORE UPDATE ON cost_entries
BEGIN SELECT RAISE(ABORT, 'Los ajustes registrados no se modifican'); END;

CREATE INDEX IF NOT EXISTS idx_trips_driver ON trips(driver_id);
CREATE INDEX IF NOT EXISTS idx_trips_status ON trips(status);
CREATE INDEX IF NOT EXISTS idx_expenses_trip ON expenses(trip_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read_at);
`;

function open(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  return wrap(db);
}

function wrap(raw) {
  const cache = new Map();
  const stmt = (sql) => {
    let s = cache.get(sql);
    if (!s) { s = raw.prepare(sql); cache.set(sql, s); }
    return s;
  };
  const norm = (row) => (row ? { ...row } : row);
  let depth = 0;
  return {
    raw,
    get: (sql, ...p) => norm(stmt(sql).get(...p)),
    all: (sql, ...p) => stmt(sql).all(...p).map(norm),
    run: (sql, ...p) => stmt(sql).run(...p),
    exec: (sql) => raw.exec(sql),
    insert(table, obj) {
      const keys = Object.keys(obj);
      const sql = `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`;
      return Number(stmt(sql).run(...keys.map((k) => obj[k])).lastInsertRowid);
    },
    update(table, id, obj) {
      const keys = Object.keys(obj);
      if (!keys.length) return;
      const sql = `UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`;
      stmt(sql).run(...keys.map((k) => obj[k]), id);
    },
    // Transacción anidable (savepoints).
    tx(fn) {
      const name = `sp${depth++}`;
      raw.exec(`SAVEPOINT ${name}`);
      try {
        const r = fn();
        raw.exec(`RELEASE ${name}`);
        return r;
      } catch (e) {
        raw.exec(`ROLLBACK TO ${name}`);
        raw.exec(`RELEASE ${name}`);
        throw e;
      } finally {
        depth--;
      }
    },
    close: () => raw.close(),
  };
}

module.exports = { open };
