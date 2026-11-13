/**
 * utils.js — Shared utilities for all content scripts.
 * Defines the global namespace `WMB` (Web MCP Bridge).
 */
(() => {
  'use strict';
  const WMB = (globalThis.WMB = globalThis.WMB || {});
  WMB.VERSION = '1.6.0';

  const nativeSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /** Message to the service worker (never throws). */
  WMB.bg = async (message) => {
    try { return await globalThis.chrome?.runtime?.sendMessage(message); } catch { return null; }
  };

  /** Is the tab hidden, covered by another window, or unfocused? That's where Chrome/Brave throttle page timers. */
  WMB.isBackground = () => typeof document !== 'undefined' && (document.hidden || !document.hasFocus());

  /**
   * Pause that does NOT freeze in the background: with the tab hidden, the timer is counted by the service worker
   * (a hidden tab's setTimeout is throttled to 1 s and, after 5 min, to 1 per minute). If it fails, uses setTimeout.
   */
  WMB.sleep = async (ms) => {
    if (!WMB.isBackground() || !globalThis.chrome?.runtime?.sendMessage) return nativeSleep(ms);
    const started = Date.now();
    await Promise.race([
      WMB.bg({ type: 'SLEEP', ms }),
      nativeSleep(ms + 3000), // safety net if the service worker doesn't answer
    ]);
    // Guarantee: a pause always lasts (almost) what was requested. If the service worker answered instantly (extension reloaded,
    // error…) it is completed with setTimeout, so that no loop can spin without brakes and hang the tab.
    const left = ms - (Date.now() - started);
    if (left > 20) await nativeSleep(left);
  };

  /** Is the extension still alive for this content script? (after reloading it, the old script is orphaned). */
  WMB.extensionAlive = () => !globalThis.chrome?.runtime || Boolean(globalThis.chrome.runtime.id);

  /** Retries `fn` until it returns a "truthy" value or the timeout expires. */
  WMB.waitFor = async (fn, { timeout = 3000, interval = 100 } = {}) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const value = fn();
      if (value) return value;
      await WMB.sleep(interval);
    }
    return fn() || null;
  };

  /** Fast hash (djb2) to generate call IDs. */
  WMB.hash = (input) => {
    const text = String(input ?? '');
    let h = 5381;
    for (let i = 0; i < text.length; i += 1) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  };

  // ───────────────────────── Flexible selectors ─────────────────────────

  WMB.isVisible = (el) => Boolean(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));

  /** First VISIBLE element that matches any of the selectors (in priority order). */
  WMB.firstVisible = (selectors, root = document, { loose = false } = {}) => {
    for (const selector of selectors) {
      try {
        for (const el of root.querySelectorAll(selector)) if (WMB.isVisible(el)) return el;
      } catch { /* invalid selector: ignored */ }
    }
    // Minimized or covered window: the browser may report size 0; with `loose` the first match is accepted.
    if (loose) {
      for (const selector of selectors) {
        try { const el = root.querySelector(selector); if (el) return el; } catch { /* noop */ }
      }
    }
    return null;
  };

  WMB.exists = (selectors, root = document) => {
    for (const selector of selectors) {
      try { if (root.querySelector(selector)) return true; } catch { /* noop */ }
    }
    return false;
  };

  /** All elements of the FIRST selector that returns results. */
  WMB.allMatches = (selectors, root = document) => {
    for (const selector of selectors) {
      try {
        const found = Array.from(root.querySelectorAll(selector));
        if (found.length) return found;
      } catch { /* noop */ }
    }
    return [];
  };

  // ───────────────────────── MCP call parser ─────────────────────────

  /** Returns the index of the brace that closes the JSON object starting at `start`, or -1. */
  function findBalancedEnd(text, start) {
    let depth = 0;
    let inString = false;
    for (let i = start; i < text.length; i += 1) {
      const ch = text[i];
      if (inString) {
        if (ch === '\\') i += 1;
        else if (ch === '"') inString = false;
      } else if (ch === '"') inString = true;
      else if (ch === '{') depth += 1;
      else if (ch === '}' && --depth === 0) return i;
    }
    return -1;
  }

  function scanCalls(text) {
    const calls = [];
    const marker = '"mcp_call"';
    let from = 0;
    for (;;) {
      const at = text.indexOf(marker, from);
      if (at === -1) break;
      from = at + marker.length;
      const start = text.lastIndexOf('{', at);
      if (start === -1) continue;
      const end = findBalancedEnd(text, start);
      if (end === -1) continue;
      try {
        const call = JSON.parse(text.slice(start, end + 1))?.mcp_call;
        if (call && typeof call.name === 'string' && call.name) {
          let args = call.arguments;
          if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } } // some models serialize arguments
          calls.push({
            server: typeof call.server === 'string' ? call.server : null,
            name: call.name,
            arguments: args && typeof args === 'object' && !Array.isArray(args) ? args : {},
          });
          from = end + 1;
        }
      } catch { /* incomplete or invalid JSON */ }
    }
    return calls;
  }

  /**
   * Extracts all valid `{"mcp_call": {...}}` calls from a message's text.
   * Tolerates code blocks, text around it, non-standard spaces, and typographic quotes.
   * @returns {{server:string|null,name:string,arguments:object}[]}
   */
  WMB.extractMcpCalls = (rawText) => {
    const raw = String(rawText).replace(/[\u00a0\u200b\u2028\u2029]/g, ' ');
    const calls = scanCalls(raw);
    if (calls.length || !raw.includes('mcp_call')) return calls;
    // Last resort: some renderers convert straight quotes to typographic ones (“ ”).
    return scanCalls(raw.replace(/[“”„‟″]/g, '"'));
  };

  // ───────────────────────── MCP Results (omitting nothing) ─────────────────────────

  const EXT = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg',
    'audio/wav': 'wav', 'audio/mpeg': 'mp3', 'audio/ogg': 'ogg', 'application/pdf': 'pdf', 'application/json': 'json', 'text/plain': 'txt',
  };
  const kb = (bytes) => `${Math.max(1, Math.round(bytes / 1024))} KB`;
  const cleanB64 = (data) => String(data).replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
  const sameJson = (a, b) => { try { return JSON.stringify(JSON.parse(a)) === JSON.stringify(b); } catch { return false; } };

  /**
   * Converts the MCP result (`content[]`) into text parts + files.
   * Text, resources, and structuredContent go inline; images, audio, and blobs are attached as files.
   * @returns {{parts:(string|{file:object,label:string})[], files:{name:string,mime:string,b64:string,bytes:number}[]}}
   */
  WMB.parseResult = (result, base = 'result') => {
    const parts = [];
    const files = [];
    const attach = (data, mime, label) => {
      const mimeType = mime || 'application/octet-stream';
      const b64 = cleanB64(data);
      const ext = EXT[mimeType] ?? (mimeType.split('/')[1] ?? 'bin').split(/[+;]/)[0];
      const file = { name: `${base}_${files.length + 1}.${ext}`, mime: mimeType, b64, bytes: Math.floor((b64.length * 3) / 4) };
      files.push(file);
      parts.push({ file, label });
    };

    let textParts = 0;
    for (const item of result?.content ?? []) {
      if (item.type === 'text') { parts.push(item.text ?? ''); textParts += 1; }
      else if ((item.type === 'image' || item.type === 'audio') && typeof item.data === 'string') attach(item.data, item.mimeType, item.type === 'image' ? 'image' : 'audio');
      else if (item.type === 'resource' && item.resource) {
        const { uri = '', text, blob, mimeType } = item.resource;
        if (typeof text === 'string') parts.push(`[resource ${uri}]\n${text}`);
        else if (typeof blob === 'string') attach(blob, mimeType, `resource ${uri}`.trim());
        else parts.push(JSON.stringify(item));
      } else if (item.type === 'resource_link') {
        parts.push(`[link: ${[item.uri, item.name, item.description].filter(Boolean).join(' · ')}]`);
      } else parts.push(JSON.stringify(item)); // unknown type: kept as is
    }
    const structured = result?.structuredContent;
    if (structured !== undefined && structured !== null) {
      const duplicated = (result.content ?? []).some((c) => c.type === 'text' && sameJson(c.text, structured));
      if (!duplicated) parts.push(JSON.stringify(structured, null, 2));
    }
    return { parts, files, hasText: textParts > 0 };
  };

  /** Joins the parts into text; `attached` indicates if the files arrived attached to the chat. */
  WMB.renderParts = (parts, attached = true) => parts
    .map((p) => (typeof p === 'string' ? p
      : attached ? `[${p.label} attached to this message: ${p.file.name} (${p.file.mime}, ${kb(p.file.bytes)})]`
        : `[${p.label} NOT attached (the browser downloaded it): ${p.file.name} (${p.file.mime}, ${kb(p.file.bytes)})]`))
    .join('\n');

  /** Message written to the chat with the tool's result. */
  WMB.formatToolResult = ({ server, name, status, text }) => `[MCP_RESULT server="${server}" tool="${name}" status="${status}"]\n${text ?? ''}\n[/MCP_RESULT]`;

  const PREVIEW_CHARS = 1500;

  /**
   * Delivery plan for an MCP result WITHOUT loss of information:
   *  - images/audio/blobs → attached files;
   *  - text exceeding `maxChars` → attached IN FULL as .txt and a preview remains inline.
   * If the attachment fails, `build(false)` leaves ALL the text inline.
   * @returns {{files:object[], build:(attached:boolean)=>string}}
   */
  WMB.planResult = (result, { server, name, status, maxChars = 12000 }) => {
    const base = `${server}_${name}`.replace(/[^\w.-]+/g, '_').slice(0, 40);
    const { parts, files } = WMB.parseResult(result, base);
    const full = WMB.renderParts(parts, true);
    let overflow = null;
    if (full.length > maxChars) {
      overflow = { name: `${base}_full.txt`, mime: 'text/plain', text: full, bytes: full.length, overflow: true };
      files.push(overflow);
    }
    const build = (attached) => {
      let text = WMB.renderParts(parts, attached);
      if (overflow && attached) {
        text = `${text.slice(0, PREVIEW_CHARS)}\n…\n[result of ${full.length} characters: FULL content in the attached file ${overflow.name}]`;
      }
      return WMB.formatToolResult({ server, name, status, text });
    };
    return { files, build };
  };

  // ───────────────────────── Writing to the text box ─────────────────────────

  const dom = (WMB.dom = {});

  dom.getText = (el) => ('value' in el ? el.value : (el.innerText || el.textContent || ''));

  /** Builds a `File` from `{name, mime, b64}` or `{name, mime, text}`. */
  dom.fileFrom = ({ name, mime, b64, text }) => {
    if (b64 === undefined) return new File([text ?? ''], name, { type: mime });
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], name, { type: mime });
  };

  /** Downloads a file (last resort when it cannot be attached to the chat: this way nothing is lost). */
  dom.download = (file) => {
    const url = URL.createObjectURL(file);
    const link = Object.assign(document.createElement('a'), { href: url, download: file.name });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  /**
   * Writes text to a <textarea> or a contenteditable editor (ProseMirror, Quill, Lexical…)
   * in a way that the page's framework detects the change.
   * Strategy: execCommand → paste event → direct assignment.
   */
  dom.setText = async (el, text, { append = true } = {}) => {
    el.focus();

    if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      const previous = append ? el.value : '';
      setter.call(el, previous ? `${previous}\n\n${text}` : text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.setSelectionRange?.(el.value.length, el.value.length);
      return true;
    }

    const selection = getSelection();
    const selectAll = () => {
      const range = document.createRange();
      range.selectNodeContents(el);
      if (append) range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
    };

    selectAll();
    if (!append) document.execCommand('delete');
    const hadText = dom.getText(el).trim().length > 0;
    const before = dom.getText(el).length;

    if (append && hadText) {
      document.execCommand('insertLineBreak');
      document.execCommand('insertLineBreak');
    }
    text.split('\n').forEach((line, i) => {
      if (i > 0) document.execCommand('insertLineBreak');
      if (line) document.execCommand('insertText', false, line);
    });
    await WMB.sleep(50);
    if (dom.getText(el).length > before) return true;

    // Fallback 1: simulate a "paste"
    try {
      const data = new DataTransfer();
      data.setData('text/plain', text);
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
      await WMB.sleep(80);
      if (dom.getText(el).length > before) return true;
    } catch { /* noop */ }

    // Fallback 2: direct assignment
    el.textContent = append && hadText ? `${dom.getText(el)}\n\n${text}` : text;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    return dom.getText(el).length > before;
  };
})();