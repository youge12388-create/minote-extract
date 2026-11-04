const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { test } = require('node:test');
const { playwright, chromiumPath, chromePath, edgePath } = require('./browser.cjs');

const root = path.resolve(__dirname, '..');

const mockApi = `
const partialFixture = __PARTIAL__;
const fakeNotes = Array.from({length:8}, (_, index) => ({id:'n'+index, folderId:'work'}));
globalThis.fetch = async function(url) {
  const parsed = new URL(url);
  let data;
  if (parsed.pathname === '/note/full/page/') {
    data = {entries:fakeNotes, folders:[{id:'work',subject:'工作'}], lastPage:true};
  } else if (parsed.pathname.startsWith('/note/note/')) {
    const id = decodeURIComponent(parsed.pathname.split('/')[3]);
    data = {entry:{id, folderId:'work', subject:'测试 '+id,
      content:'<div>模拟笔记 <a href="https://example.invalid/">链接</a></div><div>☺ image-'+id+'</div>',
      files:[{rawId:'image-'+id,mimeType:'image/png'}]}};
    if (partialFixture && id === 'n0') data.entry.files.push({rawId:'pdf',mimeType:'application/pdf'});
  } else if (parsed.pathname === '/file/full') {
    if (partialFixture && parsed.searchParams.get('fileid') === 'image-n0') return new Response('', {status:404});
    return new Response(new Uint8Array([137,80,78,71,1,2,3]), {headers:{'Content-Type':'image/png'}});
  } else throw Error('Unexpected network request: '+parsed.pathname);
  return new Response(JSON.stringify({result:'ok',data}), {headers:{'Content-Type':'application/json'}});
};
`;

function makeFixture(t, failSecondDownload, partial) {
  const tmp = path.resolve(os.tmpdir());
  const dir = fs.mkdtempSync(path.join(tmp, 'minote-extension-test-'));
  assert.equal(path.dirname(dir), tmp);
  assert.ok(path.basename(dir).startsWith('minote-extension-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const extension = path.join(dir, 'extension');
  const downloads = path.join(dir, 'downloads');
  fs.mkdirSync(extension);
  fs.mkdirSync(downloads);
  for (const name of ['manifest.json', 'background.js', 'worker.html', 'worker.js', 'export.js', 'zip.js', 'popup.html', 'popup.js', 'style.css']) {
    fs.copyFileSync(path.join(root, name), path.join(extension, name));
  }
  fs.writeFileSync(path.join(extension, 'mock-api.js'), mockApi.replace('__PARTIAL__', String(!!partial)));
  const htmlPath = path.join(extension, 'worker.html');
  const html = fs.readFileSync(htmlPath, 'utf8');
  fs.writeFileSync(htmlPath, html.replace('<script src="zip.js">', '<script src="mock-api.js"></script><script src="zip.js">'));
  const workerPath = path.join(extension, 'worker.js');
  const worker = fs.readFileSync(workerPath, 'utf8');
  const controlledWorker = worker.replace('}, { onPart: downloadPart });',
    '}, { onPart: downloadPart, maxBytes: 16384, maxEntries: 6, summaryLimit: 1024, noteDelay: 20, pageDelay: 0, retryDelay: 0 });');
  assert.notEqual(controlledWorker, worker, 'fixture must set small archive limits');
  fs.writeFileSync(workerPath, controlledWorker);
  if (failSecondDownload) {
    const bgPath = path.join(extension, 'background.js');
    const bg = fs.readFileSync(bgPath, 'utf8');
    const failingBg = bg.replace('filename:message.filename', "filename:(++testDownloadCount === 2 ? '../invalid.zip' : message.filename)");
    assert.notEqual(failingBg, bg, 'fixture must fail the second download');
    fs.writeFileSync(bgPath, 'let testDownloadCount = 0;\n' + failingBg);
  }
  return { dir, extension, downloads };
}

async function exercise(t, executablePath, failSecondDownload, viaCdp, partial = false) {
  assert.ok(fs.existsSync(executablePath), 'browser executable not found: ' + executablePath);
  const fixture = makeFixture(t, failSecondDownload, partial);
  const args = ['--disable-background-networking', '--host-resolver-rules=MAP * ~NOTFOUND'];
  if (viaCdp) args.push('--enable-unsafe-extension-debugging');
  else args.push('--disable-extensions-except=' + fixture.extension, '--load-extension=' + fixture.extension);
  const context = await playwright.chromium.launchPersistentContext(path.join(fixture.dir, 'profile'), {
    executablePath, headless: true, acceptDownloads: true, downloadsPath: fixture.downloads,
    ...(viaCdp ? { ignoreDefaultArgs: ['--disable-extensions'] } : {}), args
  });
  try {
    let service, extensionId;
    if (viaCdp) {
      const session = await context.browser().newBrowserCDPSession();
      extensionId = (await session.send('Extensions.loadUnpacked', { path: fixture.extension })).id;
    } else {
      service = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 10000 });
      extensionId = new URL(service.url()).hostname;
    }
    let popup = await context.newPage();
    await popup.goto('chrome-extension://' + extensionId + '/popup.html');
    service = service || context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 10000 });
    await popup.locator('#start').click();
    await popup.waitForFunction(() => document.querySelector('#status').textContent.includes('正在'), null, { timeout: 10000 });
    await popup.close();
    popup = await context.newPage();
    await popup.goto('chrome-extension://' + extensionId + '/popup.html');
    await popup.waitForFunction(() => /导出完成|导出部分完成|导出中止/.test(document.querySelector('#status').textContent), null, { timeout: 40000 });
    const status = await popup.locator('#status').textContent();
    const downloads = await service.evaluate(() => chrome.downloads.search({}));
    if (failSecondDownload) {
      assert.match(status, /导出中止：分包 2 .*失败.*已完成 1 个分包/);
      assert.equal(downloads.filter(item => item.state === 'complete').length, 1);
    } else {
      if (partial) {
        assert.match(status, /导出部分完成：发现 8 条，完整 7 条，部分成功 1 条，失败 0 条，图片 7 张，图片问题 [1-9]\d* 项，附件问题 1 项/);
      } else {
        assert.match(status, /导出完成：发现 8 条，完整 8 条，部分成功 0 条，失败 0 条/);
      }
      assert.ok(downloads.length > 1, 'multiple independent ZIPs must be downloaded');
      assert.ok(downloads.every(item => item.state === 'complete'));
      let entries = 0;
      const merged = path.join(fixture.dir, 'merged');
      fs.mkdirSync(merged);
      for (const item of downloads) {
        assert.ok(fs.existsSync(item.filename), 'download does not exist: ' + item.filename);
        const listing = execFileSync('tar', ['-tf', item.filename], { encoding: 'utf8' });
        entries += listing.split(/\r?\n/).filter(Boolean).length;
        execFileSync('tar', ['-xf', item.filename, '-C', merged]);
      }
      assert.ok(entries >= (partial ? 20 : 21), 'all notes, images, summaries and reports are present');
      const report = fs.readFileSync(path.join(merged, '导出报告.txt'), 'utf8');
      assert.match(report, partial ? /发现笔记：8\n完整笔记：7\n部分成功：1\n失败笔记：0/ : /发现笔记：8\n完整笔记：8\n部分成功：0\n失败笔记：0/);
      if (partial) assert.match(report, /附件问题：1/);
      const markdown = fs.readdirSync(merged, { recursive: true, withFileTypes: true })
        .filter(entry => entry.isFile() && entry.name.endsWith('.md'));
      let imageLinks = 0;
      for (const entry of markdown) {
        const file = path.join(entry.parentPath || entry.path, entry.name);
        for (const match of fs.readFileSync(file, 'utf8').matchAll(/!\[图片\]\(<([^>]+)>\)/g)) {
          const relative = match[1].split('/').map(decodeURIComponent).join('/');
          assert.ok(fs.existsSync(path.resolve(path.dirname(file), relative)), file + ' references missing ' + relative);
          imageLinks++;
        }
      }
      assert.ok(imageLinks >= (partial ? 21 : 24), 'extracted individual notes and summaries retain their image links');
      const textSummaries = fs.readdirSync(merged, { withFileTypes: true })
        .filter(entry => entry.isFile() && /^AI阅读_全部笔记.*\.txt$/.test(entry.name));
      let textImageLinks = 0;
      for (const entry of textSummaries) {
        const file = path.join(merged, entry.name);
        for (const match of fs.readFileSync(file, 'utf8').matchAll(/\[图片：([^；]+)；请按需单独上传\]/g)) {
          assert.ok(fs.existsSync(path.resolve(path.dirname(file), match[1])), file + ' references missing ' + match[1]);
          textImageLinks++;
        }
      }
      assert.equal(textImageLinks, partial ? 7 : 8, 'extracted TXT summaries retain all image paths');
    }
  } finally {
    await context.close();
  }
}

for (const [name, executable, viaCdp] of [['Chromium', chromiumPath, false], ['Chrome', chromePath, true], ['Edge', edgePath, false]]) {
  test(name + ': closes the popup while exporting and downloads every part', { timeout: 60000 }, t => exercise(t, executable, false, viaCdp));
  test(name + ': reports a failed second download without claiming success', { timeout: 60000 }, t => exercise(t, executable, true, viaCdp));
}
test('Chrome: partial images and unsupported attachments are shown in the popup and report', { timeout: 60000 }, t => exercise(t, chromePath, false, true, true));
