let creating;
async function hasWorker() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [chrome.runtime.getURL('worker.html')] });
  return contexts.length > 0;
}
async function ensureWorker() {
  if (await hasWorker()) return;
  if (!creating) creating = chrome.offscreen.createDocument({url:'worker.html', reasons:['BLOBS'], justification:'在弹窗关闭后继续处理笔记、图片和 ZIP 文件'}).finally(()=>{creating=null});
  await creating;
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message.target !== 'background') return;
  (async () => {
    if (message.type === 'status') {
      if (!await hasWorker()) return {running:false, message:'准备就绪'};
      return await chrome.runtime.sendMessage({target:'worker',type:'status'});
    }
    if (message.type === 'start') {
      await ensureWorker();
      return await chrome.runtime.sendMessage({target:'worker',type:'start'});
    }
    if (message.type === 'download') {
      const id = await chrome.downloads.download({url:message.url, filename:message.filename, saveAs:false});
      return {id};
    }
    if (message.type === 'downloadStatus') {
      const [item] = await chrome.downloads.search({id:message.id});
      if (!item) return {error:'找不到下载记录'};
      return {state:item.state, downloadError:item.error || ''};
    }
  })().then(respond, error => respond({error:error.message}));
  return true;
});
