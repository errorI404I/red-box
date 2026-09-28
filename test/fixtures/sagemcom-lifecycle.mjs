// Runs as an isolated process: any unhandled error/rejection fails the parent test.
import assert from 'node:assert/strict';
import tls from 'node:tls';
import { Duplex } from 'node:stream';
import { readFileSync } from 'node:fs';
import { Sagemcom } from '../../lib/router/sagemcom.js';
import { Store } from '../../lib/db.js';
import { Monitor } from '../../lib/monitor.js';
const scenario = process.argv[2];
const config = {routerUrl:'https://192.168.0.1',timeoutSeconds:0.03,routerFailureCycles:3,password:'test-password'};
const router = new Sagemcom(config, {log:()=>{}});
router.cookies.set('PHPSESSID','test-session');
const store = new Store(':memory:');
const monitor = new Monitor(config, router, store, {alert:async()=>{}});
const body = readFileSync(new URL('./devices.html', import.meta.url), 'utf8');
let failing = false;
const streams = [], sockets = [];
const create = router.agent.createConnection.bind(router.agent);
router.agent.createConnection = options => { const stream = create(options); streams.push(stream); return stream; };
const originalConnect = tls.connect;
tls.connect = () => {
  let replied = false;
  const socket = new Duplex({
    read(){},
    write(chunk, encoding, callback) {
      if (!replied) {
        replied = true;
        queueMicrotask(() => {
          if (!failing) {
            this.push(Buffer.from(`HTTP/1.1 200 OK\r\nAccess-Control-Allow-Headers : X-Requested-With\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: keep-alive\r\n\r\n${body}`));
            // Keep the peer open: the client must retire this connection itself.
          } else if (scenario === 'timeout') {
            // No response, exercise the request deadline.
          } else if (scenario === 'closed') this.destroy();
          else if (scenario === 'truncated') { this.push('HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\nx'); this.push(null); }
          else {
            const code = {abort:'ABORT_ERR',refused:'ECONNREFUSED',tls:'ERR_SSL_PROTOCOL_ERROR'}[scenario];
            this.destroy(Object.assign(new Error('simulated network failure'), {code}));
          }
        });
      }
      callback();
    }
  });
  sockets.push(socket); return socket;
};
try {
  await monitor.poll();
  assert.equal(monitor.state.status, 'conectado');
  const devices = store.devices();
  const lastSuccess = monitor.state.lastSuccess;
  failing = true;
  await monitor.poll();
  assert.equal(monitor.state.status, 'error');
  assert.equal(monitor.state.error.name, 'RouterError');
  const codes = {timeout:'TIMEOUT',abort:'ABORT',refused:'CONNECTION_REFUSED',tls:'TLS',closed:'ECONNRESET',truncated:'CONNECTION'};
  assert.equal(monitor.state.error.code, codes[scenario]);
  assert.equal(monitor.state.lastSuccess, lastSuccess);
  assert.equal(monitor.state.count, devices.length);
  assert.deepEqual(store.devices(), devices);
  assert.equal(store.events().filter(e => e.type === 'offline').length, 0);
  failing = false;
  await monitor.poll();
  assert.equal(monitor.state.status, 'conectado');
  assert.equal(monitor.state.failures, 0);
  assert.equal(streams.length, 3); // No recycled sockets, even if firmware advertises keep-alive.
  await new Promise(resolve => setImmediate(resolve));
  for (const stream of streams) {
    // Reproduce a teardown error after ClientRequest has removed its own listener.
    stream.emit('error', Object.assign(new Error('late teardown'), {code:'ABORT_ERR'}));
  }
  router.close(); router.close();
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(router.active.size, 0);
  assert.ok(sockets.every(socket => socket.destroyed));
  console.log('survived:'+scenario);
} finally {
  router.close(); store.close(); tls.connect = originalConnect;
}
