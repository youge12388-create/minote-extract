const MiExport = (() => {
  const IMAGE_LIMIT = 120 * 1024 * 1024;
  const SUMMARY_LIMIT = 8 * 1024 * 1024;
  const encoder = new TextEncoder();
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
  const wellFormed = value => {
    const text = String(value ?? '');
    return typeof text.toWellFormed === 'function' ? text.toWellFormed() :
      text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD');
  };
  const safe = value => {
    const text = wellFormed(value || '未命名').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/[. ]+$/, '');
    let result = '';
    for (const char of text) {
      if (result.length + char.length > 40) break;
      result += char;
    }
    return result.replace(/[. ]+$/, '') || '未命名';
  };
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

  async function request(url, options) {
    let last;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetch(url, { credentials: 'include' });
        if (!response.ok) throw Error('HTTP ' + response.status);
        if (!options.binary) {
          const json = await response.json();
          if (json.result !== 'ok' || !json.data) throw Error('接口返回异常，请检查登录状态');
          return json.data;
        }
        const type = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
        if (!type.startsWith('image/')) throw Error('返回内容不是图片，可能已退出登录');
        const length = Number(response.headers.get('content-length'));
        if (Number.isFinite(length) && length > options.imageLimit) {
          if (response.body) await response.body.cancel().catch(() => {});
          const error = Error('图片超过 120 MiB 安全限制');
          error.tooLarge = true;
          throw error;
        }
        const reader = response.body?.getReader();
        if (!reader) {
          const blob = await response.blob();
          if (blob.size > options.imageLimit) {
            const error = Error('图片超过 120 MiB 安全限制');
            error.tooLarge = true;
            throw error;
          }
          return blob;
        }
        const chunks = [];
        let total = 0;
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > options.imageLimit) {
              await reader.cancel().catch(() => {});
              const error = Error('图片超过 120 MiB 安全限制');
              error.tooLarge = true;
              throw error;
            }
            chunks.push(value);
          }
        } finally {
          reader.releaseLock();
        }
        return new Blob(chunks, { type });
      } catch (error) {
        last = error;
        if (error.tooLarge) throw error;
        if (attempt < 2) await wait(options.retryDelay * (attempt + 1));
      }
    }
    throw last;
  }

  function parseExtra(note) {
    if (!note || note.extraInfo == null || note.extraInfo === '') return { value: {}, invalid: false };
    if (typeof note.extraInfo === 'object') return { value: note.extraInfo || {}, invalid: false };
    try {
      const value = JSON.parse(note.extraInfo);
      return { value: value && typeof value === 'object' ? value : {}, invalid: !value || typeof value !== 'object' };
    } catch {
      return { value: {}, invalid: true };
    }
  }

  function attachments(note, warn) {
    const result = [], seen = new Set();
    for (const source of [note.setting?.data, note.files]) {
      if (source == null) continue;
      if (!Array.isArray(source)) {
        warn('附件列表格式无法识别');
        continue;
      }
      for (const file of source) {
        const id = file && (file.rawId || file.fileId || file.digest);
        if (!id) { warn('附件缺少文件标识'); continue; }
        const key = String(id);
        if (!seen.has(key)) { seen.add(key); result.push(file); }
      }
    }
    return result;
  }

  function fallbackTitle(content) {
    const doc = new DOMParser().parseFromString(String(content || ''), 'text/html');
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (node.parentElement?.closest('script,style,svg,iframe,object')) continue;
      for (const part of node.nodeValue.split(/\r?\n/)) {
        const line = part.replace(/\s+/g, ' ').trim();
        if (!line || /^☺\s*\S+/.test(line)) continue;
        const chars = Array.from(line);
        return chars.length > 48 ? chars.slice(0, 48).join('') + '…' : line;
      }
    }
    return '无标题';
  }

  function convert(content, images, warn = () => {}) {
    const doc = new DOMParser().parseFromString(String(content || ''), 'text/html');
    const warned = new Set();
    const report = (text, kind) => { if (!warned.has(text)) { warned.add(text); warn(text, kind); } };
    const sortedIds = Array.from(images.keys()).sort((a, b) => b.length - a.length);
    function imageMarkup(id) {
      const image = images.get(id);
      if (image) image.used = true;
      if (image?.path) return '<img src="' + esc(image.path) + '" alt="笔记图片">';
      report('图片 ' + id + ' 未识别或下载失败', 'image');
      return '<span>[图片未能识别或下载：' + esc(id) + ']</span>';
    }
    function renderText(text) {
      const pattern = /☺\s*([^\s☺<>]+)/g;
      let match, result = '', previous = 0;
      while ((match = pattern.exec(text))) {
        result += esc(text.slice(previous, match.index));
        result += images.has(match[1]) ? imageMarkup(match[1]) :
          esc(match[0]) + '<span>[图片未能识别或下载]</span>';
        if (!images.has(match[1])) report('未识别图片标记：' + match[1], 'image');
        previous = pattern.lastIndex;
      }
      return result + esc(text.slice(previous));
    }
    function render(node) {
      if (node.nodeType === 3) return renderText(node.nodeValue);
      if (node.nodeType !== 1) return '';
      const tag = node.localName;
      if (['script', 'style', 'iframe', 'object', 'svg'].includes(tag)) {
        report('不支持的内容类型：' + tag);
        return '';
      }
      if (tag === 'img') {
        const expand = value => {
          try { return [value, decodeURIComponent(value)]; } catch { return [value]; }
        };
        const values = [node.getAttribute('id'), node.getAttribute('data'), node.getAttribute('src')].filter(Boolean);
        const candidates = values.flatMap(expand);
        const locations = [node.getAttribute('data'), node.getAttribute('src')].filter(Boolean).flatMap(expand);
        const id = sortedIds.find(value => candidates.includes(value)) ||
          sortedIds.find(value => locations.some(raw => raw.includes(value)));
        if (id) return imageMarkup(id);
        report('存在未识别的图片引用', 'image');
        return '<span>[图片未能识别或下载]</span>';
      }
      if (tag === 'input') {
        if (node.getAttribute('type') === 'checkbox') {
          return '<span>' + (node.hasAttribute('checked') && node.getAttribute('checked') !== 'false' ? '☑' : '☐') + ' </span>';
        }
        report('不支持的输入内容类型：' + (node.getAttribute('type') || 'text'));
        return esc(node.getAttribute('value') || '');
      }
      const children = Array.from(node.childNodes, render).join('');
      if (tag === 'a') {
        const href = node.getAttribute('href') || '';
        try {
          const url = new URL(href, 'https://i.mi.com/');
          if (href && ['http:', 'https:', 'mailto:'].includes(url.protocol)) {
            return '<a href="' + esc(url.href) + '">' + children + '</a>';
          }
        } catch {}
        if (href) report('不支持的链接地址：' + href);
        return '<span>' + children + (href ? ' (' + esc(href) + ')' : '') + '</span>';
      }
      const map = {
        text: 'div', size: 'h2', 'mid-size': 'h3', 'h3-size': 'h4', bullet: 'li',
        order: 'li', delete: 'del', background: 'mark', quote: 'blockquote',
        b: 'b', strong: 'strong', i: 'i', em: 'em', u: 'u', br: 'br', hr: 'hr',
        p: 'p', div: 'div', span: 'span', ul: 'ul', ol: 'ol', li: 'li',
        h1: 'h1', h2: 'h2', h3: 'h3', h4: 'h4', h5: 'h5', h6: 'h6',
        pre: 'pre', code: 'code', del: 'del', s: 's', blockquote: 'blockquote'
      };
      const mapped = map[tag];
      if (!mapped) { report('不支持的内容格式：' + tag); return children; }
      return mapped === 'br' || mapped === 'hr' ? '<' + mapped + '>' :
        '<' + mapped + '>' + children + '</' + mapped + '>';
    }
    return Array.from(doc.body.childNodes, render).join('');
  }

  function makeText(html, prefix, markdown) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const escapePath = path => path.split('/').map(part => encodeURIComponent(wellFormed(part))).join('/');
    function walk(node) {
      if (node.nodeType === 3) return node.nodeValue;
      if (node.nodeType !== 1) return '';
      const tag = node.localName, content = Array.from(node.childNodes, walk).join('');
      if (tag === 'img') {
        const path = prefix + (node.getAttribute('src') || '');
        return markdown ? '\n\n![图片](<' + escapePath(path) + '>)\n\n' :
          '\n\n[图片：' + path + '；请按需单独上传]\n\n';
      }
      if (tag === 'a') {
        const href = node.getAttribute('href') || '';
        return markdown ? '[' + content.replace(/([\\\[\]])/g, '\\$1') + '](<' + href.replace(/[<>]/g, encodeURIComponent) + '>)' :
          content + ' (' + href + ')';
      }
      if (tag === 'br') return '\n';
      if (tag === 'hr') return markdown ? '\n\n---\n\n' : '\n\n';
      if (tag === 'li') return '\n- ' + content.trim() + '\n';
      if (tag === 'blockquote') return markdown ? '\n\n' + content.trim().split('\n').map(line => '> ' + line).join('\n') + '\n\n' : '\n\n' + content + '\n\n';
      if (/^h[1-6]$/.test(tag)) return '\n\n' + (markdown ? '#'.repeat(Math.min(6, Number(tag[1]) + 1)) + ' ' : '') + content.trim() + '\n\n';
      if (['div', 'p', 'ul', 'ol', 'pre'].includes(tag)) return '\n\n' + content + '\n\n';
      if (markdown && ['b', 'strong'].includes(tag)) return '**' + content + '**';
      if (markdown && ['i', 'em'].includes(tag)) return '*' + content + '*';
      if (markdown && ['del', 's'].includes(tag)) return '~~' + content + '~~';
      return content;
    }
    return Array.from(doc.body.childNodes, walk).join('').replace(/\n[ \t]+\n/g, '\n\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  function splitText(text, maxBytes) {
    const bytes = encoder.encode(wellFormed(text));
    if (!bytes.length) return [''];
    const chunks = [], decoder = new TextDecoder();
    for (let start = 0; start < bytes.length;) {
      let end = Math.min(start + maxBytes, bytes.length);
      while (end < bytes.length && end > start && (bytes[end] & 0xc0) === 0x80) end--;
      if (end < bytes.length) {
        let lineEnd = end;
        while (lineEnd > start && bytes[lineEnd - 1] !== 10) lineEnd--;
        if (lineEnd > start) end = lineEnd;
      }
      if (end === start) throw Error('文本分片大小不足');
      chunks.push(decoder.decode(bytes.subarray(start, end)));
      start = end;
    }
    return chunks;
  }

  function uniqueAllocator() {
    const paths = new Set();
    return candidate => {
      const key = value => wellFormed(value).normalize('NFC').toLowerCase();
      let result = candidate, number = 2;
      const slash = candidate.lastIndexOf('/'), dot = candidate.lastIndexOf('.');
      const split = dot > slash ? dot : candidate.length;
      while (paths.has(key(result))) {
        result = candidate.slice(0, split) + '_' + number++ + candidate.slice(split);
      }
      paths.add(key(result));
      return result;
    };
  }

  class TextSegments {
    constructor(base, prefix, writer, allocate, limit) {
      this.base = base;
      this.prefix = prefix;
      this.writer = writer;
      this.allocate = allocate;
      this.limit = limit;
      this.buffer = prefix;
      this.size = encoder.encode(prefix).length;
      this.count = 0;
      this.hasContent = true;
    }
    async append(text) {
      const capacity = this.limit - encoder.encode(this.prefix).length;
      for (const chunk of splitText(text, capacity)) {
        const bytes = encoder.encode(chunk).length;
        if (this.hasContent && this.size + bytes > this.limit) await this.flush(true);
        this.buffer += chunk;
        this.size += bytes;
        this.hasContent = true;
      }
    }
    async flush(numbered) {
      if (!this.hasContent) return;
      this.count++;
      const dot = this.base.lastIndexOf('.');
      const name = numbered || this.count > 1 ?
        this.base.slice(0, dot) + '_' + String(this.count).padStart(3, '0') + this.base.slice(dot) : this.base;
      await this.writer.add(this.allocate(name), this.buffer);
      this.buffer = this.prefix;
      this.size = encoder.encode(this.prefix).length;
      this.hasContent = false;
    }
    async finish() { await this.flush(this.count > 0); }
  }

  async function run(progress, options = {}) {
    const limits = {
      maxBytes: options.maxBytes ?? ZipWriter.MAX_BYTES,
      maxEntries: options.maxEntries ?? ZipWriter.MAX_ENTRIES
    };
    const requestOptions = {
      imageLimit: options.imageLimit ?? IMAGE_LIMIT,
      retryDelay: options.retryDelay ?? 500
    };
    const summaryLimit = Math.min(options.summaryLimit ?? SUMMARY_LIMIT, Math.floor(limits.maxBytes / 4));
    if (summaryLimit < 256 || limits.maxEntries < 3) throw Error('分包限制过小');
    const now = new Date();
    const batch = options.batchId || '小米笔记_' +
      [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-') +
      '_' + [now.getHours(), now.getMinutes(), now.getSeconds()].map(value => String(value).padStart(2, '0')).join('') +
      '_' + Math.random().toString(36).slice(2, 8);
    const onPart = options.onPart || (async () => { throw Error('未配置下载处理'); });
    const writer = new PartWriter(onPart, batch, limits), allocate = uniqueAllocator();
    const issues = [], notes = [], folders = new Map(), seen = new Set(), pages = new Set();
    let listIncomplete = false, tag = '';
    const listIssue = message => { listIncomplete = true; issues.push('笔记列表：' + message); };

    while (true) {
      progress('正在读取笔记列表：已发现 ' + notes.length + ' 条');
      let data;
      try {
        const params = new URLSearchParams({ ts: String(Date.now()), limit: '200' });
        if (tag) params.set('syncTag', tag);
        data = await request('https://i.mi.com/note/full/page/?' + params, requestOptions);
        if (!Array.isArray(data.entries)) throw Error('笔记列表格式异常');
      } catch (error) {
        listIssue('读取失败：' + error.message);
        break;
      }
      if (Array.isArray(data.folders)) {
        for (const folder of data.folders) if (folder?.id != null) folders.set(String(folder.id), folder);
      } else if (data.folders != null) listIssue('分类列表格式无法识别');
      for (const note of data.entries) {
        if (!note || note.id == null || String(note.id) === '') { listIssue('发现缺少标识的笔记'); continue; }
        const id = String(note.id);
        if (!seen.has(id)) { seen.add(id); notes.push(note); }
      }
      if (data.lastPage === true || data.lastPage === 1 || data.lastPage === 'true' || data.lastPage === '1') break;
      const next = String(data.syncTag ?? '');
      if (!next || pages.has(next)) { listIssue('分页标记缺失或重复，可能仍有笔记未读取'); break; }
      pages.add(next);
      tag = next;
      if (options.pageDelay !== 0) await wait(options.pageDelay ?? 150);
    }

    const full = new TextSegments('AI阅读_全部笔记.md', '# 小米笔记汇总\n\n图片路径指向压缩包中的文件。\n', writer, allocate, summaryLimit);
    const plain = new TextSegments('AI阅读_全部笔记.txt', '\uFEFF小米笔记汇总\n图片请按需单独上传。\n', writer, allocate, summaryLimit);
    const groups = new Map(), dirs = new Map(), usedDirs = new Set();
    function folderDirectory(fid, name) {
      const key = fid || '0';
      if (dirs.has(key)) return dirs.get(key);
      const base = safe(name) + '_' + safe(key);
      let dir = base, index = 2;
      while (usedDirs.has(dir.normalize('NFC').toLowerCase())) dir = base + '_' + index++;
      usedDirs.add(dir.normalize('NFC').toLowerCase());
      dirs.set(key, dir);
      return dir;
    }
    let complete = 0, partial = 0, failed = 0, imageCount = 0, imageIssues = 0, attachmentIssues = 0;
    let groupBytes = 0;
    const maxGroupBytes = Math.max(summaryLimit * 2, 1024);
    for (let index = 0; index < notes.length; index++) {
      const summary = notes[index], id = String(summary.id), problems = [];
      const warn = (text, kind) => {
        if (problems.includes(text)) return;
        problems.push(text);
        if (kind === 'image') imageIssues++;
        if (kind === 'attachment') attachmentIssues++;
      };
      progress('正在导出 ' + (index + 1) + ' / ' + notes.length + ' 条笔记', index, notes.length);
      let detail = null, detailError = '';
      try {
        detail = (await request('https://i.mi.com/note/note/' + encodeURIComponent(id) + '/?ts=' + Date.now(), requestOptions)).entry;
        if (!detail || typeof detail !== 'object') throw Error('详情为空');
        if (detail.id != null && String(detail.id) !== id) throw Error('详情标识与列表不一致');
      } catch (error) {
        detail = null;
        detailError = error.message;
        warn('详情读取失败：' + error.message);
      }
      const note = { ...summary, ...(detail || {}) };
      const detailExtra = parseExtra(detail), summaryExtra = parseExtra(summary);
      if (detailExtra.invalid) warn('详情附加信息无法解析');
      let content;
      const fullCandidates = [detailExtra.value.mind_content, detail?.content].filter(value => typeof value === 'string');
      const hasFull = fullCandidates.length > 0;
      if (hasFull) content = fullCandidates.find(value => value.length > 0) ?? fullCandidates[0];
      else {
        const fallback = [detail?.snippet, summaryExtra.value.mind_content, summary.content, summary.snippet]
          .find(value => typeof value === 'string' && value.length > 0);
        content = fallback ?? '';
        if (fallback != null) warn('仅取得摘要或列表内容，正文可能不完整');
        else if (!detailError) warn('详情缺少正文');
      }
      const unreadable = !hasFull && !content;
      const info = Object.keys(detailExtra.value).length ? detailExtra.value : summaryExtra.value;
      const title = String(info.title || note.subject || fallbackTitle(content)).replace(/[\r\n]+/g, ' ');
      const fid = String(note.folderId || ''), folder = folders.get(fid);
      const folderName = folder ? (folder.subject || folder.name || '未命名文件夹') :
        (fid && fid !== '0' ? '未知分类_' + fid : '未分类');
      const dir = folderDirectory(fid, folderName), images = new Map();
      const files = attachments(note, text => warn(text, 'attachment'));
      for (let j = 0; j < files.length; j++) {
        const file = files[j], imageId = String(file.rawId || file.fileId || file.digest);
        const mime = String(file.mimeType || '').toLowerCase();
        if (mime && !mime.startsWith('image/')) {
          warn('附件 ' + (j + 1) + '（' + mime + '）不支持导出', 'attachment');
          continue;
        }
        images.set(imageId, { path: null, used: false });
        try {
          const params = new URLSearchParams({ type: 'note_img', fileid: imageId, ts: String(Date.now()) });
          const blob = await request('https://i.mi.com/file/full?' + params, { ...requestOptions, binary: true });
          const extensions = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp', 'image/avif': 'avif' };
          const ext = extensions[blob.type] || 'img';
          const path = allocate(dir + '/图片/' + safe(id) + '_' + (j + 1) + '.' + ext);
          const entry = ZipWriter.describe(path, blob);
          if (22 + entry.bytes > limits.maxBytes) throw Error('图片超过单个分包安全上限');
          await writer.add(path, blob);
          images.get(imageId).path = path.slice(dir.length + 1);
          imageCount++;
        } catch (error) {
          if (error.fatalExport) throw error;
          warn('图片 ' + (j + 1) + ' 下载失败：' + error.message, 'image');
        }
      }
      const html = convert(content, images, warn);
      for (const [imageId, image] of images) if (image.path && !image.used) warn('图片 ' + imageId + ' 已下载但未匹配到正文引用', 'image');
      const status = unreadable ? 'failed' : problems.length ? 'partial' : 'complete';
      if (status === 'complete') complete++;
      else if (status === 'partial') partial++;
      else failed++;
      for (const problem of problems) issues.push('笔记 ' + id + '：' + problem);
      const date = note.createDate && !Number.isNaN(new Date(Number(note.createDate)).getTime()) ?
        new Date(Number(note.createDate)).toLocaleString('zh-CN') : '未知';
      const notice = status === 'complete' ? '' :
        '⚠ ' + (status === 'failed' ? '未能读取完整笔记' : '本笔记未完整导出') + '，请查看导出报告。\n\n';
      const header = '# ' + title + '\n\n创建时间：' + date + '  \n分类：' + folderName + '\n\n' + notice;
      const individual = header + makeText(html, './', true) + '\n';
      const noteBase = dir + '/' + safe(title) + '_' + safe(id);
      const noteChunks = splitText(individual, Math.max(256, limits.maxBytes - 4096));
      for (let part = 0; part < noteChunks.length; part++) {
        const suffix = noteChunks.length > 1 ? '_' + String(part + 1).padStart(3, '0') : '';
        await writer.add(allocate(noteBase + suffix + '.md'), noteChunks[part]);
      }
      const heading = '\n\n## ' + title + '\n\n创建时间：' + date + '  \n分类：' + folderName + '\n\n' + notice;
      let group = groups.get(dir);
      if (!group) {
        group = new TextSegments('分类汇总/' + dir + '.md', '# ' + folderName + '\n', writer, allocate, summaryLimit);
        groups.set(dir, group);
        groupBytes += group.size;
      }
      const oldSize = group.size;
      await group.append(heading + makeText(html, '../' + dir + '/', true) + '\n\n---\n');
      groupBytes += group.size - oldSize;
      while (groupBytes > maxGroupBytes) {
        let largest = null;
        for (const candidate of groups.values()) if (candidate.hasContent && (!largest || candidate.size > largest.size)) largest = candidate;
        if (!largest) break;
        const previous = largest.size;
        await largest.flush(true);
        groupBytes += largest.size - previous;
      }
      await full.append('\n\n## 分类：' + folderName + '\n\n### ' + title + '\n\n创建时间：' + date + '  \n分类：' + folderName + '\n\n' + notice + makeText(html, './' + dir + '/', true) + '\n\n---\n');
      await plain.append('\n\n========== 分类：' + folderName + ' ==========\n\n标题：' + title + '\n创建时间：' + date + '\n分类：' + folderName + '\n\n' + notice + makeText(html, './' + dir + '/', false) + '\n\n--------------------\n');
      if (options.noteDelay !== 0) await wait(options.noteDelay ?? 100);
    }
    for (const group of groups.values()) await group.finish();
    await full.finish();
    await plain.finish();
    const instructions = '请将本次所有 ZIP 分包解压到同一个文件夹，保留目录结构。\n' +
      '请先查看导出报告，确认分包是否齐全，以及笔记、图片、附件是否存在未完整导出的项目。\n' +
      'AI阅读文件和分类汇总可能按大小分段；图片需要时请单独上传。\n' +
      '私密笔记、回收站及非图片附件不在本次导出范围。\n';
    const makeReport = names => '导出批次：' + batch + '\n' +
      '列表状态：' + (listIncomplete ? '不完整，请核对原笔记' : '已读取到最后一页') + '\n' +
      '发现笔记：' + notes.length + '\n完整笔记：' + complete + '\n部分成功：' + partial +
      '\n失败笔记：' + failed + '\n已下载图片：' + imageCount + '\n图片问题：' + imageIssues +
      '\n附件问题：' + attachmentIssues + '\n失败或提示：' + issues.length +
      '\n分包数量：' + names.length + '\n' + names.join('\n') + '\n\n' +
      (issues.join('\n') || '未发现下载错误。') + '\n';
    progress('正在完成打包和下载，请保持浏览器运行…');
    const partNames = await writer.finish(makeReport, instructions);
    return { total: notes.length, success: complete, partial, failed, imageCount, imageIssues, attachmentIssues, issues, listIncomplete, parts: partNames };
  }

  return { run, convert, safe };
})();
