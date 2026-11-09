#!/usr/bin/env node
// Hermes Chrome bridge, for MCP agents (Claude Code, Cursor…). Hermes users can use the plugin instead.
//   Extension  --WebSocket-->  /ext   (paired device, one live connection)
//   Agent      --MCP (HTTP)->  /mcp   (streamable HTTP, stateless, loopback only)
// Every MCP tool call is forwarded to the extension, which performs it in the user's Chrome.
// `hermes-chrome-bridge pair` prints a one-time pairing code from the running bridge.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const VERSION = '0.4.0';
// Comma-separated; e.g. "127.0.0.1,100.64.12.34" to also accept the extension over Tailscale.
const HOSTS = (process.env.HC_HOST || '127.0.0.1').split(',').map((h) => h.trim()).filter(Boolean);
// /mcp gives full control of the browser, so by default only local agents may call it.
const MCP_ALLOW_REMOTE = process.env.HC_MCP_ALLOW_REMOTE === '1';
const PORT = Number(process.env.HC_PORT || 8798);
const MCP_TOKEN = process.env.HC_MCP_TOKEN || '';
const UNAVAILABLE = process.env.HC_UNAVAILABLE_MESSAGE || 'Browser not available';
const CALL_TIMEOUT_MS = Number(process.env.HC_CALL_TIMEOUT_MS || 60_000);
const AGENT_NAME = process.env.HC_AGENT_NAME || 'Hermes';
const STATE_DIR = process.env.HC_STATE_DIR || path.join(os.homedir(), '.config', 'hermes-chrome');
// Address put into pairing codes: explicit, else the first non-loopback listen address.
const ADVERTISE = process.env.HC_ADVERTISE_HOST || HOSTS.find((h) => !['127.0.0.1', '::1', 'localhost'].includes(h)) || '127.0.0.1';
// Optional side-panel chat: the bridge relays chat turns to the Hermes API server.
const HERMES_URL = (process.env.HC_HERMES_URL || '').replace(/\/$/, '');
const HERMES_KEY = process.env.HC_HERMES_KEY || '';

const log = (...a) => console.error(new Date().toISOString(), ...a);
const safeEqual = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

// `hermes-chrome-bridge pair`: ask the running bridge for a code and exit.
if (process.argv[2] === 'pair') {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/pair`, { method: 'POST' });
    const { code } = await r.json();
    console.log(`Pairing code (one use, valid 5 minutes):\n\n${code}\n\nPaste it into the Hermes Chrome extension: Settings → Pair.`);
    process.exit(0);
  } catch {
    console.error(`No bridge is running on port ${PORT}. Start it first (npm start).`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------- pairing
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const codes = new Map(); // code -> expiry ms
let pairFailures = 0;
const devicesFile = path.join(STATE_DIR, 'devices.json');
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const readDevices = () => { try { return JSON.parse(fs.readFileSync(devicesFile, 'utf8')); } catch { return {}; } };
function writeDevices(d) {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${devicesFile}.tmp`; // write then rename: readers never see a half-written file
  fs.writeFileSync(tmp, JSON.stringify(d, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, devicesFile);
}
function newCode() {
  const code = Array.from(crypto.randomBytes(8), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
  codes.set(code, Date.now() + 300_000);
  pairFailures = 0;
  return `HC-${code.slice(0, 4)}-${code.slice(4)}@${ADVERTISE}:${PORT}`;
}
function redeem(raw, deviceName) {
  let code = String(raw || '').split('@')[0].toUpperCase().replace(/[\s-]/g, '');
  if (code.startsWith('HC')) code = code.slice(2);
  const exp = codes.get(code);
  codes.delete(code);
  if (!exp || exp < Date.now()) {
    if (++pairFailures >= 5) codes.clear(); // too many wrong guesses: all outstanding codes die
    return null;
  }
  const deviceId = crypto.randomBytes(6).toString('hex');
  const deviceKey = crypto.randomBytes(32).toString('base64url');
  const devices = readDevices();
  devices[deviceId] = { name: String(deviceName || 'Chrome').slice(0, 60), key_sha256: sha256(deviceKey), created: Date.now() };
  writeDevices(devices);
  return { deviceId, deviceKey };
}
const checkDevice = (id, key) => { const d = readDevices()[id || '']; return !!d && safeEqual(d.key_sha256, sha256(key || '')); };

// ---------------------------------------------------------------- extension link
class ExtensionLink {
  constructor() { this.ws = null; this.info = null; this.pending = new Map(); this.seq = 0; }
  get connected() { return !!this.ws && this.ws.readyState === 1; }

  attach(ws, hello) {
    if (this.ws) this.ws.close(4000, 'replaced by a newer connection');
    this.ws = ws;
    this.info = { browser: hello.browser, version: hello.version };
    log('extension connected', hello.browser || '', hello.version || '');
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (msg.type === 'ping') { ws.send(JSON.stringify({ type: 'pong' })); return; }
      if (msg.type === 'chat') { runChat(ws, msg); return; }
      if (msg.type === 'chat_cancel') { chats.get(msg.chatId)?.abort(); return; }
      if (msg.type === 'chat_meta') { chatMeta(ws); return; }
      if (msg.type === 'list_recordings') { ws.send(JSON.stringify({ type: 'recordings', items: listRecordings() })); return; }
      if (msg.type === 'delete_recording') {
        const f = path.join(recDir, `${slugify(msg.name)}.json`);
        if (slugify(msg.name) && fs.existsSync(f)) fs.unlinkSync(f);
        ws.send(JSON.stringify({ type: 'recordings', items: listRecordings() }));
        return;
      }
      if (msg.type === 'run_recording') { runRecording(ws, msg); return; }
      if (msg.type === 'save_skill') { ws.send(JSON.stringify({ type: 'skill_saved', id: msg.id, ...saveRecording(msg) })); return; }
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      msg.error ? p.reject(new Error(msg.error)) : p.resolve(msg.result);
    });
    ws.on('close', () => {
      if (this.ws !== ws) return;
      log('extension disconnected');
      for (const ac of chats.values()) ac.abort();
      this.ws = null;
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error(UNAVAILABLE)); }
      this.pending.clear();
    });
  }

  call(method, params, timeoutMs = CALL_TIMEOUT_MS) {
    if (!this.connected) return Promise.reject(new Error(UNAVAILABLE));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out after ${timeoutMs} ms`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}
const ext = new ExtensionLink();

// ---------------------------------------------------------------- side-panel chat relay
const chats = new Map(); // chatId -> AbortController

const hermesHeaders = () => ({ 'content-type': 'application/json', ...(HERMES_KEY ? { authorization: `Bearer ${HERMES_KEY}` } : {}) });

function saveUpload(f) {
  const data = Buffer.from(f.data || '', 'base64');
  if (!data.length || data.length > 25 * 1024 * 1024) return null;
  const dir = path.join(STATE_DIR, 'uploads');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${Date.now()}-${String(f.name || 'file').replace(/[^\w.-]+/g, '_').slice(-80)}`);
  fs.writeFileSync(file, data, { mode: 0o600 });
  return file;
}

async function runChat(ws, { chatId, conversation, text, images = [], files = [], model, provider }) {
  const send = (kind, data = {}) => ws.readyState === 1 && ws.send(JSON.stringify({ type: 'chat_event', chatId, kind, ...data }));
  if (!HERMES_URL) return send('error', { message: 'Chat is not set up on the bridge (HC_HERMES_URL is empty).' });
  const ac = new AbortController();
  chats.set(chatId, ac);
  const commentary = new Set();
  const saved = files.map(saveUpload).filter(Boolean);
  if (saved.length) text += `\n\n[Files the user attached are saved on this machine: ${saved.join('; ')}. Read them with your file tools.]`;
  const imgs = images.filter((u) => typeof u === 'string' && u.startsWith('data:image/'));
  const input = imgs.length
    ? [{ role: 'user', content: [{ type: 'input_text', text }, ...imgs.map((u) => ({ type: 'input_image', image_url: u }))] }]
    : text;
  try {
    const res = await fetch(`${HERMES_URL}/v1/responses`, {
      method: 'POST',
      signal: ac.signal,
      headers: hermesHeaders(),
      body: JSON.stringify({ model: 'hermes-agent', input, conversation, stream: true, store: true, ...(model && provider ? { model, provider } : {}) }),
    });
    if (!res.ok) throw new Error(`Hermes API ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const decoder = new TextDecoder();
    let buf = '';
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const data = buf.slice(0, i).split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
        buf = buf.slice(i + 2);
        if (!data || data === '[DONE]') continue;
        let ev;
        try { ev = JSON.parse(data); } catch { continue; }
        const item = ev.item;
        if (ev.type === 'response.output_item.added' && item?.type === 'message' && item.phase === 'commentary') commentary.add(item.id);
        else if (ev.type === 'response.output_text.delta' && !commentary.has(ev.item_id)) send('delta', { text: ev.delta });
        else if (ev.type === 'response.output_item.done' && item?.type === 'function_call') send('tool', { name: item.name, args: item.arguments });
        else if (ev.type === 'response.output_item.done' && item?.type === 'message' && commentary.has(item.id)) {
          send('commentary', { text: (item.content || []).map((c) => c.text || '').join('') });
        } else if (ev.type === 'response.failed' || ev.type === 'error') {
          send('error', { message: ev.response?.error?.message || ev.error?.message || ev.message || 'Hermes reported an error' });
        }
      }
    }
    send('done');
  } catch (e) {
    send(ac.signal.aborted ? 'stopped' : 'error', { message: e.message });
  } finally {
    chats.delete(chatId);
  }
}

async function chatMeta(ws) {
  const models = { current: null, providers: [] };
  if (HERMES_URL) {
    try {
      const d = await (await fetch(`${HERMES_URL}/api/model/options`, { headers: hermesHeaders(), signal: AbortSignal.timeout(15_000) })).json();
      models.current = { model: d.model, provider: d.provider };
      models.providers = (d.providers || []).filter((p) => p.authenticated && p.models?.length)
        .map((p) => ({ slug: p.slug, name: p.name || p.slug, models: p.models }));
    } catch {}
  }
  if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'chat_meta', chatAvailable: !!HERMES_URL, models, skills: [] }));
}

// ---------------------------------------------------------------- recorded workflows (Teach tab)
const recDir = path.join(STATE_DIR, 'recordings');
const slugify = (n) => String(n || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
function saveRecording({ name, description, steps }) {
  const slug = slugify(name);
  if (!slug) return { ok: false, error: 'Give the workflow a name.' };
  const clean = (steps || []).filter((s) => ['open', 'navigate', 'click', 'type', 'select', 'key'].includes(s?.action))
    .map(({ action, url, target, value, label, key, secret }) => (secret ? { action, url, target, label, key, secret } : { action, url, target, value, label, key }));
  if (clean.length < 2) return { ok: false, error: 'Nothing to save: record at least one action after opening the page.' };
  fs.mkdirSync(recDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(recDir, `${slug}.json`), JSON.stringify({ name: slug, description, steps: clean }, null, 2));
  log('saved recorded workflow', slug);
  return { ok: true, name: slug };
}
function readRecording(name) {
  try { return JSON.parse(fs.readFileSync(path.join(recDir, `${slugify(name)}.json`), 'utf8')); } catch { return null; }
}
const varsIn = (steps) => [...new Set(steps.flatMap((s) => [...String(s.value ?? '').matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1])))];
function listRecordings() {
  const files = fs.existsSync(recDir) ? fs.readdirSync(recDir).filter((f) => f.endsWith('.json')) : [];
  return files.map((f) => readRecording(f.slice(0, -5))).filter(Boolean)
    .map((d) => ({ name: d.name, description: d.description || '', steps: d.steps.length, vars: varsIn(d.steps) }));
}
// Side panel ▶ Run: replay in the connected browser, asking for missing values first.
async function runRecording(ws, { id, name, vars = {} }) {
  const send = (o) => ws.readyState === 1 && ws.send(JSON.stringify({ type: 'recording_run', id, name, ...o }));
  const d = readRecording(name);
  if (!d) return send({ ok: false, error: 'That recording no longer exists.' });
  const missing = varsIn(d.steps).filter((v) => !(v in vars));
  if (missing.length) return send({ ok: false, missing });
  const steps = d.steps.map((s) => ('value' in s ? { ...s, value: String(s.value ?? '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_, v) => vars[v]) } : s));
  try { send({ ok: true, text: (await ext.call('replay', { name: d.name, steps }, 120_000 + 45_000 * steps.length)).text }); }
  catch (e) { send({ ok: false, error: e.message }); }
}

async function replay({ name, vars = {} }) {
  const list = fs.existsSync(recDir) ? fs.readdirSync(recDir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)) : [];
  if (!name) return list.length ? `Recorded workflows: ${list.join(', ')}` : 'No recorded workflows yet (record one in the side panel Teach tab).';
  let data;
  try { data = JSON.parse(fs.readFileSync(path.join(recDir, `${slugify(name)}.json`), 'utf8')); } catch { return `No recorded workflow "${name}". Available: ${list.join(', ') || 'none'}.`; }
  const need = [...new Set(data.steps.flatMap((s) => [...String(s.value ?? '').matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1])))];
  const missing = need.filter((v) => !(v in vars));
  if (missing.length) return `"${data.name}" needs values for: ${missing.join(', ')}. Ask the user, then call replay again with vars.`;
  const steps = data.steps.map((s) => ('value' in s ? { ...s, value: String(s.value ?? '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_, v) => vars[v]) } : s));
  try { return (await ext.call('replay', { name: data.name, steps }, 120_000 + 45_000 * steps.length)).text; } catch (e) { return e.message; }
}

// ---------------------------------------------------------------- tools
const tabId = z.number().int().optional().describe('Tab id from tabs_list/tab_open. Omit to use the most recent agent tab.');
const ref = z.string().optional().describe('Element ref from read_page or find, e.g. "e12".');
const why = z.string().optional().describe('Short reason shown to the user next to the cursor, e.g. "Opening the export menu".');

export const TOOLS = [
  ['browser_status', 'Check whether the browser is connected and list the agent tabs. Call this first; if it reports unavailable, tell the user and stop.', {}],
  ['tabs_list', 'List the tabs in the agent tab group.', {}],
  ['tab_open', 'Open a URL in the agent tab and wait for it to load. Reuses the main agent tab by default; newTab=true opens an extra tab for side-by-side work, closed again by report.',
    { url: z.string(), why, newTab: z.boolean().optional().describe('Open an extra tab instead of reusing the main one (parallel research only).') }],
  ['tab_close', 'Close an agent tab.', { tabId }],
  ['navigate', 'Navigate a tab to a URL and wait for load. Use "back" or "forward" for history.', { tabId, url: z.string(), why }],
  ['read_page', 'Outline of the page: interactive elements (and headings/text when interactiveOnly=false) with refs to use in click/type.', { tabId, interactiveOnly: z.boolean().optional() }],
  ['find', 'Find elements whose text, label, placeholder or role matches the query. Returns refs.', { tabId, query: z.string() }],
  ['get_text', 'Visible text of the page (truncated).', { tabId, maxChars: z.number().int().optional() }],
  ['screenshot', 'Screenshot of the visible part of the tab.', { tabId }],
  ['click', 'Click an element by ref, or viewport coordinates x,y. The on-screen cursor animates to the target first.', { tabId, ref, x: z.number().optional(), y: z.number().optional(), double: z.boolean().optional(), button: z.enum(['left', 'right', 'middle']).optional(), why }],
  ['type', 'Type text, optionally into an element by ref (it is clicked first). clear=true empties the field first; submit=true presses Enter after.', { tabId, ref, text: z.string(), clear: z.boolean().optional(), submit: z.boolean().optional(), why }],
  ['press_key', 'Press a key or chord, e.g. "Enter", "Tab", "Escape", "ArrowDown", "Control+a", "Meta+a".', { tabId, key: z.string(), why }],
  ['scroll', 'Scroll the page (or the element by ref into view).', { tabId, ref, direction: z.enum(['up', 'down', 'left', 'right']).optional(), amount: z.number().optional(), why }],
  ['wait', 'Wait for a number of milliseconds (max 15000), e.g. after an action that loads content.', { tabId, ms: z.number().int() }],
  ['handoff', 'Ask the human to do something in the page (CAPTCHA, login, 2FA, payment confirmation). Shows a banner in the tab and waits until they click Done or the timeout passes. Never try to solve CAPTCHAs yourself.', { tabId, message: z.string(), timeoutSec: z.number().int().optional() }],
  ['eval_js', 'Run a JavaScript expression in the page and return the result. Disabled unless the user enabled it in the extension options.', { tabId, expression: z.string() }],
  ['plan', 'Show your plan as a progress strip in the browser: call with steps first, then with done=N as you finish steps.', { steps: z.array(z.string()).optional(), done: z.number().int().optional() }],
  ['report', 'Finish a task: returns stats and snapshots of the last steps for your summary to the user.', { summary: z.string() }],
  ['replay', 'Run a workflow the user recorded in the side panel (Teach tab). Omit name to list them; vars fills {{placeholders}}.', { name: z.string().optional(), vars: z.record(z.string()).optional() }],
];

function toContent(result) {
  const content = [];
  if (result?.image) content.push({ type: 'image', data: result.image.data, mimeType: result.image.mimeType || 'image/jpeg' });
  for (const im of result?.images || []) content.push({ type: 'image', data: im.data.split(',')[1], mimeType: 'image/jpeg' });
  const text = result?.text ?? (result?.image ? undefined : JSON.stringify(result ?? null));
  if (text !== undefined) content.push({ type: 'text', text });
  return content;
}

function buildMcpServer() {
  const server = new McpServer({ name: 'hermes-chrome', version: VERSION });
  for (const [name, description, shape] of TOOLS) {
    server.registerTool(name, { description, inputSchema: shape }, async (args) => {
      if (!ext.connected) return { content: [{ type: 'text', text: UNAVAILABLE }], isError: true };
      if (name === 'replay') return { content: [{ type: 'text', text: await replay(args) }] };
      if (name === 'browser_status') {
        const tabs = await ext.call('tabs_list', {}).catch(() => null);
        return { content: [{ type: 'text', text: JSON.stringify({ connected: true, browser: ext.info?.browser, extension: ext.info?.version, tabs: tabs?.tabs ?? [] }) }] };
      }
      const timeout = name === 'handoff' ? ((args.timeoutSec ?? 600) + 15) * 1000 : CALL_TIMEOUT_MS;
      try {
        return { content: toContent(await ext.call(name, args, timeout)) };
      } catch (e) {
        return { content: [{ type: 'text', text: e.message }], isError: true };
      }
    });
  }
  return server;
}

// ---------------------------------------------------------------- http + ws
async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks).toString();
  return body ? JSON.parse(body) : undefined;
}

async function onRequest(req, res) {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, version: VERSION, extension: ext.connected, browser: ext.info?.browser ?? null }));
  }
  const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
  if (url.pathname === '/pair' && req.method === 'POST') {
    if (!local) { res.writeHead(403).end(); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ code: newCode() }));
  }
  if (url.pathname !== '/mcp') { res.writeHead(404).end(); return; }
  if (!MCP_ALLOW_REMOTE && !local) { res.writeHead(403).end(); return; }
  if (MCP_TOKEN && !safeEqual(req.headers.authorization || '', `Bearer ${MCP_TOKEN}`)) { res.writeHead(401).end(); return; }
  if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }).end(); return; }
  try {
    const body = await readJson(req);
    const server = buildMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (e) {
    log('mcp error', e);
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'internal error' }, id: null }));
  }
}

const wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 });
function onUpgrade(req, socket, head) {
  if (new URL(req.url, 'http://x').pathname !== '/ext') {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }
  // Credentials arrive in the first frame (never in the URL, which browsers log). Until they check
  // out, the socket can neither receive tool calls nor replace the live connection.
  wss.handleUpgrade(req, socket, head, (ws) => {
    const timer = setTimeout(() => ws.close(4001, 'auth timeout'), 5000);
    ws.once('message', (raw) => {
      clearTimeout(timer);
      let msg;
      try { msg = JSON.parse(raw); } catch {}
      if (msg?.type === 'pair') {
        const res = redeem(msg.code, msg.deviceName);
        ws.send(JSON.stringify(res ? { type: 'paired', ...res, agentName: AGENT_NAME } : { type: 'pair_failed', reason: 'Code is wrong or expired. Get a new one.' }));
        if (res) log('paired a new browser', msg.deviceName || '');
        ws.close(1000);
        return;
      }
      if (msg?.type !== 'hello' || !checkDevice(msg.deviceId, msg.deviceKey)) {
        log('rejected extension connection (unknown device)');
        ws.close(4001, 'unauthorized');
        return;
      }
      const devices = readDevices();
      if (msg.deviceName && devices[msg.deviceId].name !== String(msg.deviceName).slice(0, 60)) { // keep renames in sync
        devices[msg.deviceId].name = String(msg.deviceName).slice(0, 60);
        writeDevices(devices);
      }
      ext.attach(ws, msg);
      ws.send(JSON.stringify({ type: 'welcome', agentName: AGENT_NAME }));
    });
  });
}

for (const host of HOSTS) {
  http.createServer(onRequest).on('upgrade', onUpgrade)
    .listen(PORT, host, () => log(`hermes-chrome bridge ${VERSION} on http://${host}:${PORT} (mcp: /mcp${MCP_ALLOW_REMOTE ? '' : ' loopback only'}, extension: /ext)`));
}
