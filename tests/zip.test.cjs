const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'zip.js'), 'utf8');
const { ZipWriter, PartWriter } = vm.runInNewContext(source + '\n({ZipWriter, PartWriter})', {
  TextEncoder, Uint8Array, Uint32Array, DataView, Blob
});

function tempDirectory(t) {
  const root = path.resolve(os.tmpdir());
  const dir = fs.mkdtempSync(path.join(root, 'minote-zip-test-'));
  assert.equal(path.dirname(dir), root);
  assert.ok(path.basename(dir).startsWith('minote-zip-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function save(blob, file) {
  await pipeline(Readable.fromWeb(blob.stream()), fs.createWriteStream(file));
}

function dotnetCounts(dir) {
  const script = "Add-Type -AssemblyName System.IO.Compression.FileSystem; Get-ChildItem -LiteralPath $env:MINOTE_TEST_ZIPS -Filter '*.zip' | Sort-Object Name | ForEach-Object { $z=[System.IO.Compression.ZipFile]::OpenRead($_.FullName); try { Write-Output $z.Entries.Count } finally { $z.Dispose() } }";
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, MINOTE_TEST_ZIPS: dir }, encoding: 'utf8'
  }).trim().split(/\r?\n/).filter(Boolean).map(Number);
}

test('65,536 entries are split into valid independent ZIPs without omissions', { timeout: 120000 }, async t => {
  const dir = tempDirectory(t), files = [];
  const writer = new PartWriter(async (blob, part) => {
    const file = path.join(dir, part.filename);
    await save(blob, file);
    files.push(file);
  }, 'batch', { maxBytes: 128 * 1024 * 1024, maxEntries: 10000 });
  for (let index = 0; index < 65536; index++) await writer.add('entry-' + index + '.txt', 'x');
  const names = await writer.finish(parts => 'parts=' + parts.length, 'instructions');
  assert.equal(names.length, 7);
  const counts = dotnetCounts(dir);
  assert.equal(counts.reduce((sum, count) => sum + count, 0), 65538);
  assert.ok(counts.every(count => count <= 10000));
  const actual = new Set();
  for (const file of files) {
    const listing = execFileSync('tar', ['-tf', file], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    for (const line of listing.split(/\r?\n/)) if (line.startsWith('entry-')) actual.add(line);
  }
  assert.equal(actual.size, 65536);
  for (let index = 0; index < 65536; index++) assert.ok(actual.has('entry-' + index + '.txt'));
});

test('a ZIP reaches the actual 128 MiB boundary and the next entry goes to another part', { timeout: 120000 }, async t => {
  const dir = tempDirectory(t), files = [];
  const maxBytes = 128 * 1024 * 1024;
  const name = 'large.bin';
  const overhead = 22 + 30 + 46 + 2 * Buffer.byteLength(name);
  const payload = new Blob([new Uint8Array(maxBytes - overhead)]);
  const writer = new PartWriter(async (blob, part) => {
    const file = path.join(dir, part.filename);
    await save(blob, file);
    files.push(file);
  }, 'large', { maxBytes, maxEntries: 10000 });
  await writer.add(name, payload);
  await writer.add('next.txt', 'next');
  await writer.finish(parts => 'parts=' + parts.length, 'instructions');
  assert.equal(files.length, 2);
  assert.equal(fs.statSync(files[0]).size, maxBytes);
  assert.deepEqual(dotnetCounts(dir), [1, 3]);
  assert.match(execFileSync('tar', ['-tf', files[0]], { encoding: 'utf8' }), /large\.bin/);
});

test('independent ZIP readers recover the original image bytes and UTF-8 filename', async t => {
  const dir = tempDirectory(t), archive = path.join(dir, 'image.zip');
  const original = new Uint8Array([137, 80, 78, 71, 0, 3, 255, 12, 34, 56]);
  const entry = '分类/图片/测试图.png';
  const writer = new ZipWriter();
  writer.add(entry, original);
  await save(await writer.blob(), archive);
  const output = execFileSync('tar', ['-xOf', archive, entry]);
  assert.equal(crypto.createHash('sha256').update(output).digest('hex'), crypto.createHash('sha256').update(original).digest('hex'));
  assert.deepEqual(dotnetCounts(dir), [1]);
});
