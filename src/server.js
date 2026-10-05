'use strict';
const path = require('node:path');
const { open } = require('./db');
const { createApp } = require('./app');
const { seed } = require('./seed');

const file = process.env.TRANSVIDA_DB || path.join(__dirname, '..', 'data', 'transvida.db');
const db = open(file);
if (!db.get('SELECT id FROM users LIMIT 1')) {
  seed(db);
  console.log('Base de datos inicializada con cuentas de demostración (ver README).');
}
const port = Number(process.env.PORT || 3000);
createApp(db).listen(port, () => console.log(`TRANSVIDA escuchando en http://localhost:${port}`));
