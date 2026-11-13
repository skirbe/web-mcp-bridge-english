/**
 * constants.js - Shared constants between the service worker and the popup.
 * (Content scripts are not modules; they receive these values via messages.)
 */

/** Maximum number of MCP servers active at the same time. */
export const MAX_ACTIVE_SERVERS = 5;

/** Recommended number of active servers (more = more context tokens). */
export const RECOMMENDED_ACTIVE_SERVERS = 1;

export const STORAGE_KEYS = {
  servers: 'wmb_servers',
  settings: 'wmb_settings',
  history: 'wmb_history',
  dismissed: 'wmb_dismissed',
  notices: 'wmb_notices',
  bridge: 'wmb_bridge',
};

/** Legacy keys from previous versions that are deleted automatically (v1.4: the auto-update system was removed). */
export const LEGACY_STORAGE_KEYS = ['wmb_update'];

/** Permissions per MCP: allow = never asks · ask = asks on every call · deny = blocked. */
export const PERMISSIONS = ['allow', 'ask', 'deny'];
export const PERMISSION_LABELS = { allow: 'Allow always', ask: 'Ask every time', deny: "Don't allow" };

export const DEFAULT_SETTINGS = {
  /** Master switch: if false, there are no connections or injection. */
  bridgeEnabled: true,
  /** Adds the tool instructions automatically when sending the first message. */
  autoInject: true,
  /** Permission given to new MCPs (and the one shown by the global selector). */
  defaultPermission: 'ask',
  /** Automatically send the result to the chat. */
  autoSend: true,
  /** Maximum characters of a result inside the message. Anything over this is attached IN FULL as a file (never truncated). */
  maxResultChars: 12000,
  /** Adds a short line to each message so the AI doesn't forget it has local tools. */
  reminder: true,
  /** Every N user messages, the full instructions are sent again (0 = never). */
  reinjectEvery: 12,
  /** If the chat doesn't accept the send while the tab is hidden, bring the tab to the front for a moment and return to the previous one. */
  focusFallback: true,
  /** Automatically detects servers from servers.json by asking the bridge (control port). */
  autoDiscover: true,
  /** Also enables detected servers (up to the maximum). If false, only the first one is enabled when none are active. */
  autoEnableDiscovered: false,
  /** Bridge control port (http://127.0.0.1:PORT/servers). */
  controlPort: 8099,
  /** Shows author notices (news, new versions, issues). Installs nothing: just informs. */
  showNotices: true,
};

/** The test server bundled in the repository (server/examples/demo_mcp_server.py). */
export const DEMO_SERVER = { name: 'demo', url: 'ws://localhost:8090' };

/**
 * Author notices: a public JSON file (notices.json) in the repository. Free, no own server.
 * Checked every few hours; nothing is ever downloaded or executed: only text and a link are displayed.
 */
export const NOTICES_URL = 'https://raw.githubusercontent.com/AstraxOf/web-mcp-bridge/main/notices.json';
export const NOTICES_EVERY_MS = 10 * 60 * 1000;
export const NOTICES_RETRY_MS = 5 * 60 * 1000;
export const NOTICES_MAX_BYTES = 64 * 1024;
export const NOTICES_MAX_ITEMS = 20;
/** Links in a notice can only point to these sites (https). */
export const NOTICE_LINK_HOSTS = ['github.com', 'gist.github.com'];
export const NOTICE_LINK_SUFFIXES = ['.github.io'];

export const PROTOCOL_VERSION = '2025-03-26';
export const CALL_TIMEOUT_MS = 120_000;
export const HISTORY_LIMIT = 50;

export const SUPPORTED_URL_PATTERNS = [
  'https://chatgpt.com/*',
  'https://gemini.google.com/*',
  'https://claude.ai/*',
  'https://chat.deepseek.com/*',
];