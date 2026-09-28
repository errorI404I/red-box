import { test } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import tls from 'node:tls';
import { Duplex } from 'node:stream';
import { Sagemcom, encodePassword } from '../lib/router/sagemcom.js';

// Raw HTTP bytes exercise Node's actual response parser without opening a port.
// TLS is not simulated; its router-only configuration is asserted separately.
function socketFor(response, requests) {
  let request = Buffer.alloc(0);
  let replied = false;
  return new Duplex({
    read() {},
    write(chunk, encoding, callback) {
      request = Buffer.concat([request, chunk]);
      const text = request.toString('utf8');
      const end = text.indexOf('\r\n\r\n');
      const length = Number(text.match(/content-length: (\d+)/i)?.[1] || 0);
      if (!replied && end >= 0 && request.length >= end + 4 + length) {
        replied = true;
        requests.push(text);
        queueMicrotask(() => { this.push(response); this.push(null); });
      }
      callback();
    }
  });
}
function response(status, headers = [], body = '') {
  return Buffer.from([
    `HTTP/1.1 ${status}`,
    'Access-Control-Allow-Headers : X-Requested-With',
    ...headers,
    `Content-Length: ${Buffer.byteLength(body)}`,
    'Connection: close', '', body
  ].join('\r\n'));
}

test('Sagemcom tolera headers del firmware en login y dispositivos sin cambiar HTTPS global', async t => {
  const config = {routerUrl:'https://192.168.0.1',username:'custadmin',password:'contraseña',timeoutSeconds:1};
  const logs = [], requests = [];
  const router = new Sagemcom(config, {log:line => logs.push(line)});
  t.after(() => router.close());
  const globalOptions = {...https.globalAgent.options};
  const responses = [
    response('200 OK', ['Set-Cookie: PHPSESSID=test-session; Path=/', 'Set-Cookie: csrfp_token=test-csrf; Path=/']),
    response('302 Found', ['Location: main.php']),
    response('200 OK', [], 'var onlineDeviceNum = 0; var onlineHostNameArr = []; var onlineHostMAC = [];')
  ];
  t.mock.method(tls, 'connect', options => {
    assert.equal(options.rejectUnauthorized, false);
    return socketFor(responses.shift(), requests);
  });
  assert.deepEqual(await router.devices(), []);
  assert.deepEqual(requests.map(r => r.split('\r\n')[0]), [
    'GET /index.php HTTP/1.1', 'POST /check.php HTTP/1.1', 'GET /connected_devices_computers.php HTTP/1.1'
  ]);
  assert.match(requests[1], /Cookie: PHPSESSID=test-session; csrfp_token=test-csrf/i);
  assert.match(requests[2], /Cookie: PHPSESSID=test-session; csrfp_token=test-csrf/i);
  const form = new URLSearchParams(requests[1].split('\r\n\r\n')[1]);
  assert.equal(form.get('password'), encodePassword(config.password));
  assert.equal(form.get('csrfp_token'), 'test-csrf');
  assert.equal(router.agent.options.rejectUnauthorized, false);
  assert.notEqual(router.agent, https.globalAgent);
  assert.deepEqual({...https.globalAgent.options}, globalOptions);
  for (const secret of [config.password, encodePassword(config.password), 'test-session', 'test-csrf']) assert.ok(!logs.join('\n').includes(secret));
});

test('un cliente HTTPS normal sigue rechazando el header malformado', async t => {
  const agent = new https.Agent();
  t.after(() => agent.destroy());
  t.mock.method(agent, 'createConnection', () => socketFor(response('200 OK'), []));
  await assert.rejects(new Promise((resolve, reject) => {
    const req = https.request('https://192.168.0.1/index.php', {agent}, res => { res.resume(); resolve(); });
    req.on('error', reject);
    req.end();
  }), {code:'HPE_INVALID_HEADER_TOKEN'});
});

test('normalización acotada: headers fragmentados, cookies y cuerpo intacto', async t => {
  const router = new Sagemcom({routerUrl:'https://192.168.0.1',timeoutSeconds:1}, {log:()=>{}});
  t.after(() => router.close());
  const body = 'á\r\nAccess-Control-Allow-Headers : conservar esto\r\n\r\nfin';
  const raw = response('200 OK', ['Set-Cookie : PHPSESSID=memory-only'], body);
  const fragments = [...raw].map(byte => Buffer.from([byte]));
  t.mock.method(tls, 'connect', () => new Duplex({
    read() {},
    write(chunk, encoding, callback) {
      queueMicrotask(() => { for (const fragment of fragments) this.push(fragment); this.push(null); });
      callback();
    }
  }));
  const result = await router.call('/index.php');
  assert.equal(result.body, body);
  assert.equal(router.cookies.get('PHPSESSID'), 'memory-only');
});

test('timeout del transporte y rechazo de destinos fuera del router', async t => {
  const router = new Sagemcom({routerUrl:'https://192.168.0.1',timeoutSeconds:0.02}, {log:()=>{}});
  t.after(() => router.close());
  const socket = new Duplex({read(){},write(chunk, encoding, callback){callback();}});
  const connect = t.mock.method(tls, 'connect', () => socket);
  await assert.rejects(router.request('https://example.com/index.php', {method:'GET'}), /fuera de ROUTER_URL/);
  assert.equal(connect.mock.callCount(), 0);
  await assert.rejects(router.call('/index.php'), {code:'TIMEOUT'});
  assert.equal(socket.destroyed, true);
});

test('error TLS conserva causa y cierra el socket', async t => {
  const router = new Sagemcom({routerUrl:'https://192.168.0.1',timeoutSeconds:1}, {log:()=>{}});
  t.after(() => router.close());
  t.mock.method(tls, 'connect', () => {
    const socket = new Duplex({read(){},write(chunk, encoding, callback){callback();}});
    queueMicrotask(() => socket.destroy(Object.assign(new Error('TLS failure'), {code:'ERR_SSL_PROTOCOL_ERROR'})));
    return socket;
  });
  await assert.rejects(router.call('/index.php'), error => error.code === 'TLS' && error.cause.code === 'ERR_SSL_PROTOCOL_ERROR');
});

test('headers demasiado grandes se rechazan sin esperar el cuerpo', async t => {
  const router = new Sagemcom({routerUrl:'https://192.168.0.1',timeoutSeconds:1}, {log:()=>{}});
  t.after(() => router.close());
  t.mock.method(tls, 'connect', () => socketFor(response('200 OK', [`X-Large: ${'x'.repeat(16384)}`]), []));
  await assert.rejects(router.call('/index.php'), error => error.cause.code === 'HPE_HEADER_OVERFLOW');
});
