const assert = require('node:assert/strict');
const path = require('node:path');
const { after, before, test } = require('node:test');
const { playwright, chromiumPath } = require('./browser.cjs');

const root = path.resolve(__dirname, '..');
let browser;

before(async () => {
  browser = await playwright.chromium.launch({
    executablePath: chromiumPath,
    headless: true,
    args: ['--disable-background-networking', '--host-resolver-rules=MAP * ~NOTFOUND']
  });
});
after(async () => { if (browser) await browser.close(); });

async function runFixture(fixture) {
  const page = await browser.newPage();
  try {
    await page.setContent('<!doctype html><meta charset="utf-8">');
    await page.addScriptTag({ path: path.join(root, 'zip.js') });
    await page.addScriptTag({ path: path.join(root, 'export.js') });
    return await page.evaluate(async ({ pages, details, images, options, detailStatuses, captureArchives, failAtPart }) => {
      const captured = [];
      const originalAdd = ZipWriter.prototype.add;
      ZipWriter.prototype.add = function (name, data) {
        captured.push({ name, text: typeof data === 'string' ? data : null });
        return originalAdd.call(this, name, data);
      };
      let pageIndex = 0;
      const requests = [];
      const parts = [];
      globalThis.fetch = async url => {
        const parsed = new URL(url);
        requests.push(parsed.pathname);
        let data;
        if (parsed.pathname === '/note/full/page/') {
          data = pages[pageIndex++];
          if (!data) throw Error('Unexpected pagination request');
          if (data.httpStatus) return new Response('', { status: data.httpStatus });
        } else if (parsed.pathname.startsWith('/note/note/')) {
          const id = decodeURIComponent(parsed.pathname.split('/')[3]);
          if (detailStatuses[id]) return new Response('', { status: detailStatuses[id] });
          data = { entry: details[id] };
        } else if (parsed.pathname === '/file/full') {
          const id = parsed.searchParams.get('fileid');
          if (!images[id]) return new Response('', { status: 404 });
          const image = images[id] === true ? {} : images[id];
          const bytes = image.size ? new Uint8Array(image.size).fill(7) : new Uint8Array([137, 80, 78, 71]);
          const headers = { 'Content-Type': image.type || 'image/png' };
          if (image.declaredLength != null) headers['Content-Length'] = String(image.declaredLength);
          return new Response(bytes, { headers });
        } else {
          throw Error('Unexpected request: ' + parsed.pathname);
        }
        return new Response(JSON.stringify({ result: 'ok', data }), { headers: { 'Content-Type': 'application/json' } });
      };
      const result = await MiExport.run(() => {}, {
        noteDelay: 0, pageDelay: 0, retryDelay: 0, ...options,
        onPart: async (blob, part) => {
          if (part.index === failAtPart) throw Error('模拟下载中断');
          parts.push({ ...part, size: blob.size, bytes: captureArchives ? Array.from(new Uint8Array(await blob.arrayBuffer())) : undefined });
        }
      });
      return { result: { ...result, blob: undefined }, captured, requests, parts };
    }, { pages: fixture.pages, details: fixture.details || {}, images: fixture.images || {}, options: fixture.options || {},
      detailStatuses: fixture.detailStatuses || {}, captureArchives: !!fixture.captureArchives, failAtPart: fixture.failAtPart || 0 });
  } finally {
    await page.close();
  }
}

test('an empty non-final page does not silently stop pagination', async () => {
  const output = await runFixture({
    pages: [
      { entries: [], folders: [], lastPage: false, syncTag: 'next' },
      { entries: [{ id: 'n1' }], folders: [], lastPage: true }
    ],
    details: { n1: { id: 'n1', content: '<div>complete note</div>' } }
  });
  assert.equal(output.result.total, 1);
  assert.equal(output.requests.filter(item => item === '/note/full/page/').length, 2);
});

test('a snippet without a complete detail is reported as partial', async () => {
  const output = await runFixture({
    pages: [{ entries: [{ id: 'n1', snippet: 'preview only' }], folders: [], lastPage: true }],
    details: { n1: { id: 'n1' } }
  });
  assert.equal(output.result.partial, 1);
  assert.equal(output.result.success, 0);
  assert.ok(output.captured.some(file => file.text?.includes('preview only')));
});

test('image markers before a closing tag and ordinary links survive export', async () => {
  const output = await runFixture({
    pages: [{ entries: [{ id: 'n1' }], folders: [], lastPage: true }],
    details: { n1: { id: 'n1', content: '<div><a href="https://example.invalid/doc">document</a></div><div>☺ image.1</div>', setting: { data: [{ rawId: 'image.1', mimeType: 'image/png' }] } } },
    images: { 'image.1': true }
  });
  const note = output.captured.find(file => file.name.endsWith('_n1.md') && !file.name.startsWith('分类汇总/'));
  assert.ok(note, 'the individual note was added to the archive');
  assert.match(note.text, /https:\/\/example\.invalid\/doc/);
  assert.match(note.text, /!\[图片\]/);
});

test('an encoded image source is matched even when another image attribute is present', async () => {
  const output = await runFixture({
    pages: [{ entries: [{ id: 'n1' }], folders: [], lastPage: true }],
    details: { n1: { id: 'n1', content: '<div><img id="decorative" src="https://example.invalid/a%2Bb.png"></div>',
      files: [{ rawId: 'a+b', mimeType: 'image/png' }] } },
    images: { 'a+b': true }
  });
  assert.equal(output.result.success, 1);
  assert.equal(output.result.imageCount, 1);
  assert.match(output.captured.find(file => file.name.endsWith('_n1.md')).text, /!\[图片\]/);
});

test('a genuine empty note stays complete and does not fall back to its snippet', async () => {
  const output = await runFixture({
    pages: [{ entries: [{ id: 'n1', snippet: 'old preview' }], folders: [], lastPage: true }],
    details: { n1: { id: 'n1', content: '' } }
  });
  assert.equal(output.result.success, 1);
  assert.equal(output.result.partial, 0);
  assert.ok(!output.captured.some(file => file.text?.includes('old preview')));
});

test('an empty alternative content field cannot hide a nonempty full body', async () => {
  const output = await runFixture({
    pages: [{ entries: [{ id: 'n1' }], folders: [], lastPage: true }],
    details: { n1: { id: 'n1', extraInfo: '{"mind_content":""}', content: '<div>actual body</div>' } }
  });
  assert.equal(output.result.success, 1);
  assert.match(output.captured.find(file => file.name.endsWith('_n1.md')).text, /actual body/);
});

test('failed details, malformed metadata and unsupported attachments are reported distinctly', async () => {
  const output = await runFixture({
    pages: [{ entries: [{ id: 'one', snippet: 'recoverable' }, { id: 'two' }, { id: 'three' }, { id: 'four' }], folders: [], lastPage: true }],
    detailStatuses: { one: 500, two: 500 },
    details: {
      three: { id: 'three', content: 'text', extraInfo: '{invalid' },
      four: { id: 'four', content: 'text', files: [{ rawId: 'pdf', mimeType: 'application/pdf' }] }
    }
  });
  assert.deepEqual([output.result.total, output.result.success, output.result.partial, output.result.failed], [4, 0, 3, 1]);
  assert.match(output.result.issues.join('\n'), /详情读取失败/);
  assert.match(output.result.issues.join('\n'), /附加信息无法解析/);
  assert.match(output.result.issues.join('\n'), /不支持导出/);
  assert.equal(output.result.attachmentIssues, 1);
  assert.match(output.captured.find(file => file.name === '导出报告.txt').text, /完整笔记：0\n部分成功：3\n失败笔记：1/);
});

test('a repeated pagination token keeps discovered notes but marks the list incomplete', async () => {
  const output = await runFixture({
    pages: [
      { entries: [{ id: 'n1' }], folders: [], lastPage: false, syncTag: 'repeat' },
      { entries: [], folders: [], lastPage: false, syncTag: 'repeat' }
    ],
    details: { n1: { id: 'n1', content: 'kept' } }
  });
  assert.equal(output.result.total, 1);
  assert.equal(output.result.success, 1);
  assert.equal(output.result.listIncomplete, true);
  assert.match(output.captured.find(file => file.name === '导出报告.txt').text, /列表状态：不完整/);
});

test('a later page request failure keeps earlier notes and marks the list incomplete', async () => {
  const output = await runFixture({
    pages: [
      { entries: [{ id: 'n1' }], folders: [], lastPage: false, syncTag: 'next' },
      { httpStatus: 500 }
    ],
    details: { n1: { id: 'n1', content: 'kept' } }
  });
  assert.equal(output.result.total, 1);
  assert.equal(output.result.success, 1);
  assert.equal(output.result.listIncomplete, true);
  assert.match(output.result.issues.join('\n'), /列表：读取失败/);
});

test('an empty final page produces empty summaries and a complete report', async () => {
  const output = await runFixture({ pages: [{ entries: [], folders: [], lastPage: true }] });
  assert.equal(output.result.total, 0);
  assert.equal(output.result.listIncomplete, false);
  assert.ok(output.captured.some(file => file.name === 'AI阅读_全部笔记.md'));
  assert.ok(output.captured.some(file => file.name === 'AI阅读_全部笔记.txt'));
  assert.match(output.captured.find(file => file.name === '导出报告.txt').text, /发现笔记：0/);
});

test('missing, oversized and unknown images are visible and never counted as complete', async () => {
  const output = await runFixture({
    pages: [{ entries: [{ id: 'n1' }], folders: [], lastPage: true }],
    details: { n1: { id: 'n1', content: '<div>☺ missing</div><div>☺ too-big</div><div>☺ unknown</div>',
      files: [{ rawId: 'missing', mimeType: 'image/png' }, { rawId: 'too-big', mimeType: 'image/png' }] } },
    images: { 'too-big': { size: 10 } },
    options: { imageLimit: 5 }
  });
  assert.equal(output.result.partial, 1);
  assert.equal(output.result.imageCount, 0);
  assert.ok(output.result.imageIssues >= 3);
  assert.match(output.result.issues.join('\n'), /超过 120 MiB/);
  assert.match(output.result.issues.join('\n'), /未识别图片标记/);
  const note = output.captured.find(file => file.name.endsWith('_n1.md'));
  assert.match(note.text, /图片未能识别或下载/);
  assert.match(note.text, /本笔记未完整导出/);
});

test('the real 120 MiB image limit rejects an oversized declared length', async () => {
  const output = await runFixture({
    pages: [{ entries: [{ id: 'n1' }], folders: [], lastPage: true }],
    details: { n1: { id: 'n1', content: '<div>☺ large</div>', files: [{ rawId: 'large', mimeType: 'image/png' }] } },
    images: { large: { size: 4, declaredLength: 120 * 1024 * 1024 + 1 } }
  });
  assert.equal(output.result.partial, 1);
  assert.equal(output.result.imageCount, 0);
  assert.match(output.result.issues.join('\n'), /超过 120 MiB/);
});

test('all generated markdown image links resolve after parts are extracted together', async () => {
  const output = await runFixture({
    pages: [{ entries: [{ id: 'a:b', folderId: 'f' }, { id: 'a?b', folderId: 'f' }],
      folders: [{ id: 'f', subject: '中文 类别' }], lastPage: true }],
    details: {
      'a:b': { id: 'a:b', subject: '同名', content: '<div>☺ a+b.[1]</div><div>☺ a+b.[1]</div>', files: [{ rawId: 'a+b.[1]', mimeType: 'image/png' }] },
      'a?b': { id: 'a?b', subject: '同名', content: '<div>☺ second</div>', files: [{ rawId: 'second', mimeType: 'image/png' }] }
    },
    images: { 'a+b.[1]': true, second: true },
    options: { maxBytes: 4096, maxEntries: 5, summaryLimit: 512 }
  });
  assert.equal(output.result.success, 2);
  assert.ok(output.parts.length > 1);
  const names = output.captured.map(file => file.name);
  const files = new Set(names);
  assert.equal(new Set(names.map(name => name.normalize('NFC').toLowerCase())).size, names.length);
  let links = 0;
  for (const file of output.captured.filter(file => file.name.endsWith('.md') && file.text)) {
    for (const match of file.text.matchAll(/!\[图片\]\(<([^>]+)>\)/g)) {
      const decoded = match[1].split('/').map(decodeURIComponent).join('/');
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file.name), decoded));
      assert.ok(files.has(resolved), file.name + ' references missing ' + resolved);
      links++;
    }
  }
  assert.ok(links >= 9, 'individual notes and both kinds of summaries contain the references');
  assert.equal(output.parts.at(-1).final, true);
  assert.match(output.captured.find(file => file.name === '导出报告.txt').text, new RegExp('分包数量：' + output.parts.length));
});

test('long emoji titles and IDs do not create overlong Windows path components', async () => {
  const id = '😀'.repeat(70), folder = '📂'.repeat(70);
  const output = await runFixture({
    pages: [{ entries: [{ id, folderId: folder }], folders: [{ id: folder, subject: folder }], lastPage: true }],
    details: { [id]: { id, folderId: folder, subject: '📙'.repeat(70), content: 'long name' } }
  });
  const individual = output.captured.find(file => file.name.endsWith('.md') && file.name.includes('/') && !file.name.startsWith('分类汇总/'));
  assert.ok(individual);
  assert.ok(individual.name.length < 180, 'relative path is too long for ordinary Windows extraction');
  assert.ok(individual.name.split('/').every(part => part.length < 100), 'a path component is too long');
});

test('a part download failure stops the run and identifies completed parts', async () => {
  const notes = Array.from({ length: 8 }, (_, i) => ({ id: 'n' + i }));
  const details = Object.fromEntries(notes.map(note => [note.id, { id: note.id, content: 'text' }]));
  await assert.rejects(runFixture({
    pages: [{ entries: notes, folders: [], lastPage: true }], details,
    options: { maxBytes: 16384, maxEntries: 3, summaryLimit: 1024 }, failAtPart: 2
  }), /分包 2 .*失败.*已完成 1 个分包/);
});
