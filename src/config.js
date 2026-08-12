const db = require('./db');

const DEFAULTS = {
  mc_host: '',
  mc_port: '25565',
  mc_username: '',
  mc_auth: 'microsoft',
  sphere_price: '80000000',
  sphere_item_name: 'sphere_of_erida',
  coord_chest: '0,64,0',
  coord_anvil: '0,64,0',
  coord_shulker: '0,64,0',
  viewer_port: '3007',
};

function get(key) {
  const row = db.prepare(`SELECT value FROM config WHERE key = ?`).get(key);
  return row ? row.value : DEFAULTS[key];
}

function set(key, value) {
  db.prepare(
    `INSERT INTO config (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, String(value));
}

function getAll() {
  const rows = db.prepare(`SELECT key, value FROM config`).all();
  const map = { ...DEFAULTS };
  for (const r of rows) map[r.key] = r.value;
  return map;
}

function getCoord(key) {
  const raw = get(key);
  const [x, y, z] = raw.split(',').map(Number);
  return { x, y, z };
}

function isReadyToConnect() {
  const cfg = getAll();
  return Boolean(cfg.mc_host && cfg.mc_username);
}

module.exports = { get, set, getAll, getCoord, isReadyToConnect, DEFAULTS };
