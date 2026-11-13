/**
 * deepseek.js — Adapter for DeepSeek (chat.deepseek.com).
 *
 * Specifics of the DeepSeek interface:
 *   - The text box is a normal <textarea id="chat-input"> (React): `dom.setText` already handles it.
 *   - The send button does NOT have an aria-label or stable class: it is an icon (`ds-icon-button`) at the end of the bar.
 *     While generating, THAT SAME button becomes "stop": that is why here it is sent with Enter and the button is only
 *     clicked if it is known that it is not generating (otherwise, a click would CANCEL the response).
 *   - Responses are rendered in `.ds-markdown`. With "DeepThink" the reasoning also uses Markdown and sometimes
 *     contains a draft of the `mcp_call`: it is excluded so as not to execute it twice.
 *   - There is no stable ID per message.
 *
 * Anti-loop (the same result was being sent over and over again):
 *   1. Call ID by CONTENT (conversation + how many previous messages bring the same call), not by the
 *      message position: if DeepSeek repaints or changes the number of `.ds-markdown` blocks, the call is not "renewed".
 *   2. Lock: after executing a call, another IDENTICAL one is ignored until the result is sent and the AI responds
 *      again.
 *   3. Safe sending: "send" is not clicked if there is a generation in progress, nor if the box is already empty (already left).
 *
 * If DeepSeek changes its interface, you usually only need to add a selector to the corresponding list.
 */
(() => {
  'use strict';
  const WMB = globalThis.WMB;

  /** "Reasoning" blocks (DeepThink): their text does not count as a response. */
  const THINK_SEL = '.ds-think-content, [class*="think" i], [class*="reasoning" i]';
  /** Short header that precedes the reasoning ("Thought for 5 seconds", "Pensó durante 5 segundos"…). */
  const THINK_HEADER = /^(thought|thinking|deepthink|pens[óo]|pensando|razon|reasoning)/i;
  /** Icon buttons (send, attach, stop) and, alternatively, any ARIA button. */
  const ICON_BUTTONS = ['div[role="button"].ds-icon-button', 'button.ds-icon-button', '.ds-icon-button'];
  const ANY_BUTTONS = ['div[role="button"]', 'button'];

  const GROW_MS = 2000;          // the last message grew less than this time ago → it is generating
  const FRESH_CHAT_MS = 120_000; // a new chat receives its URL shortly after the first send
  const LOCK_SENT_MS = 90_000;   // lock: after sending the result, maximum this time
  const LOCK_MAX_MS = 240_000;   // …and if the result is never sent, maximum this other time

  const convId = () => (location.pathname.match(/\/s\/([^/?#]+)/) || [])[1] || null;
  const hashOf = (call) => WMB.hash(JSON.stringify(call) ?? '');

  /** Is it a reasoning block (not the response)? */
  function isThinking(el) {
    if (el.closest(THINK_SEL) || el.querySelector(THINK_SEL)) return true;
    for (let node = el, depth = 0; node && depth < 3; node = node.parentElement, depth += 1) {
      const head = (node.previousElementSibling?.textContent || '').trim();
      if (head && head.length < 45 && THINK_HEADER.test(head)) return true;
    }
    return false;
  }

  class DeepSeekAdapter extends WMB.BaseAdapter {
    #conv = convId();                            // current conversation (null = new chat without URL)
    #tag = this.#conv ?? `h${Date.now()}`;       // conversation tag for the IDs
    #hashCache = new WeakMap();                  // element → {text, set} (hashes of its calls)
    #lock = null;                                // { hash, firedAt, sentAt, newGen }
    #grow = { el: null, len: 0, at: 0 };         // tracking the growth of the last message

    constructor() {
      super({
        id: 'deepseek',
        name: 'DeepSeek',
        selectors: {
          composer: [
            'textarea#chat-input',
            'textarea[placeholder*="DeepSeek" i]',
            'textarea[placeholder*="Message" i]',
            'textarea[placeholder*="Mensaje" i]',
            'div[role="textbox"][contenteditable="true"]',
            'textarea',
          ],
          sendButton: [
            // Candidates with explicit label; the real search is done by getSendButton().
            'div[role="button"][aria-label*="Send" i]',
            'button[aria-label*="Send" i]',
            'div[role="button"][aria-label*="Enviar" i]',
            'button[aria-label*="Enviar" i]',
          ],
          assistantMessages: ['.ds-markdown'],
          stopButton: [
            'div[role="button"][aria-label*="Stop" i]',
            'button[aria-label*="Stop" i]',
            'div[role="button"][aria-label*="Detener" i]',
            'button[aria-label*="Detener" i]',
            'div[role="button"][aria-label*="Parar" i]',
            'button[aria-label*="Parar" i]',
          ],
          fileInput: ['input[type="file"]'],
        },
      });
    }

    matches(hostname) {
      return hostname === 'deepseek.com' || hostname.endsWith('.deepseek.com');
    }

    // ───────────── Conversation ─────────────

    /** Stable tag for the conversation. A new chat that receives its URL (/ → /a/chat/s/<id>) keeps its tag. */
    #syncConversation() {
      const id = convId();
      if (id === this.#conv) return;
      const freshChatGotUrl = this.#conv === null && id !== null && Date.now() - this.lastActivity < FRESH_CHAT_MS;
      this.#conv = id;
      if (!freshChatGotUrl) this.#tag = id ?? `h${Date.now()}`;
    }

    // ───────────── Assistant messages (without reasoning) ─────────────

    getAssistantMessages() {
      this.#syncConversation();
      const found = super.getAssistantMessages();
      const answers = found.filter((el) => !isThinking(el));
      // If the filter removed everything, it is better not to filter than to be blind.
      const list = answers.length || !found.length ? answers : found;
      // Without nested containers (avoids duplicates with broad selectors).
      return list.filter((el) => !list.some((other) => other !== el && el.contains(other)));
    }

    /** Hashes of the MCP calls of a message (cached by text). */
    #callHashes(el) {
      const text = el.textContent || '';
      const hit = this.#hashCache.get(el);
      if (hit && hit.text === text) return hit.set;
      const set = new Set(WMB.extractMcpCalls(text).map(hashOf));
      this.#hashCache.set(el, { text, set });
      return set;
    }

    /**
     * Key by CONTENT: conversation + number of previous messages that bring the same call.
     * Does not depend on the message position, so page repaints do not "renew" an already executed call.
     */
    getMessageKey(element, index) {
      const mine = this.#callHashes(element);
      if (!mine.size) return super.getMessageKey(element, index);
      this.#syncConversation();
      let before = 0;
      for (const other of this.getAssistantMessages()) {
        if (other === element) break;
        for (const hash of this.#callHashes(other)) if (mine.has(hash)) { before += 1; break; }
      }
      return `${this.#tag}|${before}`;
    }

    // ───────────── Generation in progress ─────────────

    /**
     * Is the AI generating? "Stop" button (if it has a label) or the last message grew moments ago.
     * The button icon is not looked at: if it fails, it would pass off an old conversation as "live".
     */
    isStreaming() {
      let streaming = WMB.exists(this.selectors.stopButton);
      if (!streaming) {
        const messages = this.getAssistantMessages();
        const last = messages[messages.length - 1] ?? null;
        const len = last ? (last.textContent || '').length : 0;
        const now = Date.now();
        if (last && last === this.#grow.el && len > this.#grow.len) this.#grow.at = now; // grew the SAME message
        this.#grow.el = last;
        this.#grow.len = len;
        streaming = now - this.#grow.at < GROW_MS;
      }
      if (streaming && this.#lock?.sentAt) this.#lock.newGen = true; // the AI responded again after sending the result
      return streaming;
    }

    // ───────────── Anti-duplicate lock ─────────────

    #locked(hash) {
      const lock = this.#lock;
      if (!lock || lock.hash !== hash) return false;
      const now = Date.now();
      const expired = lock.sentAt ? (lock.newGen || now - lock.sentAt > LOCK_SENT_MS) : now - lock.firedAt > LOCK_MAX_MS;
      if (expired) { this.#lock = null; return false; }
      return true;
    }

    observeResponses(callback, options) {
      return super.observeResponses((detected) => {
        if (detected.malformed || !detected.call) { callback(detected); return; } // unreadable block warning: it has no call to block
        const hash = hashOf(detected.call);
        if (this.#locked(hash) && detected.id === this.#lock?.id) { this.debug?.('ok', 'DeepSeek · identical call already in progress: ignored'); return; }
        this.#lock = { hash, id: detected.id, firedAt: Date.now(), sentAt: 0, newGen: false };
        callback(detected);
      }, options);
    }

    async sendToolResult(text, options) {
      try {
        return await super.sendToolResult(text, options);
      } finally {
        if (this.#lock && !this.#lock.sentAt) this.#lock.sentAt = Date.now();
      }
    }

    // ───────────── Send ─────────────

    /** Icon button (without text) furthest to the right of the text box bar. */
    #composerButtons() {
      const composer = this.getComposer();
      if (!composer) return [];
      let node = composer.parentElement;
      for (let depth = 0; node && depth < 7; depth += 1, node = node.parentElement) {
        for (const group of [ICON_BUTTONS, ANY_BUTTONS]) {
          const buttons = [];
          for (const selector of group) {
            try { node.querySelectorAll(selector).forEach((b) => { if (!buttons.includes(b)) buttons.push(b); }); } catch { /* noop */ }
          }
          const icons = buttons
            .filter((b) => !b.closest('.ds-toggle-button') && !(b.textContent || '').trim() && b.querySelector('svg, img, i'))
            .sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
          if (icons.length) return icons;
        }
      }
      return [];
    }

    getSendButton() {
      const labelled = WMB.firstVisible(this.selectors.sendButton, document, { loose: true });
      if (labelled) return labelled;
      const buttons = this.#composerButtons();
      return buttons.length ? buttons[buttons.length - 1] : null;
    }

    /**
     * Sends with Enter (during a generation it does nothing, so it is safe) and only if it doesn't leave, clicks the button,
     * which during a generation is "stop". If the box is already empty it does nothing (already sent).
     */
    async submit(timeout = 4000) {
      const composer = this.getComposer();
      if (!composer) return false;
      const hasText = () => WMB.dom.getText(composer).trim().length > 0;
      if (!hasText()) return true;

      if (this.isStreaming()) {
        const idle = await WMB.waitFor(() => !this.isStreaming(), { timeout, interval: 200 });
        if (!idle) return false;
      }
      const gone = () => !hasText() || this.isStreaming();

      composer.focus();
      const init = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
      composer.dispatchEvent(new KeyboardEvent('keydown', init));
      composer.dispatchEvent(new KeyboardEvent('keypress', init));
      composer.dispatchEvent(new KeyboardEvent('keyup', init));
      if (await WMB.waitFor(gone, { timeout: 1500, interval: 150 })) return true;

      const button = await WMB.waitFor(() => {
        const b = this.getSendButton();
        return b && !b.disabled && b.getAttribute('aria-disabled') !== 'true' ? b : null;
      }, { timeout, interval: 150 });
      if (button && hasText() && !this.isStreaming()) { button.click(); return true; }
      return !hasText();
    }
  }

  WMB.registerAdapter(new DeepSeekAdapter());
})();