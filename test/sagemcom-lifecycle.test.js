import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
const execute = promisify(execFile);
for (const scenario of ['timeout', 'abort', 'refused', 'closed', 'truncated', 'tls']) {
  test(`proceso sobrevive ${scenario}; monitor conserva estado y se recupera`, async () => {
    const { stdout, stderr } = await execute(process.execPath, [
      '--unhandled-rejections=strict',
      fileURLToPath(new URL('./fixtures/sagemcom-lifecycle.mjs', import.meta.url)), scenario
    ], {timeout:5000});
    assert.match(stdout, new RegExp(`survived:${scenario}`));
    assert.doesNotMatch(stderr, /Unhandled|uncaught|Emitted 'error'/);
  });
}
