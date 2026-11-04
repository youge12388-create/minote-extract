// Classic ZIP with UTF-8 names and stored entries. Each archive is bounded.
class ZipWriter {
  static MAX_BYTES = 128 * 1024 * 1024;
  static MAX_ENTRIES = 10000;
  static encoder = new TextEncoder();
  static crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
    return value >>> 0;
  });

  constructor({ maxBytes = ZipWriter.MAX_BYTES, maxEntries = ZipWriter.MAX_ENTRIES } = {}) {
    this.maxBytes = Math.min(maxBytes, 0xffffffff);
    this.maxEntries = Math.min(maxEntries, 0xffff);
    this.files = [];
    this.size = 22;
  }

  static describe(name, data) {
    const nameBytes = ZipWriter.encoder.encode(name);
    if (!nameBytes.length || nameBytes.length > 0xffff) throw Error('ZIP 文件名长度无效');
    const content = typeof data === 'string' ? ZipWriter.encoder.encode(data) : data;
    if (!(content instanceof Blob) && !(content instanceof Uint8Array)) throw Error('ZIP 文件内容类型无效');
    const length = content instanceof Blob ? content.size : content.byteLength;
    if (length > 0xffffffff) throw Error('单个文件超过 ZIP 格式上限');
    return { nameBytes, content, length, bytes: 30 + 46 + 2 * nameBytes.length + length };
  }

  canAdd(name, data) { return this.canAddEntry(ZipWriter.describe(name, data)); }
  canAddEntry(entry) { return this.files.length < this.maxEntries && this.size + entry.bytes <= this.maxBytes; }

  add(name, data, entry = ZipWriter.describe(name, data)) {
    if (!this.canAddEntry(entry)) throw Error('ZIP 分包已达到安全上限');
    this.files.push(entry);
    this.size += entry.bytes;
  }

  static async crc32(content) {
    let crc = 0xffffffff;
    const update = bytes => {
      for (let index = 0; index < bytes.length; index++) crc = (crc >>> 8) ^ ZipWriter.crcTable[(crc ^ bytes[index]) & 0xff];
    };
    if (content instanceof Blob) {
      const reader = content.stream().getReader();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          update(value);
        }
      } finally { reader.releaseLock(); }
    } else { update(content); }
    return (crc ^ 0xffffffff) >>> 0;
  }

  async blob() {
    const parts = [], directory = [];
    let offset = 0;
    for (const file of this.files) {
      const crc = await ZipWriter.crc32(file.content);
      const header = new Uint8Array(30 + file.nameBytes.length);
      const view = new DataView(header.buffer);
      view.setUint32(0, 0x04034b50, true);
      view.setUint16(4, 20, true);
      view.setUint16(6, 0x800, true);
      view.setUint32(14, crc, true);
      view.setUint32(18, file.length, true);
      view.setUint32(22, file.length, true);
      view.setUint16(26, file.nameBytes.length, true);
      header.set(file.nameBytes, 30);
      parts.push(header, file.content);

      const central = new Uint8Array(46 + file.nameBytes.length);
      const centralView = new DataView(central.buffer);
      centralView.setUint32(0, 0x02014b50, true);
      centralView.setUint16(4, 20, true);
      centralView.setUint16(6, 20, true);
      centralView.setUint16(8, 0x800, true);
      centralView.setUint32(16, crc, true);
      centralView.setUint32(20, file.length, true);
      centralView.setUint32(24, file.length, true);
      centralView.setUint16(28, file.nameBytes.length, true);
      centralView.setUint32(42, offset, true);
      central.set(file.nameBytes, 46);
      directory.push(central);
      offset += header.length + file.length;
    }
    const directorySize = directory.reduce((total, entry) => total + entry.length, 0);
    const end = new Uint8Array(22);
    const view = new DataView(end.buffer);
    view.setUint32(0, 0x06054b50, true);
    view.setUint16(8, this.files.length, true);
    view.setUint16(10, this.files.length, true);
    view.setUint32(12, directorySize, true);
    view.setUint32(16, offset, true);
    return new Blob([...parts, ...directory, end], { type: 'application/zip' });
  }
}

class PartWriter {
  constructor(onPart, batch, limits) {
    this.onPart = onPart;
    this.batch = batch;
    this.limits = limits;
    this.parts = [];
    this.zip = new ZipWriter(limits);
  }
  filename(index, multiple) {
    return multiple ? this.batch + '_分包' + String(index).padStart(3, '0') + '.zip' : this.batch + '.zip';
  }
  async add(name, data) {
    const entry = ZipWriter.describe(name, data);
    if (!this.zip.canAddEntry(entry)) {
      if (!this.zip.files.length) throw Error('文件超过单个分包安全上限：' + name);
      await this.flush(false);
      if (!this.zip.canAddEntry(entry)) throw Error('文件超过单个分包安全上限：' + name);
    }
    this.zip.add(name, data, entry);
  }
  async flush(final) {
    const index = this.parts.length + 1;
    const multiple = !final || this.parts.length > 0;
    const filename = this.filename(index, multiple);
    try {
      const blob = await this.zip.blob();
      await this.onPart(blob, { filename, index, multiple, final });
    } catch (cause) {
      const error = Error('分包 ' + index + ' 打包或下载失败：' + cause.message + '；已完成 ' + this.parts.length + ' 个分包，当前导出不完整');
      error.fatalExport = true;
      throw error;
    }
    this.parts.push(filename);
    this.zip = new ZipWriter(this.limits);
  }
  async finish(makeReport, instructions) {
    while (true) {
      const finalIndex = this.parts.length + 1;
      const names = this.parts.concat(this.filename(finalIndex, this.parts.length > 0));
      const report = makeReport(names);
      const reportEntry = ZipWriter.describe('导出报告.txt', report);
      const infoEntry = ZipWriter.describe('使用说明.txt', instructions);
      const fits = this.zip.files.length + 2 <= this.zip.maxEntries &&
        this.zip.size + reportEntry.bytes + infoEntry.bytes <= this.zip.maxBytes;
      if (fits) {
        this.zip.add('导出报告.txt', report, reportEntry);
        this.zip.add('使用说明.txt', instructions, infoEntry);
        await this.flush(true);
        return this.parts;
      }
      if (!this.zip.files.length) throw Error('导出报告超过单个分包安全上限，无法生成完整报告');
      await this.flush(false);
    }
  }
}
