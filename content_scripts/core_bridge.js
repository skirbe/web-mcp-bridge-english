/**
 * core_bridge.js — Main controller in each chat tab.
 *
 * Flow:
 *   1. Detects the platform (adapter) and asks the background for active MCPs.
 *   2. Shows the floating widget to inject instructions and choose the permission for each MCP.
 *   3. Observes AI responses; upon detecting a new `mcp_call`:
 *        MCP permission (allow / ask / deny) → execute via background → deliver the COMPLETE result to the chat
 *        (inline text; images, audio, and long texts as attachments) → verify that the chat accepted it.
 *   4. Keeps the AI informed: a reminder line in each message and periodic resending of instructions.
 *
 * Robustness with the tab in the background: no step relies on the page's setTimeout/setInterval
 * (WMB.sleep is used, which counts the service worker), there is a heartbeat that refreshes the state, and a watchdog that
 * prevents a stuck call from blocking the queue.
 */
(() => {
  'use strict';
  const WMB = globalThis.WMB;
  if (!WMB || WMB.started) return;
  const adapter = WMB.findAdapter(location.hostname);
  if (!adapter) return;
  WMB.started = true;

  const INJECT_KEY = 'wmb:injected-signature';
  const TURNS_KEY = 'wmb:turns-since-full';
  const HEARTBEAT_MS = 10_000;
  const TOOL_TIMEOUT_MS = 150_000;
  const DELIVER_TIMEOUT_MS = 120_000;
  // The AI says it doesn't have access to anything local: a sign that it lost the context of the instructions.
  const DENIAL = /no tengo acceso|no puedo acceder|no tengo (la )?capacidad de (acceder|ejecutar|controlar)|no puedo (ejecutar|controlar|ver tu|abrir)|no dispongo de (acceso|herramientas)|no tengo herramientas|i (don'?t|do not) have (access|tools)|i (can'?t|cannot|am unable to) (access|control|run|execute|see your)/i;

  const slugKey = (value) => String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const guarded = (promise, ms, message) => Promise.race([promise, WMB.sleep(ms).then(() => { throw new Error(message); })]);

  const state = { servers: [], tools: [], settings: { autoSend: true, maxResultChars: 12000 }, forceFull: false };
  let queue = Promise.resolve();
  let lastRefreshError = '';

  // Best-effort: an open Web Lock reduces the chance of the browser "freezing" the tab in the background.
  try { navigator.locks?.request('wmb-alive', () => new Promise(() => {})).catch(() => {}); } catch { /* noop */ }

  /** Safe messaging: if the extension reloads, the context becomes invalidated. */
  async function send(message) {
    try {
      return await chrome.runtime.sendMessage(message);
    } catch (err) {
      return { ok: false, error: /context invalidated/i.test(err.message) ? 'The extension was updated: reload the tab.' : err.message };
    }
  }

  const widget = new WMB.Widget({
    onInject: () => injectInstructions(),
    onRefresh: () => { adapter.rescan(); return refresh(true); },
    onToggleBridge: async (value) => {
      await send({ type: 'UPDATE_SETTINGS', settings: { bridgeEnabled: value } });
      await refresh();
    },
    /** `id` = one MCP; `null` = all MCPs at once. */
    onSetPermission: async (id, permission) => {
      await send(id ? { type: 'SET_PERMISSION', id, permission } : { type: 'SET_ALL_PERMISSIONS', permission });
      await refresh();
    },
  });

  // Adapters can write debug messages to the floating panel (e.g., ChatGPT).
  adapter.debug = (kind, message) => widget.log(kind, message);

  function injectionStatus() {
    if (document.body.textContent.includes(`[WMB:${WMB.toolsSignature(state.tools)}]`)) return 'ok';
    return sessionStorage.getItem(INJECT_KEY) ? 'stale' : 'none';
  }

  async function refresh(announce = false) {
    const [snapshot, active] = await Promise.all([send({ type: 'GET_STATE' }), send({ type: 'GET_ACTIVE_TOOLS' })]);
    if (!snapshot?.ok || !active?.ok) {
      const error = snapshot?.error || active?.error || 'Could not contact the extension.';
      if (error !== lastRefreshError) widget.log('err', error); // the heartbeat does not repeat the same error
      lastRefreshError = error;
      return;
    }
    lastRefreshError = '';
    state.settings = snapshot.settings;
    state.servers = snapshot.servers.filter((s) => s.enabled && s.url);
    state.tools = active.tools;
    WMB.tools = state.tools; // the tolerant parser uses the schemas
    adapter.configure({ focusFallback: state.settings.focusFallback !== false });
    widget.update({
      adapterName: adapter.name,
      servers: state.servers,
      toolCount: state.tools.length,
      bridgeEnabled: state.settings.bridgeEnabled,
      injection: injectionStatus(),
    });
    if (announce) widget.log('ok', `Updated: ${state.tools.length} active tools.`);
  }

  const resetTurns = () => sessionStorage.setItem(TURNS_KEY, '0');

  async function injectInstructions() {
    await refresh();
    if (!state.settings.bridgeEnabled) {
      widget.log('err', 'The bridge is disabled. Enable it first.');
      return;
    }
    if (!state.tools.length) {
      widget.log('err', 'No tools available: add an MCP in the popup, make sure it is connected and not blocked.');
      return;
    }
    const result = await adapter.injectSystemPrompt(state.tools);
    if (result.ok) {
      sessionStorage.setItem(INJECT_KEY, WMB.toolsSignature(state.tools));
      resetTurns();
      state.forceFull = false;
      widget.update({ injection: 'ok' });
      widget.log('ok', 'Instructions written to the chat. Add your request and send.');
    } else {
      widget.log('err', result.error);
    }
  }

  /**
   * Delivers the result to the chat WITHOUT omitting anything: the text goes inline and images/audio/blobs
   * (and very long texts) as attachments. If the chat does not support the attachment, it is downloaded.
   * Ends with a reminder line so the AI doesn't forget its tools and continues the task.
   */
  async function deliver(srv, call, { status, text, raw, note }) {
    const { autoSend, maxResultChars, reminder } = state.settings;
    const plan = WMB.planResult(raw ?? { content: [{ type: 'text', text }] }, { server: srv.slug, name: call.name, status, maxChars: maxResultChars });

    let attached = true;
    if (plan.files.length) {
      widget.log('ok', `Attaching ${plan.files.length} file(s) to the chat…`);
      attached = await adapter.attachFiles(plan.files);
      if (!attached) {
        for (const file of plan.files.filter((f) => !f.overflow)) {
          try { WMB.dom.download(WMB.dom.fileFrom(file)); } catch { /* noop */ }
        }
        widget.log('err', 'Could not attach to the chat: the file was downloaded (drag it into the chat).');
      }
    }
    const tail = reminder !== false && state.tools.length ? `\n${WMB.reminderLine(state.tools, 'result')}` : '';
    const sent = await adapter.sendToolResult(`${plan.build(attached)}${note ? `\n${note}` : ''}${tail}`, { autoSend, settleMs: attached && plan.files.length ? 1500 : 0 });
    widget.log(sent.ok ? 'ok' : 'err', sent.ok ? `Result sent to ${adapter.name}.` : sent.error);
  }

  /** Finds the MCP and the tool for a call; if the local state might be old, refreshes it once. */
  async function resolveCall(call) {
    const find = () => {
      const wanted = slugKey(call.server);
      const srv = call.server
        ? state.servers.find((s) => s.slug === call.server || slugKey(s.slug) === wanted || slugKey(s.name) === wanted)
        : (state.servers.length === 1 ? state.servers[0] : null);
      return { srv, tool: srv ? state.tools.find((t) => t.name === call.name && t.server === srv.slug) : null };
    };
    let found = find();
    if (!found.srv || (!found.tool && found.srv.permission !== 'deny')) {
      await refresh();
      found = find();
    }
    return found;
  }

  // ------------- Repeated calls: the AI asks for EXACTLY the same thing again -------------
  // They are never silently ignored: they are executed again (the data may have changed) and the AI is notified in the result.
  // If it repeats the same call too many times in a row, the last result is resent instead of executing it again.
  const REPEAT_WINDOW_MS = 15 * 60 * 1000;
  const MAX_REPEATS = 4;
  const recentCalls = new Map(); // call key -> { count, at, result }

  /** Processes an MCP call detected in the AI's response. */
  async function handleCall(detected) {
    if (detected.malformed) return handleMalformed(detected);
    badStreak = 0;
    const { call } = detected;
    if (!state.settings.bridgeEnabled) return; // bridge off: calls are ignored
    const { srv, tool } = await resolveCall(call);

    // Call that does not correspond to any active MCP (e.g., the AI explaining the format): ignored.
    if (!srv) {
      widget.log('err', `Call ignored: server «${call.server ?? '?'}» not active.`);
      return;
    }

    const repeatKey = WMB.hash(JSON.stringify([srv.slug, call.name, call.arguments ?? {}]) ?? '');
    const prev = recentCalls.get(repeatKey);
    const repeats = prev && Date.now() - prev.at < REPEAT_WINDOW_MS ? prev.count : 0;
    if (repeats >= MAX_REPEATS && prev.result && tool && srv.permission !== 'deny') {
      const cached = { ...prev.result, note: `[WMB] IDENTICAL call repeated ${repeats + 1} times in a row: it was not executed again. This is the result of the last execution; use it. If it does not work for you, change the arguments or ask the user for something else.` };
      widget.log('err', `Identical call repeated ${repeats + 1} times: resending last result without executing.`);
      prev.count += 1;
      prev.at = Date.now();
      await guarded(deliver(srv, call, cached), DELIVER_TIMEOUT_MS, 'The chat did not accept the result in time.');
      return;
    }

    let result;
    if (srv.permission === 'deny') {
      result = { status: 'rejected', text: 'The user does not allow using this MCP.' };
      widget.log('err', `Blocked: ${srv.slug} › ${call.name}`);
    } else if (!tool) {
      const available = state.tools.filter((t) => t.server === srv.slug).map((t) => t.name).join(', ');
      result = { status: 'error', text: `The tool «${call.name}» does not exist in «${srv.slug}». Available: ${available || 'none'}.` };
    } else {
      let approved = true;
      if (srv.permission === 'ask') {
        const answer = await widget.requestApproval({ server: srv.slug, name: call.name, arguments: call.arguments });
        approved = Boolean(answer);
        if (answer === 'always') {
          await send({ type: 'SET_PERMISSION', id: srv.id, permission: 'allow' });
          await refresh();
        }
      } // 'allow': always executed, never asking

      if (!approved) {
        result = { status: 'rejected', text: 'The user rejected the execution of this tool.' };
        widget.log('err', `Rejected: ${srv.slug} › ${call.name}`);
      } else {
        widget.log('ok', `Executing ${srv.slug} › ${call.name}…`);
        let response;
        try {
          response = await callWithRetry(srv, call, 'The tool took too long to respond.');
        } catch (err) {
          response = { ok: false, error: err.message };
        }
        if (!response?.ok) result = { status: 'error', text: response?.error ?? 'Unknown error.' };
        else result = { status: response.result?.isError ? 'error' : 'ok', raw: response.result };
        widget.log(result.status === 'ok' ? 'ok' : 'err', `${call.name}: ${result.status}`);
      }
    }
    if (tool && srv.permission !== 'deny' && result.status !== 'rejected') {
      recentCalls.set(repeatKey, { count: repeats + 1, at: Date.now(), result });
      if (repeats > 0) result.note = `[WMB] This call is identical to the previous one (this is ${repeats + 1}). It was executed again and this is the CURRENT result; if you already have the data, do not repeat it.`;
    }
    if (detected.extra > 0) result.note = `[WMB] Only the first call was executed; ${detected.extra} more were ignored. Send ONE call per message and wait for the result.`;
    await guarded(deliver(srv, call, result), DELIVER_TIMEOUT_MS, 'The chat did not accept the result in time.');
  }

  // ------------- Invalid format and reconnection (v1.3.0) -------------

  let badStreak = 0;
  const MAX_BAD_STREAK = 3;
  const CONN_ERR = /no est.{1,2} conectado|desconectado|not connected|disconnected/i;

  /** The AI sent an unreadable mcp_call: the exact reason is returned so it can fix it (max 3 warnings in a row). */
  async function handleMalformed({ text }) {
    if (!state.settings.bridgeEnabled || !state.tools.length) return;
    badStreak += 1;
    if (badStreak > MAX_BAD_STREAK) {
      widget.log('err', 'The AI keeps using an invalid format: I will stop warning it. Check the chat.');
      return;
    }
    widget.log('err', `Unreadable call (${badStreak}/${MAX_BAD_STREAK}): warning the AI with the reason.`);
    const sent = await adapter.sendToolResult(WMB.formatCallError(text), { autoSend: state.settings.autoSend });
    if (!sent.ok) widget.log('err', sent.error);
  }

  async function waitConnected(srv, timeoutMs) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const snap = await send({ type: 'GET_STATE' });
      if (snap?.servers?.find((s) => s.id === srv.id)?.status === 'connected') return true;
      await WMB.sleep(2000);
    }
    return false;
  }

  /** Executes the tool; if the server was down BEFORE sending, it waits for reconnection and retries (without duplicating anything). */
  async function callWithRetry(srv, call, timeoutMessage) {
    let response;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      response = await guarded(send({ type: 'CALL_TOOL', server: srv.slug, name: call.name, arguments: call.arguments }), TOOL_TIMEOUT_MS, timeoutMessage);
      if (response?.ok || !CONN_ERR.test(response?.error ?? '') || attempt === 2) break;
      widget.log('err', `${srv.slug} disconnected: waiting for reconnection and retrying (${attempt + 1}/2).`);
      await send({ type: 'RECONNECT', id: srv.id });
      await waitConnected(srv, 40_000);
    }
    return response;
  }

  /** Never lets a failure or a stuck call block the following ones. */
  async function processCall(detected) {
    try {
      await handleCall(detected);
    } catch (err) {
      widget.log('err', `Error: ${err.message}`);
    }
  }

  // ───────────── Instructions, reminder, and periodic resending ─────────────

  let injecting = false;

  /** Are the instructions (with the current tools) already in this conversation? */
  const hasInstructions = () => document.body.textContent.includes(`[WMB:${WMB.toolsSignature(state.tools)}]`);

  /**
   * Intercepts the user's send (Enter or button) and appends, depending on the case:
   *   · the COMPLETE instructions (first message, every N messages, or if the AI said it doesn't have access);
   *   · or a reminder line (~45 tokens) so the AI doesn't forget it has local tools.
   * Only acts with real user events (isTrusted), never with those generated by the extension.
   */
  function interceptSend(event) {
    if (!event.isTrusted || injecting) return;
    adapter.markActivity();
    recentCalls.clear(); // new user message: the repeat count is reset
    const { bridgeEnabled, autoInject, reminder, reinjectEvery } = state.settings;
    if (!bridgeEnabled || !state.tools.length) return;

    const present = hasInstructions();
    const turns = Number(sessionStorage.getItem(TURNS_KEY) || 0) + 1;
    const full = autoInject && (!present || state.forceFull || (reinjectEvery > 0 && turns >= reinjectEvery));
    const remind = !full && present && reminder !== false;
    if (!full && !remind) { sessionStorage.setItem(TURNS_KEY, String(turns)); return; }

    const composer = adapter.getComposer();
    const userText = composer ? WMB.dom.getText(composer).trim() : '';
    if (!userText) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    injecting = true;
    (async () => {
      const message = full
        ? `${WMB.buildSystemPrompt(state.tools)}\n\n---\n## User Request\n${userText}`
        : `${userText}\n\n${WMB.reminderLine(state.tools)}`;
      if (await WMB.dom.setText(composer, message, { append: false })) {
        if (full) {
          sessionStorage.setItem(INJECT_KEY, WMB.toolsSignature(state.tools));
          resetTurns();
          state.forceFull = false;
          widget.update({ injection: 'ok' });
          widget.log('ok', present ? 'Instructions renewed in your message.' : 'Instructions added automatically to your message.');
        } else {
          sessionStorage.setItem(TURNS_KEY, String(turns));
        }
        await adapter.submit();
      } else {
        widget.log('err', 'Could not add instructions; use «Inject instructions».');
      }
    })().finally(() => { injecting = false; });
  }

  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
    const composer = adapter.getComposer();
    if (composer && (composer === e.target || composer.contains(e.target))) interceptSend(e);
  }, true);

  window.addEventListener('click', (e) => {
    const button = adapter.getSendButton();
    if (button && e.target instanceof Node && button.contains(e.target)) interceptSend(e);
  }, true);

  // Changes in active MCPs (connection, tools, permissions, settings…)
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'STATE_CHANGED') refresh();
  });

  // When returning to the tab or regaining focus: state up to date instantly.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  window.addEventListener('focus', () => refresh());

  // Heartbeat: the state never gets old or "stuck" even if the tab has been in the background for hours.
  (async () => {
    while (WMB.extensionAlive()) {
      await WMB.sleep(HEARTBEAT_MS);
      try { await refresh(); } catch { /* the next heartbeat will retry */ }
    }
  })();

  refresh().then(() => {
    adapter.observeResponses(
      (detected) => {
        // Processed in series to avoid mixing results.
        queue = queue.then(() => processCall(detected));
      },
      {
        onDone: ({ text }) => {
          if (state.settings.bridgeEnabled && state.tools.length && text.length < 1500 && DENIAL.test(text)) {
            state.forceFull = true;
            widget.log('err', 'The AI says it does not have access: I will renew the instructions on your next message.');
          }
        },
      },
    );
  });
})();