import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

test('configuración: prioridad PORT, config.json y fallback 8080 con host 0.0.0.0', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'red-box-config-'));
  const originalPort = process.env.PORT;
  try {
    mkdirSync(join(dir, 'lib'));
    copyFileSync(new URL('../lib/config.js', import.meta.url), join(dir, 'lib/config.mjs'));
    const { loadConfig } = await import(pathToFileURL(join(dir, 'lib/config.mjs')).href);
    const base = { pollSeconds: 60, timeoutSeconds: 15, routerFailureCycles: 3, telegramCooldownSeconds: 300 };
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ ...base, port: 8081 }));
    process.env.PORT = '9090';
    assert.equal(loadConfig().port, 9090);
    delete process.env.PORT;
    assert.equal(loadConfig().port, 8081);
    writeFileSync(join(dir, 'config.json'), JSON.stringify(base));
    assert.equal(loadConfig().port, 8080);
    assert.equal(loadConfig().host, '0.0.0.0');
    writeFileSync(join(dir, '.env'), 'PORT=9091\n');
    assert.equal(loadConfig().port, 9091);
  } finally {
    if (originalPort === undefined) delete process.env.PORT;
    else process.env.PORT = originalPort;
    rmSync(dir, { recursive: true, force: true });
  }
});
