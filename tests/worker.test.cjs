const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

test('an interrupted second download reports the completed part and releases both URLs', async () => {
  const root = path.resolve(__dirname, '..');
  const zipSource = fs.readFileSync(path.join(root, 'zip.js'), 'utf8');
  const workerSource = fs.readFileSync(path.join(root, 'worker.js'), 'utf8');
  const revoked = [];
  let listener, nextId = 0;
  const chrome = { runtime: {
    onMessage: { addListener: fn => { listener = fn; } },
    sendMessage: async message => {
      if (message.type === 'download') return { id: ++nextId };
      if (message.type === 'downloadStatus') return message.id === 1 ?
        { state: 'complete' } : { state: 'interrupted', downloadError: 'USER_CANCELED' };
      throw Error('Unexpected message ' + message.type);
    }
  } };
  const URL = { createObjectURL: () => 'blob:test-' + (nextId + 1), revokeObjectURL: url => revoked.push(url) };
  const context = vm.createContext({ TextEncoder, Uint8Array, Uint32Array, DataView, Blob, chrome, URL, setTimeout });
  vm.runInContext(zipSource + `
    const MiExport = { async run(progress, options) {
      const writer = new PartWriter(options.onPart, 'batch', {maxBytes:4096,maxEntries:3});
      for (let i=0; i<7; i++) await writer.add('file-'+i, 'x');
      await writer.finish(()=>'report', 'instructions');
    } };
  ` + workerSource, context);
  listener({ target: 'worker', type: 'start' }, null, () => {});
  let state;
  for (let attempt = 0; attempt < 100; attempt++) {
    listener({ target: 'worker', type: 'status' }, null, value => { state = value; });
    if (!state.running) break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(state.running, false);
  assert.match(state.message, /导出中止：分包 2 .*USER_CANCELED.*已完成 1 个分包/);
  assert.deepEqual(revoked, ['blob:test-1', 'blob:test-2']);
});
