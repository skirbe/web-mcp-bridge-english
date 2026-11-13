/**
 * base_adapter.js — Base class for the Adapter pattern.
 *
 * Each platform (ChatGPT, Gemini, Claude) inherits from `BaseAdapter` and ONLY declares:
 *   - `matches(hostname)`
 *   - the DOM selectors (multiple candidates per element, in priority order)
 *   - optionally `getMessageKey()` if the website exposes a stable ID per message.
 *
 * Interface implemented by each adapter (inherited from this class):
 *   - injectSystemPrompt(activeToolsList)  → writes the instructions into the chat.
 *   - observeResponses(callback)           → detects `mcp_call` calls in the responses.
 *   - attachFiles(files)                   → attaches images/files to the text box.
 *   - sendToolResult(text)                 → writes the result and simulates sending.
 */
(() => {
  'use strict';
  const WMB = globalThis.WMB;

  const BASELINE_MS = 2500;     // window after loading/navigating in which old calls are only "memorized"
  const DEBOUNCE_MS = 800;      // the message must remain stable for this time before analyzing it
  const POLL_MS = 1000;         // heartbeat: safety net in case the MutationObserver misses a change
  const WAKE_MS = 30_000;       // hidden tab waiting for a response with no DOM changes → "wakes" for a moment
  const STUCK_MS = 2500;        // stable text with the "generating" indicator stuck → considered finished
  const FRESH_CHAT_MS = 120_000;
  const STORE_KEY = 'wmb:executed';
  const STORE_LIMIT = 500;

  class BaseAdapter {
    /**
     * @param {{id:string,name:string,selectors:{composer:string[],sendButton:string[],assistantMessages:string[],stopButton:string[],fileInput?:string[]}}} config
     */
    constructor({ id, name, selectors }) {
      this.id = id;
      this.name = name;
      this.selectors = selectors;
      this.executed = this.#loadExecuted();
      this.deliveries = 0;            // results delivered to the AI (to distinguish real repetitions from repaints)
      this.lastDeliveryAt = 0;
      this.genSinceDelivery = false;  // the AI already responded after the last delivered result
      this.msgsAtDelivery = 0;
      this.baselineUntil = 0;
      this.lastActivity = 0;
      this.freshChat = false;
      this.awaitingSince = 0;   // moment something was sent and a new response is expected
      this.options = { focusFallback: true };
      this.rescan = () => {};
    }

    /** Settings coming from the extension (e.g., `focusFallback`). */
    configure(options) { Object.assign(this.options, options); }

    /** @param {string} hostname */
    matches(_hostname) { return false; }

    // ───────────── DOM Access ─────────────

    getComposer() { return WMB.firstVisible(this.selectors.composer, document, { loose: true }); }
    getSendButton() { return WMB.firstVisible(this.selectors.sendButton, document, { loose: true }); }
    getAssistantMessages() { return WMB.allMatches(this.selectors.assistantMessages); }
    isStreaming() { return WMB.exists(this.selectors.stopButton); }

    /** Stable key for a message; used to avoid repeating calls. */
    getMessageKey(element, index) {
      const holder = element.closest('[data-message-id], [data-turn-id]') ?? element;
      return holder.getAttribute('data-message-id') || holder.getAttribute('data-turn-id') || `${location.pathname}:${index}`;
    }

    /** The user just sent a message (called by core_bridge with real events). */
    markActivity() {
      this.lastActivity = Date.now();
      this.awaitingSince = this.lastActivity;
      this.freshChat = this.getAssistantMessages().length === 0; // first message of a new chat
    }

    // ───────────── Public Interface ─────────────

    /**
     * Writes the instructions with the tools of the enabled MCPs into the chat.
     * Does not send them: the user can add their request and send it all together.
     * @returns {Promise<{ok:boolean,error?:string}>}
     */
    async injectSystemPrompt(activeToolsList) {
      const composer = await WMB.waitFor(() => this.getComposer(), { timeout: 4000 });
      if (!composer) return { ok: false, error: 'Could not find the chat text box.' };
      const ok = await WMB.dom.setText(composer, WMB.buildSystemPrompt(activeToolsList), { append: true });
      return ok ? { ok: true } : { ok: false, error: 'Could not write to the text box.' };
    }

    /**
     * Observes the DOM and calls `callback({id, call, element})` when the assistant
     * finishes writing a message that contains a NEW MCP call.
     * `onDone({text, element})` is called once for each finished response WITHOUT an MCP call.
     * All timers use `WMB.sleep`: they keep working with the tab hidden or the window covered.
     * @returns {() => void} function to stop observing
     */
    observeResponses(callback, { onDone } = {}) {
      let alive = true;
      let scheduled = false;
      let lastTick = 0;
      let lastSig = '';
      let lastText = '';
      let lastDone = '';
      let stableSince = Date.now();
      this.baselineUntil = Date.now() + BASELINE_MS;

      // At most one analysis per `delay` ms while there are changes (without accumulating timers).
      const schedule = (delay = DEBOUNCE_MS) => {
        if (scheduled) return;
        scheduled = true;
        WMB.sleep(delay).then(() => { scheduled = false; if (alive) scan(); });
      };

      const scan = () => {
        const now = Date.now();
        const streaming = this.isStreaming();
        const messages = this.getAssistantMessages();
        if (this.lastDeliveryAt && (streaming || messages.length > this.msgsAtDelivery)) this.genSinceDelivery = true;
        if (streaming) {
          this.lastActivity = now;
          this.baselineUntil = 0;                              // live generation: the conversation is not "old"
          if (messages.length <= 1) this.freshChat = true;     // first response of a new chat
        } else if (messages.length > 2) this.freshChat = false;
        if (!messages.length) return;

        let last = -1;
        for (let i = messages.length - 1; i >= 0 && last < 0; i -= 1) if ((messages[i].textContent || '').trim()) last = i;
        const text = last >= 0 ? messages[last].textContent : '';
        if (text !== lastText) { lastText = text; stableSince = now; this.awaitingSince = 0; } // new content arrived

        // With "generating" active, it waits, unless the text has been stable for a while (stuck indicator).
        if (streaming && now - stableSince < STUCK_MS) { schedule(1000); return; }

        const baseline = now < this.baselineUntil;
        const sig = `${location.pathname}|${messages.length}|${last}|${text.length}`;
        if (!baseline && sig === lastSig) return;
        lastSig = sig;

        // Baseline: memorize everything old. Normal operation: only the last message with text.
        const indexes = baseline ? messages.map((_, i) => i) : (last >= 0 ? [last] : []);
        for (const i of indexes) {
          const element = messages[i];
          const calls = WMB.extractMcpCalls(i === last ? text : element.textContent || '');
          calls.forEach((call, n) => {
            let id = `${this.getMessageKey(element, i)}#${n}:${WMB.hash(JSON.stringify(call))}`;
            if (this.executed.has(id)) {
              // Same call already executed. It is only a real REPETITION (the AI expects a response again) if it responded after
              // receiving the result and this is its last response; otherwise, it is a page repaint and is ignored.
              if (baseline || i !== last || streaming || n !== 0 || !this.genSinceDelivery) return;
              id = `${id}~r${this.deliveries}`;
              if (this.executed.has(id)) return;
            }
            this.#remember(id);
            // Protocol: one call per message → only the first one is executed.
            if (!baseline && n === 0) callback({ id, call, element, extra: calls.length - 1 });
          });
          if (!baseline && i === last && !calls.length && !streaming && WMB.looksMalformed?.(text)) {
            // There is an intention to call MCP but the block could not be read: the AI is notified (previously it was left waiting).
            const badId = `${this.getMessageKey(element, i)}#bad:${WMB.hash(text)}`;
            if (!this.executed.has(badId)) { this.#remember(badId); callback({ id: badId, malformed: true, text, element }); }
          }
          if (!baseline && i === last && !calls.length && !streaming && onDone) {
            const doneKey = `${this.getMessageKey(element, i)}:${text.length}`;
            if (doneKey !== lastDone) { lastDone = doneKey; onDone({ text, element }); }
          }
        }
      };
      this.rescan = () => { lastSig = ''; lastDone = ''; scan(); };

      const observer = new MutationObserver(() => {
        const now = Date.now();
        if (now - lastTick > 300) {
          lastTick = now;
          if (this.isStreaming()) { this.lastActivity = now; this.baselineUntil = 0; }
        }
        schedule();
      });
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });

      // Upon returning to the tab / regaining focus: immediate analysis (in case something happened while it was hidden).
      const wake = () => { if (!document.hidden) this.rescan(); };
      document.addEventListener('visibilitychange', wake);
      window.addEventListener('focus', wake);

      // Heartbeat every second (replaces setInterval, which freezes in the background): SPA navigation, analysis, and "wake".
      let href = location.href;
      (async () => {
        while (alive) {
          const idle = !this.awaitingSince && Date.now() - this.lastActivity > 60_000; // no activity: more spaced heartbeat
          await WMB.sleep(idle ? POLL_MS * 3 : POLL_MS);
          if (!WMB.extensionAlive()) alive = false; // the extension reloaded: this script is orphaned and stops
          if (!alive) break;
          if (location.href !== href) {
            href = location.href;
            // A NEW chat receives its URL (/c/<id>) when there is already a response: it is not another conversation and does NOT need to be memorized.
            if (this.freshChat && Date.now() - this.lastActivity < FRESH_CHAT_MS) this.freshChat = false;
            else this.baselineUntil = Date.now() + BASELINE_MS;
          }
          scan();
          await this.#wakeIfStale();
        }
      })();

      return () => {
        alive = false;
        observer.disconnect();
        document.removeEventListener('visibilitychange', wake);
        window.removeEventListener('focus', wake);
      };
    }

    /**
     * HIDDEN tab waiting for a response and has been without any change or "generating" indicator for 30 s:
     * some sites do not paint in the background. The tab is brought to the front for a moment and then returned to the previous one.
     */
    async #wakeIfStale() {
      if (!this.awaitingSince || !this.options.focusFallback || !document.hidden || this.isStreaming()) return;
      if (Date.now() - this.awaitingSince < WAKE_MS || this.wokeFor === this.awaitingSince) return;
      this.wokeFor = this.awaitingSince;
      const token = await WMB.bg({ type: 'FOCUS_TAB' });
      await WMB.sleep(1500);
      this.rescan();
      if (token?.prev) WMB.bg({ type: 'RESTORE_FOCUS', prev: token.prev });
    }

    /**
     * Attaches files (images, audio, long text…) to the chat's text box.
     * Tries, in order: paste → drop (drag & drop) → <input type="file">.
     * @param {{name:string,mime:string,b64?:string,text?:string}[]} files
     * @returns {Promise<boolean>} true if the attachment appeared in the interface
     */
    async attachFiles(files) {
      const composer = await WMB.waitFor(() => this.getComposer(), { timeout: 5000 });
      if (!composer) return false;
      let list;
      try { list = files.map(WMB.dom.fileFrom); } catch { return false; }

      const root = composer.closest('form, fieldset') ?? composer.parentElement?.parentElement?.parentElement ?? composer;
      const before = root.getElementsByTagName('*').length;
      const grew = async () => {
        for (let i = 0; i < 10; i += 1) {
          await WMB.sleep(300);
          if (root.getElementsByTagName('*').length - before >= 3) return true; // the attachment thumbnail/chip appeared
        }
        return false;
      };
      const transfer = () => {
        const dt = new DataTransfer();
        list.forEach((file) => dt.items.add(file));
        return dt;
      };

      this.lastActivity = Date.now();
      composer.focus();
      try {
        composer.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer(), bubbles: true, cancelable: true }));
        if (await grew()) return true;
      } catch { /* next method */ }
      try {
        const dataTransfer = transfer();
        for (const type of ['dragenter', 'dragover', 'drop']) {
          composer.dispatchEvent(new DragEvent(type, { dataTransfer, bubbles: true, cancelable: true }));
        }
        if (await grew()) return true;
      } catch { /* next method */ }
      try {
        const inputs = Array.from(document.querySelectorAll(this.selectors.fileInput?.join(',') || 'input[type="file"]'));
        const input = inputs.find((el) => !el.webkitdirectory && (!el.accept || /image|\*/.test(el.accept))) ?? inputs[0];
        if (input) {
          input.files = transfer().files;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          if (await grew()) return true;
        }
      } catch { /* no more methods */ }
      return false;
    }

    /**
     * Writes the tool's result into the chat and (optionally) sends it, CHECKING that the chat accepted it:
     * retries the send and, if the tab is hidden and it still doesn't leave, brings it to the front for a moment.
     * @param {string} text already formatted message
     * @param {{autoSend?:boolean, settleMs?:number}} options `settleMs`: wait for an attachment to finish uploading
     */
    async sendToolResult(text, { autoSend = true, settleMs = 0 } = {}) {
      const composer = await WMB.waitFor(() => this.getComposer(), { timeout: 5000 });
      if (!composer) return { ok: false, error: 'Could not find the chat text box.' };
      this.lastActivity = Date.now();
      this.deliveries += 1;
      this.lastDeliveryAt = Date.now();
      this.genSinceDelivery = false;
      this.msgsAtDelivery = this.getAssistantMessages().length;
      if (!(await WMB.dom.setText(composer, text, { append: true }))) {
        return { ok: false, error: 'Could not write to the text box.' };
      }
      if (!autoSend) return { ok: true };
      if (settleMs) await WMB.sleep(settleMs);

      const attempt = async (timeout) => (await this.submit(timeout)) && (await this.#confirmSent());
      let sent = await attempt(settleMs ? 30_000 : 4000);
      if (!sent) sent = await attempt(4000); // second attempt (button / Enter)
      if (!sent && this.options.focusFallback && WMB.isBackground()) {
        const token = await WMB.bg({ type: 'FOCUS_TAB' });
        await WMB.sleep(800);
        sent = await attempt(4000);
        if (token?.prev) WMB.bg({ type: 'RESTORE_FOCUS', prev: token.prev });
      }
      if (sent) this.awaitingSince = Date.now();
      return sent ? { ok: true } : { ok: false, error: 'Could not confirm sending to the chat. Press Enter in the chat.' };
    }

    /** The chat accepted the message: the text box was emptied or it is already generating the response. */
    async #confirmSent() {
      return Boolean(await WMB.waitFor(() => {
        if (this.isStreaming()) return true;
        const composer = this.getComposer();
        return composer ? WMB.dom.getText(composer).trim().length < 10 : false;
      }, { timeout: 8000, interval: 250 }));
    }

    /** Clicks the send button (when enabled) or simulates Enter. */
    async submit(timeout = 4000) {
      const button = await WMB.waitFor(() => {
        const b = this.getSendButton();
        return b && !b.disabled && b.getAttribute('aria-disabled') !== 'true' ? b : null;
      }, { timeout, interval: 120 });
      if (button) { button.click(); return true; }

      const composer = this.getComposer();
      if (!composer) return false;
      const init = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
      composer.dispatchEvent(new KeyboardEvent('keydown', init));
      composer.dispatchEvent(new KeyboardEvent('keyup', init));
      return true;
    }

    // ───────────── Registry of executed IDs (persists in the tab) ─────────────

    #loadExecuted() {
      try { return new Set(JSON.parse(sessionStorage.getItem(STORE_KEY) || '[]')); } catch { return new Set(); }
    }

    #remember(id) {
      this.executed.add(id);
      try {
        sessionStorage.setItem(STORE_KEY, JSON.stringify(Array.from(this.executed).slice(-STORE_LIMIT)));
      } catch { /* storage unavailable */ }
    }
  }

  WMB.BaseAdapter = BaseAdapter;
  WMB.adapters = [];
  WMB.registerAdapter = (adapter) => { WMB.adapters.push(adapter); };
  WMB.findAdapter = (hostname) => WMB.adapters.find((a) => a.matches(hostname)) ?? null;
})();