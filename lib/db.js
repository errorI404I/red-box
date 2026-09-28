import { DatabaseSync } from 'node:sqlite';
export class Store {
  constructor(path) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS devices (id INTEGER PRIMARY KEY, mac TEXT UNIQUE NOT NULL, hostname TEXT, alias TEXT, ip TEXT, connection TEXT, rssi INTEGER, assignment TEXT, online INTEGER NOT NULL, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, critical INTEGER NOT NULL DEFAULT 0, category TEXT);
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, timestamp TEXT NOT NULL, device_id INTEGER REFERENCES devices(id), type TEXT NOT NULL, message TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS alerts (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  }
  get(key) { return this.db.prepare('SELECT value FROM alerts WHERE key=?').get(key)?.value; }
  set(key, value) { this.db.prepare('INSERT INTO alerts VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value)); }
  devices() { return this.db.prepare('SELECT * FROM devices ORDER BY online DESC, id DESC').all(); }
  events() { return this.db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT 100').all(); }
  event(type, message, device = null, time = new Date().toISOString()) {
    this.db.prepare('INSERT INTO events(timestamp,device_id,type,message) VALUES (?,?,?,?)').run(time, device?.id ?? null, type, message);
    return {type, message, device};
  }
  updateDevice(id, {alias, category, critical}) {
    return this.db.prepare('UPDATE devices SET alias=?,category=?,critical=? WHERE id=?').run(alias || null, category || null, +critical, id).changes;
  }
  apply(devices, time = new Date().toISOString()) {
    const changes = []; const seen = new Set();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const d of devices) {
        seen.add(d.mac);
        const old = this.db.prepare('SELECT * FROM devices WHERE mac=?').get(d.mac);
        if (!old) {
          const result = this.db.prepare('INSERT INTO devices(mac,hostname,ip,connection,rssi,assignment,online,first_seen,last_seen) VALUES (?,?,?,?,?,?,1,?,?)').run(d.mac,d.hostname,d.ip,d.connection,d.rssi,d.assignment,time,time);
          const current = {...d, id:Number(result.lastInsertRowid), critical:0};
          changes.push(this.event('new', `Nuevo dispositivo: ${d.hostname || d.mac}`, current, time));
        } else {
          const label = old.alias || d.hostname || d.mac;
          if (!old.online) changes.push(this.event('online', `${label} reaparece`, old,time));
          for (const [field, type, name] of [['ip','ip','IP'],['connection','connection','conexión'],['hostname','hostname','hostname']]) {
            if (old[field] !== d[field]) changes.push(this.event(type, `${label}: ${name} ${old[field] ?? '—'} → ${d[field] ?? '—'}`,old,time));
          }
          this.db.prepare('UPDATE devices SET hostname=?,ip=?,connection=?,rssi=?,assignment=?,online=1,last_seen=? WHERE id=?').run(d.hostname,d.ip,d.connection,d.rssi,d.assignment,time,old.id);
        }
      }
      for (const old of this.devices()) if (old.online && !seen.has(old.mac)) {
        this.db.prepare('UPDATE devices SET online=0 WHERE id=?').run(old.id);
        changes.push(this.event('offline', `${old.alias || old.hostname || old.mac} desaparece`,old,time));
      }
      this.db.exec('COMMIT'); return changes;
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  close() { this.db.close(); }
}
