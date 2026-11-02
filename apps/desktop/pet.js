const el = id => document.getElementById(id);
let paths = [];
let sending = false;
let polling = false;
let tracked = false;
const say = text => { el('bubble').textContent = text; };
el('face').onclick = el('open').onclick = () => window.petBridge.open().catch(error => say(error.message));
el('clear').onclick = () => { paths = []; el('files').textContent = ''; };
for (const name of ['dragenter','dragover']) document.addEventListener(name, event => { event.preventDefault(); el('pet').classList.add('dragging'); });
document.addEventListener('dragleave', () => el('pet').classList.remove('dragging'));
document.addEventListener('drop', event => {
  event.preventDefault(); el('pet').classList.remove('dragging');
  try {
    const incoming = [...event.dataTransfer.files].map(file => window.petBridge.filePath(file)).filter(Boolean);
    if (incoming.length) {
      if (new Set([...paths, ...incoming]).size > 4) throw new Error('最多喂入 4 个文件');
      paths = [...new Set([...paths, ...incoming])];
      el('files').textContent = paths.map(path => path.split(/[\\/]/).pop()).join(' · ');
      say('接到文件啦！写下要求，点击“喂给 luban”确认发送给模型。');
    } else { el('task').value = event.dataTransfer.getData('text/plain').slice(0, 8000); }
  } catch (error) { say(error.message); }
});
el('feed').onclick = async () => {
  if (sending) return;
  sending = true; el('feed').disabled = true;
  try {
    await window.petBridge.submit({ text: el('task').value, paths });
    tracked = true; el('pet').classList.add('working');
    el('task').value = ''; paths = []; el('files').textContent = '';
    say('吃进去啦，正在处理…需要授权时请在主界面确认。');
  } catch (error) { say(error.message); }
  finally { sending = false; el('feed').disabled = false; }
};
setInterval(async () => {
  if (polling || sending || !tracked) return;
  polling = true;
  try {
    const result = await window.petBridge.status();
    const working = ['queued','pending','working'].includes(result.status);
    el('pet').classList.toggle('working', working);
    el('mouth').textContent = working ? '嚼嚼嚼…' : result.status === 'done' ? '结果出炉！' : 'luban 在这里';
    say(result.status === 'approval' ? '需要你确认权限或回答问题，请点击“主界面 / 审批”。' : working ? '正在认真消化任务…' : result.text || result.status);
    if (result.status === 'idle') tracked = false;
  } catch (error) { say(error.message); }
  finally { polling = false; }
}, 2000);
