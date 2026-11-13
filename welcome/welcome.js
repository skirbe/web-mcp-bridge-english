/** welcome.js - first-run wizard. Checks the status every 1.5 s and lets you control the bridge. */
const $ = (selector) => document.querySelector(selector);
let busy = false;
let latest = null;

async function send(type) {
  try { return (await chrome.runtime.sendMessage({ type })) ?? { ok: false, error: 'No response from the extension.' }; }
  catch (err) { return { ok: false, error: err.message }; }
}

function showMessage(text) {
  const el = $('#bridge-msg');
  el.hidden = !text;
  el.textContent = text ?? '';
}

function render(state) {
  const b = state.bridge ?? {};
  const servers = state.servers ?? [];
  const launcher = Boolean(b.launcherOnline);

  $('#step-launcher').dataset.state = launcher ? 'done' : 'current';
  $('#launcher-status').textContent = launcher ? 'Launcher active \u2713' : 'Not detected yet';
  $('#launcher-help').hidden = launcher;

  $('#step-bridge').dataset.state = !launcher ? 'pending' : (b.online ? 'done' : 'current');
  $('#bridge-status').textContent = !b.checked ? 'Checking\u2026' : (b.online ? 'Bridge connected \u2713' : (b.paused ? 'Stopped on purpose' : 'Off'));
  $('#btn-start').disabled = busy || !launcher || Boolean(b.online);
  $('#btn-restart').disabled = busy || !launcher || !b.online;
  $('#btn-stop').disabled = busy || !launcher || !b.online;

  const list = $('#server-list');
  list.replaceChildren(...servers.map((s) => {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = s.name;
    const tag = document.createElement('span');
    tag.className = 'tag' + (s.status === 'connected' ? ' on' : '');
    tag.textContent = s.status === 'connected' ? 'connected' : (s.enabled ? 'active' : 'disabled');
    li.append(name, tag);
    return li;
  }));
  const hasServers = b.online && servers.length > 0;
  $('#step-servers').dataset.state = !b.online ? 'pending' : (hasServers ? 'done' : 'current');
  $('#servers-status').textContent = !b.online ? '' : (hasServers ? `${servers.length} detected \u2713` : 'None yet');
  $('#btn-config').disabled = !b.online;
  $('#step-ready').dataset.state = hasServers ? 'current' : 'pending';
}

async function refresh() {
  const state = await send('GET_STATE');
  if (state?.ok === false) return;
  await send('PROBE_BRIDGE'); // also refreshes the launcher status
  latest = await send('GET_STATE');
  render(latest);
}

async function run(type, okText) {
  if (busy) return;
  busy = true;
  showMessage('One moment\u2026');
  if (latest) render(latest);
  const res = await send(type);
  busy = false;
  showMessage(res.ok ? okText : (res.error ?? 'Could not complete the action.'));
  await refresh();
}

$('#btn-start').addEventListener('click', () => run('START_BRIDGE', 'Bridge started.'));
$('#btn-restart').addEventListener('click', () => run('RESTART_BRIDGE', 'Bridge restarted.'));
$('#btn-stop').addEventListener('click', () => run('STOP_BRIDGE', 'Bridge stopped.'));
$('#btn-config').addEventListener('click', async () => {
  const res = await send('OPEN_CONFIG');
  showMessage(res.ok ? 'Opening servers.json\u2026 save the file and the bridge will reload it automatically.' : (res.error ?? 'Could not open the file.'));
});
$('#copy-cmd').addEventListener('click', async (event) => {
  try { await navigator.clipboard.writeText($('#cmd-text').textContent); event.currentTarget.textContent = 'Copied \u2713'; }
  catch { event.currentTarget.textContent = 'Select it and copy manually'; }
});

refresh();
setInterval(refresh, 1500);