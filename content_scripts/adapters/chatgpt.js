/**
 * chatgpt.js — Adapter for ChatGPT (chatgpt.com).
 *
 * This adapter uses its OWN observer (not the base adapter's): the ChatGPT UI changes the container of
 * messages (code viewer) and the `mcp_call` can be in a code block, outside the message,
 * or in normal text. That is why it is located by its TEXT, not by message selectors.
 *
 *  - When ChatGPT responds with normal text, its Markdown eats the backslashes
 *    (`C:\\Users` → `C:\Users`) and the JSON stops being valid: it is repaired before parsing it.
 *  - Anti-repetition WITHOUT persistent memory: a call is executed only once while it remains visible on the
 *    page; when it disappears (another chat, regenerate…) it is forgotten. Nothing is saved between reloads, so it never
 *    blocks a new task with a "already executed".
 *  - History: if there has been no recent activity (your send or live generation), what is on the page is
 *    old and is never executed, no matter how long it takes to load.
 *
 * If OpenAI changes its interface, you usually only need to add a selector to the corresponding list.
 */
(() => {
  'use strict';
  const WMB = globalThis.WMB;

  const USER_SEL = '[data-message-author-role="user"], [data-turn="user"]';
  const CACHE_MS = 300;
  const STABLE_MS = 1200;     // the block must remain unchanged for this time
  const STUCK_MS = 2500;      // "generating" stuck: considered finished after this stable time
  const POLL_MS = 700;
  const ACTIVE_MS = 180_000;  // a call is only "new" if there was activity less than this time ago
  const FORGET_MS = 8000;     // an executed call is forgotten when it has been off the page for this time

  const BLOCK_TAGS = new Set(['P', 'DIV', 'LI', 'UL', 'OL', 'PRE', 'TR', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'SECTION', 'ARTICLE']);
  const SKIP_TAGS = new Set(['BUTTON', 'SVG', 'STYLE', 'SCRIPT', 'NOSCRIPT']);

  /** "Visible" text of a node with line breaks per block / code line. */
  function extractText(root) {
    let out = '';
    const newline = () => { if (out && !out.endsWith('\n')) out += '\n'; };
    const walk = (node) => {
      if (node.nodeType === Node.TEXT_NODE) { out += node.nodeValue; return; }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const tag = node.tagName.toUpperCase();
      if (SKIP_TAGS.has(tag)) return;
      if (tag === 'BR') { out += '\n'; return; }
      const isBlock = BLOCK_TAGS.has(tag) || node.classList.contains('cm-line');
      if (isBlock) newline();
      for (const child of node.childNodes) walk(child);
      if (isBlock) newline();
    };
    walk(root);
    return out;
  }

  /** Complete and valid JSON objects inside a text (ignores what surrounds the JSON). */
  function findJsonObjects(text) {
    const found = [];
    for (let i = 0; i < text.length; i += 1) {
      if (text[i] !== '{') continue;
      let depth = 0; let inString = false; let escaped = false;
      for (let j = i; j < text.length; j += 1) {
        const ch = text[j];
        if (inString) {
          if (escaped) escaped = false;
          else if (ch === '\\') escaped = true;
          else if (ch === '"') inString = false;
          continue;
        }
        if (ch === '"') inString = true;
        else if (ch === '{') depth += 1;
        else if (ch === '}') {
          depth -= 1;
          if (depth === 0) {
            try { found.push(JSON.parse(text.slice(i, j + 1))); i = j; } catch { /* was not valid JSON */ }
            break;
          }
        }
      }
    }
    return found;
  }

  /** Fixes backslashes that Markdown left loose inside JSON strings. */
  function fixString(raw) {
    // Windows path (C:\...): all backslashes are literal separators.
    if (/^[A-Za-z]:\\/.test(raw)) return raw.replace(/\\+/g, '\\\\');
    // Rest: duplicate only the backslashes that do not form a valid JSON escape.
    return raw.replace(/\\(["\\/bfnrt]|u[0-9a-fA-F]{4})|\\/g, (m, valid) => (valid ? m : '\\\\'));
  }

  function repairBackslashes(text) {
    let out = ''; let i = 0;
    while (i < text.length) {
      if (text[i] !== '"') { out += text[i]; i += 1; continue; }
      let j = i + 1; let raw = '';
      while (j < text.length && text[j] !== '"') {
        if (text[j] === '\\' && j + 1 < text.length) { raw += text[j] + text[j + 1]; j += 2; }
        else { raw += text[j]; j += 1; }
      }
      out += '"' + fixString(raw) + '"';
      i = j + 1;
    }
    return out;
  }

  /** MCP calls of a text: extension parser; if it fails, quotes/backslashes are repaired and it retries. */
  function parseCalls(text) {
    try {
      const direct = WMB.extractMcpCalls(text);
      if (direct?.length) return direct;
    } catch { /* variants are tried */ }

    const clean = text.replace(/[“”]/g, '"').replace(/\u00a0/g, ' ');
    for (const variant of [text, repairBackslashes(clean)]) {
      for (const obj of findJsonObjects(variant)) {
        if (!obj || typeof obj !== 'object' || !('mcp_call' in obj)) continue;
        try {
          const normalized = WMB.extractMcpCalls('```json\n' + JSON.stringify(obj) + '\n```');
          if (normalized?.length) return normalized;
        } catch { /* next candidate */ }
      }
    }
    return [];
  }

  /**
   * Text that the base observer will see: the message's text and, if its JSON was broken by Markdown,
   * the repaired call added at the end (deterministic: the same message always gives the same text).
   */
  function messageText(element) {
    const text = extractText(element);
    if (!text.includes('mcp_call')) return text;
    try { if (WMB.extractMcpCalls(text).length) return text; } catch { /* try to repair */ }
    const calls = parseCalls(text);
    if (!calls.length) return text;
    return `${text}\n${calls.map((call) => '```json\n' + JSON.stringify({ mcp_call: call }) + '\n```').join('\n')}`;
  }

  /** Wraps the element so that `textContent` returns the reconstructed text (the rest is delegated as is). */
  function wrap(element) {
    return new Proxy(element, {
      get(target, prop) {
        if (prop === 'textContent') return messageText(target);
        if (prop === '__raw') return target;
        const value = target[prop];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }

  /** Is it an assistant element (not the user's, nor the form's) with a real MCP call (not the prompt template)? */
  function isCallElement(el) {
    const raw = el.textContent || '';
    return raw.includes('mcp_call') && !raw.includes('<servidor>') && !raw.includes('<server>')
      && !el.closest(USER_SEL) && !el.querySelector(USER_SEL) && !el.closest('form');
  }

  const inDocumentOrder = (a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);

  class ChatGPTAdapter extends WMB.BaseAdapter {
    #cache = null;

    constructor() {
      super({
        id: 'chatgpt',
        name: 'ChatGPT',
        selectors: {
          composer: [
            '#prompt-textarea',
            'div.ProseMirror[contenteditable="true"]',
            'form div[contenteditable="true"]',
            'textarea[name="prompt-textarea"]',
            'textarea[data-id="root"]',
            'form textarea',
          ],
          sendButton: [
            'button[data-testid="send-button"]',
            'button[aria-label*="Send" i]',
            'button[aria-label*="Enviar" i]',
            'form button[type="submit"]',
          ],
          // ALL those that return elements are used (not just the first one).
          assistantMessages: [
            '[data-message-author-role="assistant"]',
            'article[data-turn="assistant"]',
            '[data-turn="assistant"]',
            'div.agent-turn',
          ],
          // Only the "stop generating" button (not the dictation one).
          stopButton: [
            'button[data-testid="stop-button"]',
            'button[aria-label*="Stop streaming" i]',
            'button[aria-label*="Stop generating" i]',
            'button[aria-label*="Detener la transm" i]',
            'button[aria-label*="Detener generaci" i]',
          ],
          fileInput: ['input[type="file"]'],
        },
      });
    }

    matches(hostname) {
      return hostname === 'chatgpt.com' || hostname.endsWith('.chatgpt.com') || hostname === 'chat.openai.com';
    }

    /**
     * Assistant messages in document order, without nested ones (the outermost container is kept),
     * with the reconstructed and repaired text. Includes the blocks/texts with `mcp_call` that remain outside of
     * the known containers.
     */
    getAssistantMessages() {
      const now = Date.now();
      if (this.#cache && now - this.#cache.time < CACHE_MS) return this.#cache.list;

      const containers = new Set();
      for (const selector of this.selectors.assistantMessages) {
        try { document.querySelectorAll(selector).forEach((el) => containers.add(el)); } catch { /* invalid selector */ }
      }
      const known = [...containers].filter((el) => !el.closest(USER_SEL) && !el.querySelector(USER_SEL));
      const extras = this.#callElements().filter((el) => !known.some((c) => c.contains(el)));

      const all = [...known, ...extras];
      const list = all
        .filter((el) => !all.some((other) => other !== el && other.contains(el)))
        .sort(inDocumentOrder)
        .map(wrap);
      this.#cache = { time: now, list };
      return list;
    }

    /**
     * Observes the responses. Same interface as the base adapter:
     * `callback({id, call, element})` for each new MCP call; `onDone({text, element})` for a response without a call.
     * @returns {() => void} stops observing
     */
    observeResponses(callback, { onDone } = {}) {
      let alive = true;
      let scheduled = false;
      let lastDone = '';
      const done = new Map();       // call ID already processed → {absentSince}
      const seen = new WeakMap();   // element → {text, since}
      const say = (message) => { try { this.debug?.('ok', `ChatGPT · ${message}`); } catch { /* no panel */ } };
      const convOf = () => (location.pathname.match(/\/c\/([^/?#]+)/) || [])[1] || null;
      let conv = convOf();

      const scan = () => {
        const now = Date.now();

        // Conversation change (to another or to "new chat"): starts from scratch. A new chat that receives its URL
        // (/ → /c/<id>) does NOT count as a change.
        const nowConv = convOf();
        if (nowConv !== conv) {
          if (conv !== null) { done.clear(); this.lastActivity = 0; lastDone = ''; }
          conv = nowConv;
        }

        const streaming = this.isStreaming();
        if (streaming) this.lastActivity = now;
        if (streaming && this.lastDeliveryAt) this.genSinceDelivery = true;
        const baseline = now - this.lastActivity >= ACTIVE_MS;

        const tally = new Map();
        const present = new Set();
        const blocks = this.#callElements().sort(inDocumentOrder);
        for (const el of blocks) {
          const text = extractText(el);
          let state = seen.get(el);
          if (!state || state.text !== text) { state = { text, since: now }; seen.set(el, state); }
          const calls = parseCalls(text);
          if (!calls.length) continue;
          const stableFor = now - state.since;
          const ready = baseline || (stableFor >= STABLE_MS && (!streaming || stableFor >= STUCK_MS));

          calls.forEach((call, n) => {
            // ID = the call + how many identical ones are before it on the page (does not depend on URL or message IDs).
            const hash = WMB.hash(JSON.stringify(call));
            const occurrence = tally.get(hash) ?? 0;
            tally.set(hash, occurrence + 1);
            const id = `${hash}:${occurrence}`;
            present.add(id);
            if (!ready) return;
            let fireId = id;
            if (done.has(id)) {
              // Call identical to one already executed: it is only a real repetition (the AI expects a response again) if it responded after
              // receiving the result and this is its last block; if not, it is a page repaint.
              if (baseline || streaming || n !== 0 || el !== blocks[blocks.length - 1] || !this.genSinceDelivery) return;
              fireId = `${id}~r${this.deliveries}`;
              if (done.has(fireId)) return;
              present.add(fireId);
            }
            done.set(fireId, { absentSince: 0 });
            // Protocol: one call per message → only the first one is executed. In baseline, it is only memorized.
            if (!baseline && n === 0) { say('call detected, executing…'); callback({ id: fireId, call, element: wrap(el) }); }
          });
        }

        // Calls that are no longer on the page are forgotten (this way repeating a task is never blocked).
        for (const [id, entry] of done) {
          if (present.has(id)) entry.absentSince = 0;
          else if (!entry.absentSince) entry.absentSince = now;
          else if (now - entry.absentSince >= FORGET_MS) done.delete(id);
        }

        // Finished response WITHOUT an MCP call.
        if (!baseline && !streaming && onDone) {
          const messages = this.getAssistantMessages();
          let last = -1;
          for (let i = messages.length - 1; i >= 0 && last < 0; i -= 1) if ((messages[i].textContent || '').trim()) last = i;
          if (last >= 0) {
            const text = messages[last].textContent;
            const key = `${conv}:${messages.length}:${text.length}`;
            const probe = seen.get(messages[last].__raw) ?? { text: '', since: now };
            if (probe.text !== text) seen.set(messages[last].__raw, { text, since: now });
            else if (now - probe.since >= STABLE_MS && key !== lastDone && !parseCalls(text).length) {
              lastDone = key; onDone({ text, element: messages[last] });
            }
          }
        }
      };
      this.rescan = () => { lastDone = ''; scan(); };

      const schedule = (delay = 400) => {
        if (scheduled) return;
        scheduled = true;
        WMB.sleep(delay).then(() => { scheduled = false; if (alive) scan(); });
      };
      const observer = new MutationObserver(() => schedule());
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });

      const wake = () => { if (!document.hidden) this.rescan(); };
      document.addEventListener('visibilitychange', wake);
      window.addEventListener('focus', wake);

      (async () => {
        while (alive) {
          await WMB.sleep(POLL_MS);
          if (!WMB.extensionAlive()) alive = false;
          if (!alive) break;
          scan();
        }
      })();

      return () => {
        alive = false;
        observer.disconnect();
        document.removeEventListener('visibilitychange', wake);
        window.removeEventListener('focus', wake);
      };
    }

    /** Elements with an MCP call located by their text: <pre> blocks and, if not, normal text. */
    #callElements() {
      const found = Array.from(document.querySelectorAll('pre')).filter(isCallElement);

      // Normal text: find the text node with "mcp_call" and go up to the element whose text contains a valid call.
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!/mcp_call|"server"\s*:/.test(node.nodeValue) || node.nodeValue.includes('<servidor>') || node.nodeValue.includes('<server>')) continue;
        let el = node.parentElement;
        if (!el || el.closest(USER_SEL) || el.closest('form') || el.closest('[contenteditable="true"]')) continue;
        for (let depth = 0; el && depth < 10 && el !== document.body && el.tagName !== 'MAIN'; depth += 1, el = el.parentElement) {
          if (el.querySelector(USER_SEL)) break;
          if (!isCallElement(el)) continue;
          if (parseCalls(extractText(el)).length) {
            if (!found.some((f) => f === el || f.contains(el))) found.push(el);
            break;
          }
        }
      }
      return found.filter((el) => !found.some((other) => other !== el && el.contains(other) && !other.matches('pre')));
    }
  }

  WMB.registerAdapter(new ChatGPTAdapter());
})();