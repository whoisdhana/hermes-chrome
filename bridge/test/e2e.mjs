// End-to-end: bridge + real extension in a throwaway Chromium + MCP client.
// Run: npm i --no-save playwright && npx playwright install chromium && node test/e2e.mjs
import { spawn } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(here, '../../extension');
const PORT = 8799, PAGE_PORT = 8800;
const SHOTS = process.env.HC_SHOTS || os.tmpdir();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PAGE = `<!doctype html><title>HC test</title>
<body style="font:16px sans-serif;padding:40px">
<h1>Sign up</h1>
<label for="n">Full name</label> <input id="n" placeholder="Your name"><br><br>
<button id="go" onclick="document.getElementById('out').textContent='Hello '+document.getElementById('n').value">Continue</button>
<button onclick="document.getElementById('out').textContent='DELETED'">Delete account</button>
<p id="out"></p><div style="height:2000px"></div><a href="/two">Next page</a>
<div style="position:relative;display:inline-block"><button>Covered button</button><div style="position:absolute;inset:0"></div></div></body>`;
// A small product list for chrome_extract: short nav links (not the list), three cards, a signed-in session.
const LIST = `<!doctype html><meta charset="utf-8"><title>Shop</title>
<nav><a href="/">Home</a> <a href="/a">About</a> <a href="/b">Blog</a> <a href="/c">Contact</a></nav><a href="/logout">Sign out</a>
<ul id="products">
<li class="card"><h3>Alpha Kettle</h3><span class="price">€49.00</span> <a href="/p/alpha">View</a></li>
<li class="card"><h3>Beta Toaster | Pro</h3><span class="price">€89.50</span><p>Rated 4.5 of 5</p></li>
<li class="card"><h3>=Gamma Blender</h3><span class="price">€120.00</span></li>
</ul>`;
const pageServer = http.createServer((req, res) => {
  if (req.url === '/redir') { res.writeHead(302, { location: `http://localhost:${PAGE_PORT}/two` }); return res.end(); }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(req.url === '/two' ? '<title>Two</title><h1>Page two</h1>' : req.url === '/list' ? LIST : PAGE);
}).listen(PAGE_PORT);

// HTTPS page with a self-signed certificate: Chromium shows a certificate warning for it.
const TLS_PORT = 8802;
const tlsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-tls-'));
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
  '-keyout', path.join(tlsDir, 'k.pem'), '-out', path.join(tlsDir, 'c.pem')], { stdio: 'ignore' });
const tlsServer = https.createServer({ key: fs.readFileSync(path.join(tlsDir, 'k.pem')), cert: fs.readFileSync(path.join(tlsDir, 'c.pem')) },
  (req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<title>Untrusted</title><h1>Untrusted</h1>'); }).listen(TLS_PORT);

// Mock Hermes API server: streams one tool call and a short answer for /v1/responses.
const HERMES_PORT = 8801;
const hermesRequests = [];
const sse = (ev) => `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`;
const hermesMock = http.createServer(async (req, res) => {
  if (req.url.startsWith('/api/model/options')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ model: 'claude-opus-5-5', provider: 'anthropic', providers: [
      { slug: 'anthropic', name: 'Anthropic', authenticated: true, models: ['claude-opus-5-5', 'claude-sonnet-5-5'] },
      { slug: 'openrouter', name: 'OpenRouter', authenticated: false, models: [] }] }));
  }
  let body = '';
  for await (const c of req) body += c;
  hermesRequests.push({ auth: req.headers.authorization, body: JSON.parse(body) });
  if (body.includes('SLOW')) await sleep(6000); // lets a test drop the connection mid-reply
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write(sse({ type: 'response.output_item.added', item: { id: 'c1', type: 'message', phase: 'commentary' } }));
  res.write(sse({ type: 'response.output_item.done', item: { id: 'c1', type: 'message', phase: 'commentary', content: [{ type: 'output_text', text: 'Checking the page' }] } }));
  res.write(sse({ type: 'response.output_item.done', item: { type: 'function_call', name: 'mcp__hermes_chrome__read_page', arguments: '{}' } }));
  for (const d of ['Hello ', 'from **mock**']) {
    await sleep(100);
    res.write(sse({ type: 'response.output_text.delta', item_id: 'm1', delta: d }));
  }
  res.end(sse({ type: 'response.completed', response: {} }));
}).listen(HERMES_PORT);

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-state-'));
const bridge = spawn(process.execPath, [path.resolve(here, '../src/server.mjs')], {
  env: { ...process.env, HC_PORT: String(PORT), HC_UNAVAILABLE_MESSAGE: 'MacBook not available', HC_AGENT_NAME: 'Delulu',
    HC_STATE_DIR: stateDir, HC_HERMES_URL: `http://127.0.0.1:${HERMES_PORT}`, HC_HERMES_KEY: 'mock-key' },
  stdio: ['ignore', 'inherit', 'inherit'],
});
const pairSecret = () => fs.readFileSync(path.join(stateDir, 'pair-secret'), 'utf8').trim();
const newCode = () => fetch(`http://127.0.0.1:${PORT}/pair`, { method: 'POST', headers: { 'x-hc-secret': pairSecret() } }).then((r) => r.json()).then((j) => j.code);

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-e2e-'));
let ctx, mcp, failed = false;
const results = [];
const step = async (name, fn) => {
  try { await fn(); results.push(`ok   ${name}`); }
  catch (e) { failed = true; results.push(`FAIL ${name}: ${e.message}`); }
  if (process.env.HC_PROGRESS) console.error(results.at(-1));
  if (process.env.HC_PROGRESS && results.at(-1).startsWith('FAIL') && globalThis.__sw) {
    console.error('STATE', JSON.stringify(await globalThis.__sw.evaluate(() => ({ paused: hud.paused, reason: hud.pausedReason, busy, waiters: pauseWaiters.length, halt: haltUntil - Date.now(), last: lastTabId }))));
    if (process.env.HC_STOP_ON_FAIL) process.exit(1);
  }
};

try {
  await sleep(500);
  ctx = await chromium.launchPersistentContext(userData, {
    headless: true, channel: 'chromium', viewport: { width: 1100, height: 760 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');
  globalThis.__sw = sw;
  const extId = new URL(sw.url()).host;
  await sw.evaluate(() => chrome.storage.local.set({ allowedHosts: '127.0.0.1' })); // the test page; the new-site prompt has its own step
  const health = () => fetch(`http://127.0.0.1:${PORT}/health`).then((r) => r.json());

  const options = await ctx.newPage();
  await options.goto(`chrome-extension://${extId}/options.html`);
  const pairWith = async (code) => {
    await options.fill('#code', code);
    await options.click('#pair');
    await options.waitForFunction(() => !/Pairing…/.test(document.querySelector('#pairStatus').textContent), null, { timeout: 10_000 });
    return options.textContent('#pairStatus');
  };

  await step('wrong pairing code is refused', async () => {
    await newCode();
    assert.match(await pairWith('HC-2222-2222@127.0.0.1:8799'), /wrong or expired/);
    assert.equal((await health()).extension, false);
  });
  let firstCode;
  await step('pairing code connects the browser', async () => {
    firstCode = await newCode();
    assert.match(firstCode, /^HC-[A-Z2-9]{4}-[A-Z2-9]{4}@127\.0\.0\.1:8799$/);
    await options.fill('#deviceName', 'Work MacBook');
    await options.click('#saveName');
    await pairWith(firstCode);
    for (let i = 0; i < 40 && !(await health()).extension; i++) await sleep(250);
    assert.equal((await health()).extension, true);
    const devices = JSON.parse(fs.readFileSync(path.join(stateDir, 'devices.json'), 'utf8'));
    const [dev] = Object.values(devices);
    assert.match(dev.key_sha256, /^[0-9a-f]{64}$/, 'only a hash of the device key is stored');
    assert.equal(dev.name, 'Work MacBook');
    // rename while paired: saved name reaches the server on the reconnect it triggers
    await options.fill('#deviceName', 'Work Chrome');
    await options.click('#saveName');
    const named = () => Object.values(JSON.parse(fs.readFileSync(path.join(stateDir, 'devices.json'), 'utf8')))[0].name;
    for (let i = 0; i < 40 && named() !== 'Work Chrome'; i++) await sleep(250);
    assert.equal(named(), 'Work Chrome');
    for (let i = 0; i < 40 && !(await health()).extension; i++) await sleep(250);
    assert.equal(await sw.evaluate(() => chrome.storage.local.get('agentName').then((s) => s.agentName)), 'Delulu');
  });
  await step('a pairing code works only once', async () => {
    const { WebSocket } = await import('ws');
    const sock = new WebSocket(`ws://127.0.0.1:${PORT}/ext`);
    await new Promise((r) => sock.on('open', r));
    sock.send(JSON.stringify({ type: 'pair', code: firstCode }));
    const reply = await new Promise((r) => sock.on('message', (m) => r(JSON.parse(m))));
    assert.equal(reply.type, 'pair_failed');
  });
  await step('a tunnel URL code (HC-…@wss://host/ext) pairs and connects', async () => {
    const urlCode = (await newCode()).replace(/@.*$/, `@ws://127.0.0.1:${PORT}/ext`); // same form as wss://, minus TLS
    assert.match(await pairWith(urlCode), /Paired with Delulu|Connected|Waiting/);
    for (let i = 0; i < 40 && !(await health()).extension; i++) await sleep(250);
    assert.equal((await health()).extension, true);
    assert.equal(await sw.evaluate(() => chrome.storage.local.get('url').then((s) => s.url)), `ws://127.0.0.1:${PORT}/ext`);
  });
  await step('a browser paired before 0.5 (host/port only) still reconnects', async () => {
    await sw.evaluate((port) => chrome.storage.local.set({ url: '', host: '127.0.0.1', port }), PORT);
    await sw.evaluate(() => ws.close());
    for (let i = 0; i < 40 && (await health()).extension; i++) await sleep(100);
    for (let i = 0; i < 60 && !(await health()).extension; i++) await sleep(250);
    assert.equal((await health()).extension, true);
  });
  await options.close();

  mcp = new Client({ name: 'e2e', version: '0' });
  await mcp.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`)));
  const call = async (name, args = {}) => {
    const r = await mcp.callTool({ name, arguments: args });
    const text = r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    if (r.isError) throw new Error(`${name}: ${text}`);
    return { text, content: r.content };
  };
  // Approvals open in the extension's own window (never in the page): find it and press a button by its label.
  const approve = async (label) => {
    let win;
    for (let i = 0; i < 100 && !win; i++) { win = ctx.pages().find((pg) => pg.url().includes('/approve.html')); if (!win) await sleep(100); }
    assert.ok(win, 'approval window opened');
    const btn = win.getByRole('button', { name: label, exact: true });
    await btn.waitFor();
    await win.waitForSelector('button:not([disabled])');
    await btn.click();
    for (let i = 0; i < 50 && !win.isClosed(); i++) await sleep(100);
  };
  const refOf = (outline, re) => outline.split('\n').find((l) => re.test(l))?.split(' ')[0];

  await step('web pages and strangers cannot reach the bridge', async () => {
    assert.equal((await fetch(`http://127.0.0.1:${PORT}/pair`, { method: 'POST' })).status, 403, '/pair needs the local secret');
    assert.equal((await fetch(`http://127.0.0.1:${PORT}/pair`, { method: 'POST', headers: { origin: 'https://evil.example' } })).status, 403);
    const rebound = await new Promise((resolve) => http.get({ host: '127.0.0.1', port: PORT, path: '/health', headers: { host: `evil.example:${PORT}` } },
      (res) => { res.resume(); resolve(res.statusCode); }).on('error', () => resolve('error')));
    assert.equal(rebound, 403, 'DNS rebinding: foreign Host');
    assert.equal((await fetch(`http://127.0.0.1:${PORT}/mcp`, { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' })).status, 403);
    const { WebSocket } = await import('ws');
    const code = await new Promise((resolve) => {
      const sock = new WebSocket(`ws://127.0.0.1:${PORT}/ext`, { headers: { origin: 'https://evil.example' } });
      sock.on('unexpected-response', (_req, res) => resolve(res.statusCode));
      sock.on('open', () => resolve('opened'));
      sock.on('error', () => {});
    });
    assert.equal(code, 403, 'a web page cannot open the extension socket');
  });
  await step('unknown device cannot take over the connection', async () => {
    const { WebSocket } = await import('ws');
    const sock = new WebSocket(`ws://127.0.0.1:${PORT}/ext`);
    await new Promise((r) => sock.on('open', r));
    sock.send(JSON.stringify({ type: 'hello', deviceId: 'nope', deviceKey: 'wrong' }));
    const code = await new Promise((r) => sock.on('close', (c) => r(c)));
    assert.equal(code, 4001);
    const h = await fetch(`http://127.0.0.1:${PORT}/health`).then((r) => r.json());
    assert.equal(h.extension, true, 'real extension still connected');
  });
  await step('tools/list has 22 tools', async () => assert.equal((await mcp.listTools()).tools.length, 22));
  await step('browser_status connected', async () => assert.match((await call('browser_status')).text, /"connected":true/));

  let tabId, outline;
  await step('tab_open into tab group', async () => {
    tabId = JSON.parse((await call('tab_open', { url: `http://127.0.0.1:${PAGE_PORT}/` })).text).tabId;
    const groups = await sw.evaluate(() => chrome.tabGroups.query({}).then((g) => g.map((x) => x.title)));
    assert.ok(groups.some((t) => t.includes('Delulu')), `groups: ${groups}`);
  });
  await step('read_page lists refs', async () => {
    outline = (await call('read_page', { tabId })).text;
    assert.match(outline, /textbox "Full name"/);
    assert.match(outline, /button "Continue"/);
  });
  await step('type + click (trusted input)', async () => {
    await call('type', { tabId, ref: refOf(outline, /textbox "Full name"/), text: 'Ada Lovelace', why: 'Entering your name' });
    await call('click', { tabId, ref: refOf(outline, /button "Continue"/), why: 'Moving to the next page' });
    const p = ctx.pages().find((pg) => pg.url().startsWith(`http://127.0.0.1:${PAGE_PORT}`));
    await p.screenshot({ path: path.join(SHOTS, 'hc-after-click.png') });
    assert.match((await call('get_text', { tabId })).text, /Hello Ada Lovelace/);
  });
  await step('find', async () => assert.match((await call('find', { tabId, query: 'delete' })).text, /Delete account/));
  await step('risky click asks in the extension window; Deny', async () => {
    const p = ctx.pages().find((pg) => pg.url().startsWith(`http://127.0.0.1:${PAGE_PORT}`));
    const pending = call('click', { tabId, ref: refOf(outline, /Delete account/), why: 'Deleting the test account' }).then(() => 'resolved', (e) => e.message);
    await sleep(1500);
    await p.screenshot({ path: path.join(SHOTS, 'hc-confirm.png') });
    await approve('Deny');
    assert.match(await pending, /did not allow/);
    assert.doesNotMatch((await call('get_text', { tabId })).text, /DELETED/);
  });
  await step('watched site: typing and keys wait for approval', async () => {
    const p = ctx.pages().find((pg) => pg.url().startsWith(`http://127.0.0.1:${PAGE_PORT}`));
    const starter = await sw.evaluate(() => chrome.storage.local.get(['blockedHosts', 'watchHosts']));
    assert.match(starter.blockedHosts, /1password\.com/, 'starter block list installed');
    assert.match(starter.watchHosts, /mail\.google\.com/, 'starter watch list installed');
    await sw.evaluate(() => chrome.storage.local.set({ watchHosts: '127.0.0.1' }));
    const ref = refOf(outline, /textbox "Full name"/);
    let pending = call('type', { tabId, ref, text: 'Watched', clear: true, why: 'Entering the name' }).then(() => 'resolved', (e) => e.message);
    await sleep(1500);
    await approve('Deny');
    assert.match(await pending, /did not allow/);
    pending = call('press_key', { tabId, key: 'Tab', why: 'Moving to the next field' }).then(() => 'resolved', (e) => e.message);
    await sleep(1500);
    await approve('Allow');

    assert.equal(await pending, 'resolved');
    await sw.evaluate(() => chrome.storage.local.set({ watchHosts: '' }));
  });
  await step('screenshot returns image', async () => {
    const r = await call('screenshot', { tabId });
    assert.ok(r.content.some((c) => c.type === 'image' && c.data.length > 1000));
  });
  await step('scroll', async () => assert.match((await call('scroll', { tabId, direction: 'down', amount: 800 })).text, /scrolled 0,[1-9]/));
  await step('handoff: Done via keyboard', async () => {
    const p = ctx.pages().find((pg) => pg.url().startsWith(`http://127.0.0.1:${PAGE_PORT}`));
    const pending = call('handoff', { tabId, message: 'Please solve the CAPTCHA, then press Done.', timeoutSec: 30 });
    await sleep(1200);
    await p.screenshot({ path: path.join(SHOTS, 'hc-handoff.png') });
    await p.keyboard.press('Enter');
    assert.match((await pending).text, /user says they are done/);
  });
  await step('navigate + back', async () => {
    assert.match((await call('navigate', { tabId, url: `http://127.0.0.1:${PAGE_PORT}/two` })).text, /Two/);
    assert.match((await call('navigate', { tabId, url: 'back' })).text, /HC test/);
  });
  await step('extract a product list; export checks quotes, escapes md, guards CSV', async () => {
    const listUrl = `http://127.0.0.1:${PAGE_PORT}/list`;
    await call('navigate', { tabId, url: listUrl, why: 'Opening the product list' });
    const page = JSON.parse((await call('extract', { tabId, multiple: true })).text);
    assert.equal(page.url, listUrl);
    assert.equal(page.loggedIn, true, 'a Sign out link reads as logged in');
    assert.match(page.capturedAt, /^\d{4}-\d\d-\d\dT/);
    assert.match(page.listSelector, /li\.card$/);
    assert.deepEqual(page.items.map((i) => i.text.split('\n')[0]), ['Alpha Kettle', 'Beta Toaster | Pro', '=Gamma Blender']);
    assert.match(page.items[0].text, /Link: http:\/\/127\.0\.0\.1:\d+\/p\/alpha/);
    const [a, b, c] = page.items.map((i) => i.ref);
    const out = JSON.parse((await call('export', { name: 'shop/../test', format: 'all', records: [
      { sourceUrl: listUrl, ref: a, values: { name: { value: 'Alpha Kettle', quote: 'Alpha Kettle' }, price: { value: '€49.00', quote: '€49.00' } } },
      { sourceUrl: listUrl, ref: b, values: { name: { value: 'Beta Toaster | Pro', quote: 'Beta Toaster | Pro' }, price: { value: '€79.00', quote: '€79.00' } } },
      { sourceUrl: listUrl, ref: c, values: { name: { value: '=Gamma Blender', quote: '=Gamma Blender' } } },
      { sourceUrl: listUrl, ref: a, values: { name: { value: 'Beta Toaster', quote: 'Beta Toaster' } } }, // another item's text
      { sourceUrl: 'https://never-read.example/', values: { name: { value: 'X', quote: 'X' } } },
    ] })).text);
    assert.equal(out.rows, 3);
    assert.equal(out.dropped.length, 3, JSON.stringify(out.dropped));
    assert.equal(out.files.length, 3);
    for (const f of out.files) assert.equal(path.dirname(f), path.join(stateDir, 'exports'), 'file name cannot leave the exports folder');
    const md = fs.readFileSync(out.files.find((f) => f.endsWith('.md')), 'utf8');
    assert.match(md, /\| 2 \| Beta Toaster \\\| Pro \|  \|/);
    assert.match(md, /## Sources/);
    assert.match(md, /logged in: yes/);
    assert.match(md, /- price: "€49\.00"/);
    const csv = fs.readFileSync(out.files.find((f) => f.endsWith('.csv')), 'utf8');
    assert.match(csv, /\n'=Gamma Blender,/);
    assert.equal(JSON.parse(fs.readFileSync(out.files.find((f) => f.endsWith('.json')), 'utf8')).records.length, 3);
    const single = JSON.parse((await call('extract', { tabId })).text);
    assert.match(single.pageText, /Rated 4\.5 of 5/);
    assert.equal(single.items, undefined);
    const { blockedHosts } = await sw.evaluate(() => chrome.storage.local.get('blockedHosts'));
    await sw.evaluate(() => chrome.storage.local.set({ blockedHosts: '127.0.0.1' }));
    await assert.rejects(call('extract', { tabId }), /blocked/);
    await sw.evaluate((v) => chrome.storage.local.set({ blockedHosts: v }), blockedHosts);
    await call('navigate', { tabId, url: `http://127.0.0.1:${PAGE_PORT}/`, why: 'Back to the test page' });
  });
  await step('press_key', async () => assert.match((await call('press_key', { tabId, key: 'Tab', why: 'Moving to the next field' })).text, /pressed Tab/));
  await step('new site: Decline, Allow once (until report), Always allow', async () => {
    const p = ctx.pages().find((pg) => pg.url().startsWith(`http://127.0.0.1:${PAGE_PORT}`));
    const key = () => call('press_key', { tabId, key: 'Tab', why: 'Moving to the next field' }).then(() => 'resolved', (e) => e.message);
    const answer = (label) => approve(label);
    await sw.evaluate(() => chrome.storage.local.set({ allowedHosts: '' }));
    let pending = key(); await answer('Decline');
    assert.match(await pending, /did not allow acting on 127\.0\.0\.1/);
    pending = key(); await answer('Allow once');
    assert.equal(await pending, 'resolved');
    assert.equal(await key(), 'resolved', 'no second prompt within the task');
    await call('report', { summary: 'Task done' }); // ends the "once"
    pending = key(); await answer('Always allow');
    assert.equal(await pending, 'resolved');
    assert.equal(await sw.evaluate(() => chrome.storage.local.get('allowedHosts').then((s) => s.allowedHosts)), '127.0.0.1');
    await call('report', { summary: 'Task done' });
    assert.equal(await key(), 'resolved', 'always allowed survives the end of the task');
  });
  await step('click, type and key without a real why are refused', async () => {
    for (const why of [undefined, '', 'click', 'Next']) {
      await assert.rejects(call('press_key', { tabId, key: 'Tab', ...(why === undefined ? {} : { why }) }), /why/i, String(why));
    }
  });
  await step('eval_js disabled by default', async () => {
    await assert.rejects(call('eval_js', { tabId, expression: '1+1' }), /disabled/);
  });
  await step('blocked host refused', async () => {
    await sw.evaluate(() => chrome.storage.local.set({ blockedHosts: 'example.com' }));
    await sleep(300);
    await assert.rejects(call('tab_open', { url: 'https://www.example.com/' }), /blocked/);
  });
  await step('non-web addresses and certificate warnings are refused', async () => {
    await sw.evaluate(() => chrome.storage.local.set({ blockedHosts: '' }));
    for (const url of ['file:///etc/hosts', 'chrome://settings', 'javascript:alert(1)', 'data:text/html,hi', 'view-source:https://example.com']) {
      await assert.rejects(call('tab_open', { url }), /only opens http and https/, url);
      await assert.rejects(call('navigate', { tabId, url }), /only opens http and https/, url);
    }
    await assert.rejects(call('tab_open', { url: `https://localhost:${TLS_PORT}/`, newTab: true }), /certificate warning/);
    await assert.rejects(call('read_page', {}), /certificate warning/, 'the warning tab stays off limits');
    await call('report', { summary: 'Refused the warning page' }); // closes the extra tab
  });
  const testPage = () => ctx.pages().find((pg) => pg.url().startsWith(`http://127.0.0.1:${PAGE_PORT}`));
  await step('plan strip, tab group progress', async () => {
    await call('plan', { steps: ['Open the form', 'Fill in the name', 'Submit'] });
    await call('plan', { done: 1 });
    await testPage().bringToFront();
    outline = (await call('read_page', { tabId })).text;
    const pending = call('click', { tabId, ref: refOf(outline, /button "Continue"/), why: 'Submitting the form' });
    await sleep(500);
    await testPage().screenshot({ path: path.join(SHOTS, 'hc-plan.png') });
    await pending;
    const titles = await sw.evaluate(() => chrome.tabGroups.query({}).then((g) => g.map((x) => x.title)));
    assert.ok(titles.some((t) => /Delulu 2\/3/.test(t)), `group titles: ${titles}`);
    // the agent's tab is marked next to the address bar (toolbar badge) and in the tab strip (favicon dot)
    assert.equal(await sw.evaluate((id) => chrome.action.getBadgeText({ tabId: id }), tabId), '●');
    assert.equal(await sw.evaluate((id) => chrome.action.getTitle({ tabId: id }), tabId), 'Hermes Chrome', 'no per-tab hover text');
    await testPage().waitForSelector('link[data-hermes-chrome]', { state: 'attached', timeout: 5000 });
    assert.match(await testPage().getAttribute('link[data-hermes-chrome]', 'href'), /^data:image\/png;base64,/);
  });
  await step('takeover pauses the agent; resume continues', async () => {
    const p = testPage();
    await call('plan', { done: 2 });
    await p.mouse.move(100, 100);
    await p.mouse.move(400, 400, { steps: 8 }); // just moving the mouse is not a takeover
    await sleep(300);
    assert.equal(await sw.evaluate(() => hud.paused), false, 'mouse movement alone must not pause');
    await p.mouse.click(600, 500); // a real click is
    for (let i = 0; i < 20 && !(await sw.evaluate(() => hud.paused)); i++) await sleep(100);
    assert.equal(await sw.evaluate(() => hud.paused), true, 'paused after takeover');
    for (let i = 0; i < 20 && (await sw.evaluate((id) => chrome.action.getBadgeText({ tabId: id }), tabId)) !== 'II'; i++) await sleep(100);
    assert.equal(await sw.evaluate((id) => chrome.action.getBadgeText({ tabId: id }), tabId), 'II', 'paused marker');
    const t0 = Date.now();
    const pending = call('press_key', { tabId, key: 'Tab', why: 'Next field' });
    await sleep(800);
    await p.screenshot({ path: path.join(SHOTS, 'hc-paused.png') });
    await sw.evaluate(() => resume());
    assert.match((await pending).text, /pressed Tab/);
    assert.ok(Date.now() - t0 >= 800, 'the call waited while paused');
  });
  await step('activity timeline records labelled steps with snapshots', async () => {
    const { activity } = await sw.evaluate(() => chrome.storage.local.get('activity'));
    assert.ok(activity.some((a) => a.label === 'Submitting the form' && a.thumb?.startsWith('data:image/jpeg')), JSON.stringify(activity.map((a) => a.label)));
  });
  await step('report returns stats and snapshots', async () => {
    const r = await call('report', { summary: 'Filled the form' });
    const stats = JSON.parse(r.text);
    assert.ok(stats.steps >= 2);
    assert.ok(r.content.some((c) => c.type === 'image'));
  });
  await step('one tab by default; newTab for side-by-side work; report closes the extras', async () => {
    const count = async () => JSON.parse((await call('tabs_list')).text).length;
    const before = await count();
    const again = JSON.parse((await call('tab_open', { url: `http://127.0.0.1:${PAGE_PORT}/?one` })).text);
    assert.equal(again.tabId, tabId, 'chrome_open reuses the main agent tab');
    assert.equal(await count(), before, 'no new tab');
    const extra = JSON.parse((await call('tab_open', { url: `http://127.0.0.1:${PAGE_PORT}/?two`, newTab: true })).text);
    assert.notEqual(extra.tabId, tabId);
    assert.equal(await count(), before + 1, 'newTab opens one extra tab');
    const third = JSON.parse((await call('tab_open', { url: `http://127.0.0.1:${PAGE_PORT}/?three` })).text);
    assert.equal(third.tabId, tabId, 'without newTab the main tab is reused, not the extra one');
    const r = JSON.parse((await call('report', { summary: 'Compared two pages' })).text);
    assert.equal(r.closedExtraTabs, 1);
    assert.equal(await count(), before, 'extra tab closed, main tab kept');
    await sw.evaluate(() => chrome.storage.local.set({ keepTabs: true }));
    await call('tab_open', { url: `http://127.0.0.1:${PAGE_PORT}/?four`, newTab: true });
    assert.equal(JSON.parse((await call('report', { summary: 'Kept' })).text).closedExtraTabs, 0, 'keepTabs leaves extras open');
    await sw.evaluate(() => chrome.storage.local.set({ keepTabs: false }));
    await call('report', { summary: 'Tidy' });
    assert.equal(await count(), before);
  });
  await step('batch: several steps in one call, checks still apply', async () => {
    await call('navigate', { tabId, url: `http://127.0.0.1:${PAGE_PORT}/` });
    const o = (await call('read_page', { tabId })).text;
    const name = refOf(o, /textbox "Full name"/), go = refOf(o, /button "Continue"/), next = refOf(o, /link "Next page"/);
    await assert.rejects(call('batch', { tabId, actions: [
      { action: 'type', ref: name, text: 'Nope', why: 'Entering your name' }, { action: 'click', ref: go }] }), /step 2: click needs a short "why"/);
    assert.doesNotMatch((await call('get_text', { tabId })).text, /Nope/, 'nothing ran when a step lacked a why');
    await assert.rejects(call('batch', { tabId, actions: [{ action: 'eval_js', expression: '1' }] })); // refused by the schema (and by the extension)
    const r = (await call('batch', { tabId, actions: [
      { action: 'type', ref: name, text: 'Grace Hopper', clear: true, why: 'Entering your name' },
      { action: 'click', ref: go, why: 'Moving to the next page' },
      { action: 'get_text' }] })).text;
    assert.match(r, /^1\. type: typed 12 chars/m);
    assert.match(r, /^2\. click: clicked/m);
    assert.match(r, /Hello Grace Hopper/);
    const moved = (await call('batch', { tabId, actions: [
      { action: 'click', ref: next, why: 'Opening the next page' },
      { action: 'click', ref: go, why: 'Moving on' }] })).text;
    assert.match(moved, /page changed to .*\/two.*steps 2 to 2/s);
    await call('navigate', { tabId, url: `http://127.0.0.1:${PAGE_PORT}/` });
  });
  await step('blocked list: loose entries match, redirects onto a blocked site are left', async () => {
    await sw.evaluate(() => chrome.storage.local.set({ blockedHosts: 'https://Example.COM/\n*.Localhost.' }));
    await assert.rejects(call('tab_open', { url: 'https://www.example.com./x', newTab: true }), /blocked/);
    const r = JSON.parse((await call('tab_open', { url: `http://127.0.0.1:${PAGE_PORT}/redir`, newTab: true })).text);
    let url = '';
    for (let i = 0; i < 40 && url !== 'about:blank'; i++) { await sleep(100); url = await sw.evaluate((id) => chrome.tabs.get(id).then((t) => t.url), r.tabId); }
    assert.equal(url, 'about:blank', 'the redirect landed on a blocked host and the tab left it');
    await sw.evaluate(() => chrome.storage.local.set({ blockedHosts: '' }));
    await call('report', { summary: 'Checked the block list' });
  });
  await step('click: refused when something else covers the element', async () => {
    await call('navigate', { tabId, url: `http://127.0.0.1:${PAGE_PORT}/` });
    const o = (await call('read_page', { tabId })).text;
    await assert.rejects(call('click', { tabId, ref: refOf(o, /Covered button/), why: 'Pressing the button' }), /Something else is now on top/);
  });
  await step('action check: a "no" is shown with the reason; the user decides', async () => {
    const p = testPage();
    await call('navigate', { tabId, url: `http://127.0.0.1:${PAGE_PORT}/` });
    const o = (await call('read_page', { tabId })).text;
    await sw.evaluate(() => { globalThis.__origCheck = requestIntentCheck; requestIntentCheck = async () => ({ ok: false, reason: 'You did not ask to delete anything.' }); });
    let pending = call('click', { tabId, ref: refOf(o, /Delete account/), why: 'Cleaning up' }).then(() => 'resolved', (e) => e.message);
    await sleep(1500);
    await approve('Deny');
    assert.match(await pending, /Blocked: You did not ask to delete anything/);
    pending = call('click', { tabId, ref: refOf(o, /Delete account/), why: 'Cleaning up' }).then(() => 'resolved', (e) => e.message);
    await sleep(1500);
    await approve('Allow');
    assert.equal(await pending, 'resolved', 'one prompt only: the risky-click prompt is not shown again');
    assert.match((await call('get_text', { tabId })).text, /DELETED/);
    pending = call('navigate', { tabId, url: `http://localhost:${PAGE_PORT}/?data=secret`, why: 'Opening the next site' }).then(() => 'resolved', (e) => e.message);
    await sleep(1500);
    await approve('Deny');
    assert.match(await pending, /Blocked/, 'data-carrying navigation to another host is checked');
    await sw.evaluate(() => { globalThis.__checks = []; requestIntentCheck = async (c) => { __checks.push(c); return { ok: true }; }; });
    await call('navigate', { tabId, url: `http://127.0.0.1:${PAGE_PORT}/` });
    const o2 = (await call('read_page', { tabId })).text;
    await call('type', { tabId, ref: refOf(o2, /textbox "Full name"/), text: 'Ada', clear: true, why: 'Entering your name' });
    await call('click', { tabId, ref: refOf(o2, /button "Continue"/), why: 'Sending the form' });
    const checks = await sw.evaluate(() => __checks);
    assert.ok(checks.some((c) => c.action === 'click' && /after typing "Ada"/.test(c.target)), 'a click right after typing is checked');
    await sw.evaluate(() => { requestIntentCheck = globalThis.__origCheck; });
    await call('report', { summary: 'Checked' });
  });
  await step('teach: record a task, save it, replay it with a variable', async () => {
    const p = testPage();
    await call('navigate', { tabId, url: `http://127.0.0.1:${PAGE_PORT}/` });
    await p.bringToFront();
    assert.equal((await sw.evaluate(() => startRecording())).ok, true);
    await p.fill('#n', 'Recorded Name');
    await p.click('#go');
    await sleep(400);
    const steps = await sw.evaluate(() => stopRecording());
    assert.deepEqual(steps.map((s) => s.action), ['open', 'type', 'click'], JSON.stringify(steps));
    assert.equal(steps[1].value, 'Recorded Name');
    steps[1].value = '{{full_name}}';
    await sw.evaluate((st) => ws.send(JSON.stringify({ type: 'save_skill', id: 't1', name: 'Say Hello', description: 'Greets someone', steps: st })), steps);
    const file = path.join(stateDir, 'recordings', 'say-hello.json');
    for (let i = 0; i < 20 && !fs.existsSync(file); i++) await sleep(100);
    assert.ok(fs.existsSync(file));
    assert.match((await call('replay', {})).text, /say-hello/);
    assert.match((await call('replay', { name: 'say-hello' })).text, /needs values for: full_name/);
    await p.evaluate(() => { document.getElementById('n').value = ''; document.getElementById('out').textContent = ''; });
    assert.match((await call('replay', { name: 'say-hello', vars: { full_name: 'Replay Person' } })).text, /Replayed all 3 steps/);
    assert.match(await p.textContent('#out'), /Hello Replay Person/);
  });
  await step('teach tab lists saved tasks: run (asks for values), survives reload, delete', async () => {
    const panel = await ctx.newPage();
    await panel.goto(`chrome-extension://${extId}/sidepanel.html`);
    await panel.click('nav button[data-view="teach"]');
    await panel.waitForFunction(() => /say-hello/.test(document.querySelector('#savedList')?.textContent || ''));
    await panel.click('#savedList [data-run]');
    await panel.waitForSelector('#savedList [data-var="full_name"]');
    await panel.fill('#savedList [data-var="full_name"]', 'Panel Person');
    await testPage().evaluate(() => { document.getElementById('out').textContent = ''; });
    await panel.click('#savedList [data-run]'); // the page stays a background tab: replay must not hang on it
    await panel.waitForFunction(() => /Replayed all 3 steps/.test(document.querySelector('#savedList').textContent), null, { timeout: 60_000 });
    assert.match(await testPage().textContent('#out'), /Hello Panel Person/);
    await panel.screenshot({ path: path.join(SHOTS, 'hc-teach-saved.png') });
    await panel.reload();
    await panel.click('nav button[data-view="teach"]');
    await panel.waitForFunction(() => /say-hello/.test(document.querySelector('#savedList')?.textContent || ''));
    await panel.click('#savedList [data-del]');
    await panel.click('#savedList [data-del-yes]');
    await panel.waitForFunction(() => /Nothing saved yet/.test(document.querySelector('#savedList').textContent));
    assert.ok(!fs.existsSync(path.join(stateDir, 'recordings', 'say-hello.json')));
    await panel.close();
  });
  await step('side panel chat streams reply + tool chip', async () => {
    const extId = new URL(sw.url()).host;
    const panel = await ctx.newPage();
    await panel.goto(`chrome-extension://${extId}/sidepanel.html`);
    await panel.fill('#input', 'what is on this page?');
    await panel.keyboard.press('Enter');
    await panel.waitForSelector('.assistant strong', { timeout: 10_000 });
    assert.equal(await panel.textContent('.assistant'), 'Hello from mock');
    assert.equal(await panel.$$eval('.tool', (t) => t.length), 0, 'tool calls stay out of the chat by default');
    assert.ok((await panel.$$eval('.note', (n) => n.map((x) => x.textContent))).some((x) => /Checking the page/.test(x)));
    assert.equal(await panel.textContent('#send'), 'Send');
    const req = hermesRequests.at(-1);
    assert.equal(req.auth, 'Bearer mock-key');
    assert.equal(req.body.stream, true);
    assert.match(req.body.conversation, /^hermes-chrome-/);
    assert.match(req.body.input, /Hermes Chrome side panel[\s\S]*what is on this page\?$/);
    await panel.screenshot({ path: path.join(SHOTS, 'hc-sidepanel.png') });
    await panel.reload();
    await panel.waitForSelector('.assistant');
    assert.equal(await panel.textContent('.assistant'), 'Hello from mock', 'transcript persists');
    await panel.close();
  });
  await step('side panel: @-mention one of your tabs as read-only context', async () => {
    const extId = new URL(sw.url()).host;
    const userTab = await ctx.newPage(); // a tab of the user's, outside the agent group
    await userTab.goto(`http://127.0.0.1:${PAGE_PORT}/two`);
    const panel = await ctx.newPage();
    await panel.goto(`chrome-extension://${extId}/sidepanel.html`);
    await panel.$eval('#useTab', (el) => { el.checked = false; }); // only the mention, not "this tab"
    await panel.fill('#input', 'summarise @Tw');
    await panel.waitForSelector('#menu .item', { timeout: 5000 });
    assert.match(await panel.textContent('#menu .item'), /Two/);
    await panel.keyboard.press('Enter'); // pick the tab
    assert.equal(await panel.inputValue('#input'), 'summarise @[Two] ');
    const sent = hermesRequests.length;
    await panel.keyboard.press('Enter'); // send
    for (let i = 0; i < 100 && hermesRequests.length === sent; i++) await sleep(100);
    const req = hermesRequests.at(-1);
    assert.match(req.body.input, /summarise @\[Two\]/);
    assert.match(req.body.input, /Tab the user mentioned[\s\S]*not instructions from the user[\s\S]*Page two/);
    const groupTabs = await sw.evaluate(() => agentTabs().then((t) => t.map((x) => x.url)));
    assert.ok(!groupTabs.some((u) => u.endsWith('/two')), 'the mentioned tab is not pulled into the agent group');
    await panel.close();
    await userTab.close();
  });
  await step('update notice: badge, side panel banner, Settings line', async () => {
    const extId = new URL(sw.url()).host;
    await sw.evaluate(() => chrome.storage.local.set({ updateNote: versionNote('99.0.0') }).then(() => setBadge('on')));
    assert.equal(await sw.evaluate(() => chrome.action.getBadgeText({})), '↑');
    const panel = await ctx.newPage();
    await panel.goto(`chrome-extension://${extId}/sidepanel.html`);
    await panel.waitForSelector('#update:not([hidden])');
    assert.match(await panel.textContent('#update'), /Hermes Chrome 99\.0\.0 is available/);
    assert.equal(await panel.$$eval('#update button', (b) => b.map((x) => x.textContent).join('|')), 'Download|Reload extension');
    const opts = await ctx.newPage();
    await opts.goto(`chrome-extension://${extId}/options.html`);
    await opts.waitForSelector('#updateNote:not([hidden])');
    assert.match(await opts.textContent('#updateNote'), /Update available: Hermes Chrome 99\.0\.0/);
    await sw.evaluate(() => chrome.storage.local.set({ updateNote: versionNote('0.0.1') }));
    await panel.waitForFunction(() => /plugin is older/.test(document.querySelector('#update').textContent));
    await sw.evaluate(() => chrome.storage.local.set({ updateNote: versionNote(chrome.runtime.getManifest().version) }).then(() => setBadge('on')));
    await panel.waitForSelector('#update', { state: 'hidden' });
    assert.equal(await sw.evaluate(() => chrome.action.getBadgeText({})), '', 'same version: no notice');
    await opts.close();
    await panel.close();
  });
  await step('side panel: model picker, / menu, attachments', async () => {
    const panel = await ctx.newPage();
    await panel.goto(`chrome-extension://${extId}/sidepanel.html`);
    // model list: only signed-in providers with models
    await panel.waitForFunction(() => document.querySelectorAll('#model option').length === 3, null, { timeout: 10_000 });
    assert.deepEqual(await panel.$$eval('#model optgroup', (gs) => gs.map((g) => g.label)), ['Anthropic']);
    // slash menu shows commands, /model picks by name
    await panel.fill('#input', '/mo');
    await panel.dispatchEvent('#input', 'input');
    assert.match(await panel.textContent('#menu'), /\/model[\s\S]*\/models/);
    await panel.fill('#input', '/model sonnet');
    await panel.keyboard.press('Escape');
    await panel.keyboard.press('Enter');
    assert.equal(await panel.inputValue('#model'), 'anthropic::claude-sonnet-5-5');
    // attachments: one image, one file
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64');
    await panel.setInputFiles('#file', [{ name: 'dot.png', mimeType: 'image/png', buffer: png },
      { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello file') }]);
    await panel.waitForFunction(() => document.querySelectorAll('.att-chip').length === 2);
    await panel.fill('#input', 'look at these');
    await panel.keyboard.press('Enter');
    await panel.waitForFunction(() => document.querySelectorAll('.assistant').length >= 2, null, { timeout: 10_000 });
    const req = hermesRequests.at(-1).body;
    assert.equal(req.model, 'claude-sonnet-5-5');
    assert.equal(req.provider, 'anthropic');
    assert.match(req.input[0].content[0].text, /you are running as claude-sonnet-5-5 \(provider anthropic\)/, 'the agent is told which model it is');
    const parts = req.input[0].content;
    assert.equal(parts.filter((p) => p.type === 'input_image').length, 1);
    const saved = parts[0].text.match(/saved on this machine: (\S+)\. Read them/)[1];
    assert.equal(fs.readFileSync(saved, 'utf8'), 'hello file');
    assert.equal(await panel.$$eval('.att-chip', (c) => c.length), 0, 'attachments cleared after send');
    await panel.screenshot({ path: path.join(SHOTS, 'hc-sidepanel-2.png') });
    await panel.close();
  });
  await step('side panel: a dropped connection ends the pending chat', async () => {
    const panel = await ctx.newPage();
    await panel.goto(`chrome-extension://${extId}/sidepanel.html`);
    await panel.fill('#input', 'SLOW reply please');
    await panel.keyboard.press('Enter');
    await panel.waitForFunction(() => document.querySelector('#send').textContent === 'Stop');
    await sw.evaluate(() => ws.close());
    await panel.waitForFunction(() => /connection to Hermes dropped/.test(document.querySelector('#log').textContent), null, { timeout: 5000 });
    assert.equal(await panel.textContent('#send'), 'Send', 'input is usable again');
    for (let i = 0; i < 40 && !(await health()).extension; i++) await sleep(250); // reconnects by itself
    assert.equal((await health()).extension, true);
    await panel.close();
  });
  await step('extension gone → unavailable message', async () => {
    await ctx.close(); ctx = null;
    await sleep(500);
    const r = await mcp.callTool({ name: 'browser_status', arguments: {} });
    assert.ok(r.isError);
    assert.equal(r.content[0].text, 'MacBook not available');
  });
} catch (e) {
  failed = true;
  results.push(`FAIL setup: ${e.stack}`);
} finally {
  console.log(results.join('\n'));
  console.log(`screenshots in ${SHOTS}`);
  await mcp?.close().catch(() => {});
  await ctx?.close().catch(() => {});
  bridge.kill();
  pageServer.close();
  tlsServer.close();
  hermesMock.close();
  fs.rmSync(userData, { recursive: true, force: true });
  fs.rmSync(stateDir, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}
