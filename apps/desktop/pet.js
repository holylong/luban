const el = id => document.getElementById(id);
let paths = [];
let sending = false;
let polling = false;
let tracked = false;
let queueOpen = false;
let lastDoneId;
let soulWas;
const say = text => { el('bubble').textContent = text; };
el('face').onclick = el('open').onclick = () => window.petBridge.open().catch(error => say(error.message));
el('clear').onclick = () => { paths = []; el('files').textContent = ''; };
for (const name of ['dragenter', 'dragover']) document.addEventListener(name, event => { event.preventDefault(); el('pet').classList.add('dragging'); });
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

// The soul row: a dot plus what the bot worker is doing right now.
const SOUL = {
  stopped: ['● 造物主 · 未启动', 'off', '后台 bot 没有运行；点开看队列状态'],
  stale: ['● 造物主 · 锁残留', 'warn', 'worker.lock 仍在但没有进程；确认后手动删除'],
  idle: ['● 造物主 · 待命', 'ok', '后台常驻，等待队列里的任务'],
  busy: ['● 造物主 · 干活中', 'busy', '正在执行队列任务'],
  error: ['● 造物主 · 出错', 'err', 'worker 退出，点开看错误'],
};
function soulState(bot) {
  if (bot.error) return 'error';
  if (bot.worker.state === 'running') return bot.counts.running > 0 ? 'busy' : 'idle';
  if (bot.worker.state === 'stale') return 'stale';
  return 'stopped';
}
const STATUS_TEXT = { queued: '排队', running: '执行中', completed: '完成', failed: '失败', cancelled: '取消', interrupted: '中断' };
function row(text) { const line = document.createElement('div'); line.className = 'row'; line.textContent = text; return line; }
const age = startedAt => startedAt ? ` · ${Math.max(0, Math.round((Date.now() - startedAt) / 1000))}s` : '';
const tokens = value => value ? ` · ${value >= 1000 ? `${(value / 1000).toFixed(1)}k` : value} tok` : '';
const memory = mb => typeof mb === 'number' ? ` · ${mb} MB` : '';
function renderQueue(bot) {
  const panel = el('queue');
  panel.replaceChildren();
  if (bot.error) panel.append(row(`worker 错误：${bot.error}`));
  if (bot.machine) panel.append(row(`机器 · 负载 ${bot.machine.load1} · 内存 ${bot.machine.memoryUsedPct}%`));
  if (bot.task) panel.append(row(`造物主正在做：${bot.task.prompt}${age(bot.task.startedAt)}`));
  if (bot.agents && bot.agents.length) {
    panel.append(row(`子 agent ${bot.agents.length}（在各进程内运行，没有独立 PID）`));
    for (const agent of bot.agents) panel.append(row(`· PID ${agent.pid} · 深度 ${agent.depth} · ${agent.task}${age(agent.startedAt)}${tokens(agent.tokens)}`));
  }
  if (bot.process) {
    if (bot.process.children.length) {
      panel.append(row(`子进程 ${bot.process.children.length}`));
      for (const child of bot.process.children) panel.append(row(`· ${child.pid} ${child.command}`));
    }
    if (typeof bot.process.threads === 'number') panel.append(row(`线程 ${bot.process.threads}${memory(bot.process.memoryMb)} · 进程 ${bot.process.pid}`));
  }
  for (const backend of bot.backends || []) {
    const children = backend.children.length ? ` · 子进程 ${backend.children.length}` : '';
    panel.append(row(`后台进程 ${backend.pid} · 线程 ${typeof backend.threads === 'number' ? backend.threads : '?'}${memory(backend.memoryMb)}${children}`));
  }
  if (!bot.recent.length && !bot.requestCount && !bot.task) { panel.append(row('队列是空的。用 luban bot add "<任务>" 给造物主派活。')); }
  for (const task of bot.recent) {
    panel.append(row(`${STATUS_TEXT[task.status] || task.status} · ${task.title}${tokens(task.tokens)}${task.result ? `\n→ ${task.result}` : ''}`));
  }
  if (bot.requestCount) {
    panel.append(row(`待授权 ${bot.requestCount} 条（编辑 ~/.luban/bot/permissions.json）`));
    for (const request of bot.requests) panel.append(row(`· ${request.tool} · ${request.reason || request.workspace}`));
  }
}
function renderSoul(bot) {
  const state = soulState(bot);
  const [label, tone, hint] = SOUL[state];
  const chip = el('soul');
  chip.textContent = bot.counts.queued ? `${label} · 排队 ${bot.counts.queued}` : label;
  chip.className = `soul ${tone}`;
  chip.title = `${hint}${bot.owned ? '（由桌面 App 启动）' : ''}`;
  if (queueOpen) renderQueue(bot);
  // Say hello when the worker appears under an already-visible pet.
  if (state === 'idle' && soulWas && soulWas !== 'idle' && !tracked && !queueOpen) say('造物主上线，后台待命。');
  soulWas = state;
  // Announce a finished soul task only while the pet is not tracking its own job.
  const done = bot.recent.find(task => task.status === 'completed' && task.finishedAt);
  if (done && done.id !== lastDoneId) {
    if (lastDoneId && !tracked && !queueOpen) say(`造物主完成：${done.title}\n→ ${done.result || '（无输出）'}`);
    lastDoneId = done.id;
  }
}
el('soul').onclick = () => {
  queueOpen = !queueOpen;
  document.body.classList.toggle('queue-open', queueOpen);
  el('queue').classList.toggle('open', queueOpen);
  el('soul').setAttribute('aria-expanded', String(queueOpen));
  if (queueOpen) refreshBot();
};
async function refreshBot() {
  try { renderSoul(await window.petBridge.botStatus()); }
  catch (error) { el('soul').textContent = `● 造物主 · 状态不可读`; el('soul').title = error.message; }
}
window.petBridge.onBotChanged(() => refreshBot());
refreshBot();

setInterval(async () => {
  refreshBot();
  if (polling || sending || !tracked) return;
  polling = true;
  try {
    const result = await window.petBridge.status();
    const working = ['queued', 'pending', 'working'].includes(result.status);
    el('pet').classList.toggle('working', working);
    el('mouth').textContent = working ? '嚼嚼嚼…' : result.status === 'done' ? '结果出炉！' : 'luban 在这里';
    say(result.status === 'approval' ? '需要你确认权限或回答问题，请点击“主界面 / 审批”。' : working ? '正在认真消化任务…' : result.text || result.status);
    if (result.status === 'idle') tracked = false;
  } catch (error) { say(error.message); }
  finally { polling = false; }
}, 2000);
