const start=document.querySelector('#start'),status=document.querySelector('#status'),progress=document.querySelector('#progress');
let pending=false;
function render(state){if(!state)return;status.textContent=state.error||state.message||'准备就绪';start.disabled=pending||!!state.running;progress.hidden=!state.running;if(state.total){progress.max=state.total;progress.value=state.done||0}else progress.removeAttribute('value')}
async function refresh(){try{render(await chrome.runtime.sendMessage({target:'background',type:'status'}))}catch(e){render({error:`无法读取任务状态：${e.message}`})}}
start.addEventListener('click',async()=>{if(pending)return;pending=true;start.disabled=true;try{render(await chrome.runtime.sendMessage({target:'background',type:'start'}))}catch(e){render({error:`启动失败：${e.message}`})}finally{pending=false;await refresh()}});
refresh();setInterval(refresh,1000);
