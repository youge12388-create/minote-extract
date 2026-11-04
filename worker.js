let state = { running: false, message: '准备就绪' };

async function downloadPart(blob, part) {
  state = { running: true, message: '正在下载' + (part.multiple ? '第 ' + part.index + ' 个分包' : ' ZIP') + '…' };
  const url = URL.createObjectURL(blob);
  try {
    const response = await chrome.runtime.sendMessage({ target: 'background', type: 'download', url, filename: part.filename });
    if (!response || response.error || response.id == null) throw Error(response?.error || '无法启动下载');
    while (true) {
      const status = await chrome.runtime.sendMessage({ target: 'background', type: 'downloadStatus', id: response.id });
      if (!status || status.error) throw Error(status?.error || '无法读取下载状态');
      if (status.state === 'complete') return;
      if (status.state === 'interrupted') throw Error(status.downloadError || '下载已中断');
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function run() {
  state = { running: true, message: '正在准备导出…' };
  try {
    const result = await MiExport.run((message, done, total) => {
      state = { running: true, message, done, total };
    }, { onPart: downloadPart });
    const incomplete = result.listIncomplete || result.partial || result.failed || result.issues.length;
    state = {
      running: false,
      message: (incomplete ? '导出部分完成' : '导出完成') + '：发现 ' + result.total + ' 条，完整 ' + result.success +
        ' 条，部分成功 ' + result.partial + ' 条，失败 ' + result.failed + ' 条，图片 ' + result.imageCount +
        ' 张，图片问题 ' + result.imageIssues + ' 项，附件问题 ' + result.attachmentIssues +
        ' 项，下载 ' + result.parts.length + ' 个 ZIP。' +
        (result.listIncomplete ? '笔记列表不完整。' : '') +
        (incomplete ? '请查看最后一包中的导出报告。' : '')
    };
  } catch (error) {
    state = { running: false, message: '导出中止：' + error.message + '。' };
  }
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message.target !== 'worker') return;
  if (message.type === 'status') respond(state);
  if (message.type === 'start') { if (!state.running) run(); respond(state); }
});
