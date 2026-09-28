import https from 'node:https';
import { Duplex, Transform } from 'node:stream';
export class RouterError extends Error {
  constructor(code, message, cause) { super(message, { cause }); this.name = 'RouterError'; this.code = code; }
}
function connectionError(error) {
  if (error instanceof RouterError) return error;
  const code = error.code === 'ECONNREFUSED' ? 'CONNECTION_REFUSED'
    : /TLS|CERT|SSL/.test(error.code || '') ? 'TLS'
    : ['TIMEOUT', 'ETIMEDOUT', 'ESOCKETTIMEDOUT'].includes(error.code) ? 'TIMEOUT'
    : error.code === 'ABORT_ERR' || error.name === 'AbortError' ? 'ABORT'
    : 'CONNECTION';
  return new RouterError(code, 'Falló la conexión con el router', error);
}
export const encodePassword = password => Buffer.from(password, 'utf8').toString('base64');
// llhttp can reject whitespace in header names even with insecureHTTPParser.
// Normalize only trailing whitespace before ':' in response headers. The body
// (including chunk framing) passes through byte-for-byte. One response per socket.
class RouterAgent extends https.Agent {
  createConnection(options) {
    const socket = super.createConnection(options);
    let pending = Buffer.alloc(0), headersDone = false;
    const normalize = new Transform({
      transform(chunk, encoding, callback) {
        if (headersDone) { callback(null, chunk); return; }
        pending = Buffer.concat([pending, chunk]);
        while (!headersDone) {
          const end = pending.indexOf('\r\n\r\n');
          if ((end < 0 ? pending.length : end + 4) > 16384) {
            callback(new RouterError('HPE_HEADER_OVERFLOW', 'Headers del router demasiado grandes')); return;
          }
          if (end < 0) { callback(); return; }
          const header = pending.subarray(0, end + 4).toString('latin1');
          this.push(Buffer.from(header.replace(/\r\n([!#$%&'*+\-.^_`|~\da-z]+)[ \t]+:/gi, '\r\n$1:'), 'latin1'));
          pending = pending.subarray(end + 4);
          headersDone = !/^HTTP\/1\.[01] 1\d\d\b/.test(header);
        }
        this.push(pending); pending = Buffer.alloc(0); callback();
      },
      flush(callback) {
        callback(headersDone ? null : new RouterError('HPE_INVALID_HEADER_TOKEN', 'Headers del router incompletos'));
      }
    });
    // Explicit ownership avoids Duplex.from()/Duplexify generating AbortError
    // when the HTTP agent destroys a completed, non-keep-alive connection.
    const stream = new Duplex({
      read() { normalize.resume(); },
      write(chunk, encoding, callback) { socket.write(chunk, encoding, callback); },
      final(callback) { socket.end(callback); },
      destroy(error, callback) {
        socket.unpipe(normalize);
        socket.destroy(); normalize.destroy();
        callback(error);
      }
    });
    // Keep error listeners for the entire stream lifetime, including teardown
    // after ClientRequest has removed its own socket error listener.
    stream.on('error', error => options.routerOnError?.(error));
    socket.on('error', error => stream.destroy(error));
    socket.on('close', () => { if (!socket.readableEnded) stream.destroy(new RouterError('ECONNRESET', 'Conexión del router cerrada')); });
    normalize.on('error', error => stream.destroy(error));
    normalize.on('data', chunk => { if (!stream.push(chunk)) normalize.pause(); });
    normalize.on('end', () => stream.push(null));
    socket.pipe(normalize);
    return stream;
  }
}
const decode = s => s.replace(/&(?:amp|lt|gt|quot|apos|#39|nbsp);/g, x => ({'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'",'&#39;':"'",'&nbsp;':' '})[x]);
const plain = s => decode(s.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
const macPattern = /(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}/i;
function array(html, name) {
  const match = html.match(new RegExp(`\\b${name}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*;?`));
  if (!match) throw new RouterError('HTML_UNEXPECTED', `Falta ${name}`);
  const source = match[1].trim();
  if (!source) return [];
  // Parse only string literals, never execute router JavaScript.
  const tokens = source.match(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g) || [];
  if (source.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '').replace(/[\s,]/g, '')) throw new RouterError('PARSER', `Array no reconocido: ${name}`);
  return tokens.map(t => decode(t.slice(1,-1).replace(/\\(?:u([\da-f]{4})|x([\da-f]{2})|([\\"'nrt/]))/gi, (_,u,x,c) => u||x ? String.fromCharCode(parseInt(u||x,16)) : ({n:'\n',r:'\r',t:'\t'}[c] ?? c))));
}
export function parseDevices(html) {
  const count = html.match(/\bonlineDeviceNum\s*=\s*["']?(\d+)["']?\s*;/);
  if (!count) throw new RouterError('HTML_UNEXPECTED', 'Falta onlineDeviceNum');
  const names = array(html, 'onlineHostNameArr'), macs = array(html, 'onlineHostMAC');
  if (+count[1] !== macs.length || names.length !== macs.length) throw new RouterError('PARSER', 'Cantidad de dispositivos inconsistente');
  const rows = [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(m => plain(m[1]));
  const seen = new Set();
  return macs.map((raw, i) => {
    if (!new RegExp(`^${macPattern.source}$`, 'i').test(raw)) throw new RouterError('PARSER', 'MAC inválida');
    const mac = raw.replaceAll('-', ':').toUpperCase();
    if (seen.has(mac)) throw new RouterError('PARSER', 'MAC duplicada');
    seen.add(mac);
    const row = rows.find(r => r.toUpperCase().replaceAll('-', ':').includes(mac)) || '';
    const ip = row.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/)?.[0] || null;
    if (ip && ip.split('.').some(n => +n > 255)) throw new RouterError('PARSER', 'IPv4 inválida');
    const rssi = row.match(/RSSI\s*:?\s*(-?\d+)/i) || row.match(/(-\d+)\s*dBm/i);
    return { hostname: names[i] || null, mac, ip, connection: row.match(/Wi-Fi\s*(?:2\.4G|5G)|Ethernet/i)?.[0] || null, rssi: rssi ? +rssi[1] : null, assignment: row.match(/Reserved IP|DHCP/i)?.[0] || null, online: true };
  });
}
export class Sagemcom {
  constructor(config, { request, log = console.log } = {}) {
    this.config = config; this.cookies = new Map(); this.log = log;
    this.active = new Set(); this.closed = false;
    this.agent = new RouterAgent({ rejectUnauthorized: false, keepAlive: false, maxSockets: 1 });
    this.transport = request || ((path, options) => this.request(path, options));
  }
  request(path, options = {}) {
    return new Promise((resolve, reject) => {
      const { signal, ...requestOptions } = options;
      let req, res, timer, settled = false;
      const chunks = [];
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        this.active.delete(cancel);
        chunks.length = 0;
        // Do not remove error listeners: destroy can emit errors asynchronously.
        // They only call this guarded finish function and cannot settle twice.
        if (error) { req?.destroy(); res?.destroy(); reject(connectionError(error)); }
        else resolve(value);
      };
      const fail = error => finish(error);
      const cancel = () => fail(new RouterError('ABORT', 'Consulta al router cancelada'));
      const abort = () => fail(new RouterError('ABORT', 'Consulta al router cancelada', signal.reason));
      try {
        if (this.closed) { cancel(); return; }
        if (signal?.aborted) { abort(); return; }
        const url = new URL(path, this.config.routerUrl);
        if (url.origin !== new URL(this.config.routerUrl).origin) {
          throw new RouterError('CONNECTION', 'Destino fuera de ROUTER_URL');
        }
        this.active.add(cancel);
        signal?.addEventListener('abort', abort, { once: true });
        // A private, non-reusing agent is required only for header normalization.
        // TLS and parser exceptions never apply to other clients.
        req = https.request(url, {
          ...requestOptions, headers: { ...options.headers, Connection: 'close' },
          agent: this.agent, rejectUnauthorized: false, insecureHTTPParser: true,
          routerOnError: fail
        }, incoming => {
          res = incoming;
          res.on('error', fail);
          res.once('aborted', () => fail(Object.assign(new Error('Respuesta del router interrumpida'), { code: 'ECONNRESET' })));
          res.once('close', () => { if (!res.complete) fail(Object.assign(new Error('Respuesta del router incompleta'), { code: 'ECONNRESET' })); });
          if (settled) { res.destroy(); return; }
          let size = 0;
          res.on('data', chunk => {
            if (settled) return;
            size += chunk.length;
            if (size > 2e6) fail(new RouterError('HTML_UNEXPECTED', 'Respuesta demasiado grande'));
            else chunks.push(chunk);
          });
          res.once('end', () => {
            if (!res.complete) { fail(Object.assign(new Error('Respuesta del router incompleta'), { code: 'ECONNRESET' })); return; }
            finish(null, { status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') });
          });
        });
        req.on('error', fail);
        req.once('abort', cancel);
        req.once('close', () => { if (!settled) fail(Object.assign(new Error('Conexión del router cerrada'), { code: 'ECONNRESET' })); });
        timer = setTimeout(() => fail(new RouterError('TIMEOUT', 'Tiempo de espera agotado')), this.config.timeoutSeconds * 1000);
        req.end(options.body);
      } catch (error) { fail(error); }
    });
  }
  async call(path, method = 'GET', body) {
    let res;
    try { res = await this.transport(path, { method, body, headers: { Cookie: [...this.cookies].map(([k,v]) => `${k}=${v}`).join('; '), ...(body ? {'Content-Type':'application/x-www-form-urlencoded','Content-Length':Buffer.byteLength(body)} : {}) } }); }
    catch (e) { throw connectionError(e); }
    for (const cookie of [].concat(res.headers['set-cookie'] || [])) {
      const match = cookie.match(/^([^=;]+)=([^;]*)/); if (match) this.cookies.set(match[1], match[2]);
    }
    const location = res.headers.location;
    this.log(`Sagemcom ${method} ${path} -> ${res.status}${location ? ` Location=${this.isMain(location) ? 'main.php' : '[otro destino]'}` : ''}`);
    return res;
  }
  isMain(location) { try { const u = new URL(location, this.config.routerUrl); return u.origin === this.config.routerUrl && u.pathname === '/main.php'; } catch { return false; } }
  async login() {
    this.cookies.clear();
    const initial = await this.call('/index.php');
    if (initial.status !== 200) throw new RouterError('LOGIN', 'No se pudo abrir el login');
    this.log(`Sagemcom cookies: PHPSESSID=${!!this.cookies.get('PHPSESSID')} csrfp_token=${!!this.cookies.get('csrfp_token')}`);
    if (!this.cookies.get('PHPSESSID')) throw new RouterError('COOKIES_MISSING', 'Falta cookie de sesión');
    if (!this.cookies.get('csrfp_token')) throw new RouterError('TOKEN_MISSING', 'Falta token CSRF');
    const body = new URLSearchParams({ username: this.config.username, password: encodePassword(this.config.password), csrfp_token: this.cookies.get('csrfp_token') }).toString();
    const res = await this.call('/check.php', 'POST', body);
    if (res.status !== 302 || !this.isMain(res.headers.location)) throw new RouterError('LOGIN', 'Login incorrecto: se esperaba 302 Location=main.php');
  }
  async devices() {
    if (!this.cookies.get('PHPSESSID')) await this.login();
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await this.call('/connected_devices_computers.php');
      const expired = [301,302,303,401,403].includes(res.status) || /<input\b[^>]*type\s*=\s*["']password["']/i.test(res.body);
      if (expired) { if (!attempt) { await this.login(); continue; } throw new RouterError('SESSION_EXPIRED', 'Sesión expirada después de reautenticar'); }
      if (res.status !== 200) throw new RouterError('HTML_UNEXPECTED', `HTTP ${res.status} en dispositivos`);
      const devices = parseDevices(res.body); this.log(`Sagemcom dispositivos parseados: ${devices.length}`); return devices;
    }
  }
  diagnostic(error) {
    const secrets = [this.config.password, encodePassword(this.config.password), this.config.token, ...this.cookies.values()].filter(Boolean).sort((a,b) => b.length-a.length);
    const clean = value => { let s = String(value || ''); for (const secret of secrets) s = s.split(secret).join('[REDACTADO]'); return s; };
    const detail = e => ({ name: clean(e.name), code: clean(e.code), message: clean(e.message), ...(e.cause ? { cause: detail(e.cause) } : {}) });
    return detail(error);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const cancel of this.active) cancel();
    this.agent.destroy();
  }
}
