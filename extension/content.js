// Hermes Chrome — in-page side.
// 1. Page model: outline/find/text with stable element refs ("e12").
// 2. Overlay: animated agent cursor, click ripple, target highlight, activity glow, toasts, handoff banner.
// Runs in the extension's isolated world; the background worker calls API functions via messages.
(() => {
  if (window.__hermesChrome) return;
  window.__hermesChrome = true;

  const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const CURSOR_KEY = 'hermes-chrome-cursor';
  let agentName = 'Hermes';

  // ------------------------------------------------------------ element refs
  const refToEl = new Map();
  const elToRef = new WeakMap();
  let refSeq = 0;
  function refFor(el) {
    let r = elToRef.get(el);
    if (!r) { r = `e${++refSeq}`; elToRef.set(el, r); refToEl.set(r, new WeakRef(el)); }
    return r;
  }
  function elFor(ref) {
    const el = refToEl.get(ref)?.deref();
    if (!el || !el.isConnected) throw new Error(`Ref ${ref} is stale or unknown; call read_page again`);
    return el;
  }

  const INTERACTIVE_ROLES = new Set(['button', 'link', 'checkbox', 'radio', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
    'option', 'switch', 'combobox', 'textbox', 'searchbox', 'slider', 'spinbutton', 'listbox', 'treeitem']);

  function isVisible(el) {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05;
  }

  function roleOf(el) {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      const t = (el.type || 'text').toLowerCase();
      if (['button', 'submit', 'reset', 'image'].includes(t)) return 'button';
      if (t === 'checkbox' || t === 'radio') return t;
      if (t === 'range') return 'slider';
      if (t === 'search') return 'searchbox';
      return 'textbox';
    }
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (el.isContentEditable) return 'textbox';
    return tag;
  }

  function isInteractive(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'input') return el.type !== 'hidden';
    if (['a', 'button', 'select', 'textarea', 'summary'].includes(tag)) return tag !== 'a' || el.hasAttribute('href');
    if (INTERACTIVE_ROLES.has(el.getAttribute('role'))) return true;
    if (el.isContentEditable && el.getAttribute('contenteditable') !== null) return true;
    const ti = el.getAttribute('tabindex');
    return (ti !== null && Number(ti) >= 0) || el.hasAttribute('onclick');
  }

  const clip = (s, n = 80) => { s = (s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

  function nameOf(el) {
    const aria = el.getAttribute('aria-label');
    if (aria) return clip(aria);
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const t = by.split(/\s+/).map((id) => document.getElementById(id)?.innerText || '').join(' ');
      if (t.trim()) return clip(t);
    }
    if (el.id && (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA')) {
      const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (label?.innerText.trim()) return clip(label.innerText);
    }
    const wrap = el.closest('label');
    if (wrap && wrap !== el && wrap.innerText.trim()) return clip(wrap.innerText);
    return clip(el.getAttribute('placeholder') || el.getAttribute('alt') || el.getAttribute('title') || el.innerText || el.value || '');
  }

  function stateOf(el) {
    const bits = [];
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      if (el.type === 'checkbox' || el.type === 'radio') bits.push(el.checked ? 'checked' : 'unchecked');
      else if (el.type === 'password') { if (el.value) bits.push('value=•••'); }
      else if (el.value) bits.push(`value="${clip(el.value, 40)}"`);
      if (el.placeholder && nameOf(el) !== clip(el.placeholder)) bits.push(`placeholder="${clip(el.placeholder, 40)}"`);
    }
    if (el.tagName === 'SELECT') bits.push(`selected="${clip(el.selectedOptions[0]?.text || '', 40)}"`);
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') bits.push('disabled');
    if (el.getAttribute('aria-expanded')) bits.push(`expanded=${el.getAttribute('aria-expanded')}`);
    const r = el.getBoundingClientRect();
    if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) bits.push('offscreen');
    return bits.length ? ' ' + bits.join(' ') : '';
  }

  // Walk light DOM and open shadow roots in document order.
  function* walk(root) {
    const kids = root.children || [];
    for (const el of kids) {
      if (el.tagName === 'HERMES-CHROME-OVERLAY') continue;
      yield el;
      if (el.shadowRoot) yield* walk(el.shadowRoot);
      yield* walk(el);
    }
  }

  function collect(interactiveOnly) {
    const out = [];
    for (const el of walk(document.body || document.documentElement)) {
      const tag = el.tagName.toLowerCase();
      const textual = !interactiveOnly && (/^h[1-6]$/.test(tag) || ((tag === 'p' || tag === 'li') && el.innerText.trim().length > 20));
      if (!(isInteractive(el) || textual)) continue;
      if (!isVisible(el)) continue;
      out.push(el);
      if (out.length >= 500) break;
    }
    return out;
  }

  const line = (el) => {
    const role = roleOf(el);
    const name = role === 'p' || role === 'li' ? clip(el.innerText, 160) : nameOf(el);
    return `${refFor(el)} ${role}${name ? ` "${name}"` : ''}${stateOf(el)}`;
  };

  // ------------------------------------------------------------ overlay
  let host, ui;
  function overlay() {
    if (host?.isConnected) return ui;
    host = document.createElement('hermes-chrome-overlay');
    host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `
      <style>
        :host { all: initial; }
        * { box-sizing: border-box; font-family: ui-sans-serif, -apple-system, "Segoe UI", sans-serif; }
        .glow { position: fixed; inset: 0; pointer-events: none; opacity: 0; transition: opacity .5s;
          box-shadow: inset 0 0 0 2px rgba(186,88,61,.85), inset 0 0 28px rgba(186,88,61,.35); }
        .glow.on { opacity: 1; animation: breathe 2.4s ease-in-out infinite; }
        @keyframes breathe { 50% { box-shadow: inset 0 0 0 2px rgba(186,88,61,.55), inset 0 0 14px rgba(186,88,61,.18); } }
        .cursor { position: fixed; left: 0; top: 0; width: 26px; height: 26px; opacity: 0; transition: opacity .3s; will-change: transform; }
        .cursor.on { opacity: 1; }
        .cursor svg { width: 26px; height: 26px; filter: drop-shadow(0 2px 3px rgba(0,0,0,.35)); transition: transform .12s; transform-origin: 3px 3px; }
        .cursor.press svg { transform: scale(.82); }
        .plan { position: fixed; top: 10px; left: 50%; transform: translate(-50%, -12px); width: min(520px, calc(100vw - 24px));
          pointer-events: auto; background: #FFFDFA; color: #35302A; border: 1px solid #E7D6C8; border-radius: 12px;
          box-shadow: 0 8px 26px rgba(53,48,42,.18); padding: 8px 10px 9px 12px; opacity: 0; transition: opacity .25s, transform .25s; }
        .plan.on { opacity: 1; transform: translate(-50%, 0); }
        .plan .row { display: flex; align-items: center; gap: 8px; font-size: 12.5px; }
        .plan .who { font-weight: 800; color: #BA583D; }
        .plan .now { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .plan .count { color: #8A7E73; font-variant-numeric: tabular-nums; }
        .plan button { all: unset; cursor: pointer; width: 26px; height: 26px; display: grid; place-items: center; border-radius: 7px;
          color: #35302A; font-size: 13px; }
        .plan button:hover { background: #F3E9DF; }
        .plan button:focus-visible { outline: 2px solid #BA583D; }
        .plan .bar { height: 3px; margin-top: 7px; background: #F0E4D9; border-radius: 3px; overflow: hidden; }
        .plan .bar i { display: block; height: 100%; width: 0; background: #BA583D; border-radius: 3px; transition: width .5s ease; }
        .plan.paused { border-color: #BA583D; }
        .plan .rec { width: 8px; height: 8px; border-radius: 50%; background: #DC2626; animation: blink 1.2s infinite; }
        @keyframes blink { 50% { opacity: .3; } }
        .scan { position: fixed; left: 0; right: 0; top: 0; height: 90px; pointer-events: none;
          background: linear-gradient(to bottom, rgba(186,88,61,0), rgba(186,88,61,.10) 70%, rgba(186,88,61,.45));
          border-bottom: 1px solid rgba(186,88,61,.6); animation: scan .8s ease-in-out forwards; }
        @keyframes scan { from { transform: translateY(-90px); opacity: 1; } 85% { opacity: 1; } to { transform: translateY(100vh); opacity: 0; } }
        .flash { position: fixed; border: 2px dashed #DC2626; border-radius: 6px; animation: hl .9s ease-out forwards; }
        .ripple { position: fixed; width: 14px; height: 14px; margin: -7px 0 0 -7px; border-radius: 50%; border: 2px solid #BA583D;
          animation: ripple .6s ease-out forwards; }
        @keyframes ripple { to { transform: scale(4.5); opacity: 0; } }
        .hl { position: fixed; border: 2px solid #BA583D; border-radius: 6px; background: rgba(186,88,61,.10);
          animation: hl 1.1s ease-out forwards; }
        .hl.typing { animation: typing 1s ease-in-out infinite; }
        @keyframes hl { 0% { opacity: 0; transform: scale(1.06); } 15% { opacity: 1; transform: scale(1); } 75% { opacity: 1; } 100% { opacity: 0; } }
        @keyframes typing { 50% { background: rgba(186,88,61,.22); } }
        .toast { position: fixed; top: 14px; left: 50%; transform: translate(-50%, -8px); max-width: min(560px, 90vw);
          padding: 7px 14px; border-radius: 999px; background: rgba(28,25,23,.92); color: #FAFAF9; font-size: 12.5px;
          opacity: 0; transition: opacity .25s, transform .25s; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .toast.on { opacity: 1; transform: translate(-50%, 0); }
        .toast b { color: #E9A58F; }
        .handoff { position: fixed; left: 50%; bottom: 22px; transform: translateX(-50%); width: min(520px, calc(100vw - 32px));
          pointer-events: auto; background: #1C1917; color: #FAFAF9; border: 2px solid #BA583D; border-radius: 14px;
          padding: 14px 16px; box-shadow: 0 12px 40px rgba(0,0,0,.45); display: flex; gap: 12px; align-items: center;
          animation: rise .35s cubic-bezier(.2,.9,.3,1.2); }
        @keyframes rise { from { transform: translate(-50%, 30px); opacity: 0; } }
        .handoff .msg { flex: 1; font-size: 13.5px; line-height: 1.4; }
        .handoff .who { display: block; font-size: 11px; font-weight: 700; color: #E9A58F; margin-bottom: 2px; letter-spacing: .02em; }
        .handoff button { all: unset; cursor: pointer; padding: 8px 14px; border-radius: 9px; font-size: 13px; font-weight: 700; }
        .handoff .done { background: #BA583D; color: #FBF1E6; }
        .handoff .skip { color: #A8A29E; }
        .handoff button:focus-visible { outline: 2px solid #E9A58F; outline-offset: 2px; }
      </style>
      <div class="glow"></div>
      <div class="cursor"><svg viewBox="0 0 26 26"><path d="M3 2.5 L3 20 L8 15.5 L11.2 22.5 L14.3 21.1 L11.2 14.3 L18 14.3 Z"
        fill="#35302A" stroke="#FFFFFF" stroke-width="1.6" stroke-linejoin="round"/></svg></div>
      <div class="plan" role="status"><div class="row"><span class="who"></span><span class="now"></span><span class="count"></span>
        <button class="pause" type="button" aria-label="Pause">⏸</button><button class="stop" type="button" aria-label="Stop this task">✕</button></div>
        <div class="bar"><i></i></div></div>
      <div class="toast"></div>`;
    document.documentElement.appendChild(host);
    ui = {
      root,
      glow: root.querySelector('.glow'),
      cursor: root.querySelector('.cursor'),
      plan: root.querySelector('.plan'),
      toast: root.querySelector('.toast'),
    };
    ui.plan.querySelector('.pause').onclick = () => chrome.runtime.sendMessage({ hud: ui.plan.classList.contains('paused') ? 'resume' : 'pause' });
    ui.plan.querySelector('.stop').onclick = () => chrome.runtime.sendMessage({ hud: 'stop' });
    if (hudState) renderHud(hudState);
    const saved = JSON.parse(sessionStorage.getItem(CURSOR_KEY) || 'null');
    pos = saved || { x: innerWidth / 2, y: innerHeight - 80 };
    place(pos.x, pos.y);
    return ui;
  }

  let pos = { x: 0, y: 0 };
  function place(x, y) {
    pos = { x, y };
    ui.cursor.style.transform = `translate(${x - 3}px, ${y - 3}px)`;
  }
  const saveCursor = () => { try { sessionStorage.setItem(CURSOR_KEY, JSON.stringify(pos)); } catch {} };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

  let idleTimer;
  function active() {
    const u = overlay();
    u.glow.classList.add('on');
    u.cursor.classList.add('on');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => u.glow.classList.remove('on'), 2500);
  }

  // Move along a gentle arc (quadratic Bézier) with ease-in-out; duration scales with distance.
  function cursorTo(x, y) {
    const u = overlay();
    active();
    const from = { ...pos };
    const dx = x - from.x, dy = y - from.y, dist = Math.hypot(dx, dy);
    // Hidden tabs get no animation frames: jump instead of waiting forever.
    if (dist < 2 || REDUCED || document.hidden) { place(x, y); saveCursor(); return Promise.resolve(); }
    const dur = Math.min(900, Math.max(280, 220 + dist * 0.55));
    const bend = Math.min(120, dist * 0.18);
    const cx = from.x + dx / 2 - (dy / dist) * bend, cy = from.y + dy / 2 + (dx / dist) * bend;
    return new Promise((resolve) => {
      const t0 = performance.now();
      let finished = false;
      const finish = () => { if (finished) return; finished = true; place(x, y); saveCursor(); resolve(); };
      setTimeout(finish, dur + 300); // the tab may be hidden mid-flight
      const step = (now) => {
        if (finished) return;
        const t = Math.min(1, (now - t0) / dur), e = ease(t), k = 1 - e;
        place(k * k * from.x + 2 * k * e * cx + e * e * x, k * k * from.y + 2 * k * e * cy + e * e * y);
        if (t < 1) requestAnimationFrame(step); else finish();
      };
      requestAnimationFrame(step);
    });
  }

  async function press(x, y) {
    const u = overlay();
    active();
    u.cursor.classList.add('press');
    const r = document.createElement('div');
    r.className = 'ripple';
    r.style.left = `${x}px`; r.style.top = `${y}px`;
    u.root.appendChild(r);
    setTimeout(() => r.remove(), 650);
    await sleep(110);
    u.cursor.classList.remove('press');
  }

  function highlight(el, typing = false) {
    const u = overlay();
    const r = el.getBoundingClientRect();
    const box = document.createElement('div');
    box.className = typing ? 'hl typing' : 'hl';
    Object.assign(box.style, { left: `${r.left - 4}px`, top: `${r.top - 4}px`, width: `${r.width + 8}px`, height: `${r.height + 8}px` });
    u.root.appendChild(box);
    if (!typing) setTimeout(() => box.remove(), 1150);
    return box;
  }

  let toastTimer;
  function toast(html, ms = 2200) {
    const u = overlay();
    u.toast.innerHTML = html;
    u.toast.classList.add('on');
    clearTimeout(toastTimer);
    if (ms) toastTimer = setTimeout(() => u.toast.classList.remove('on'), ms);
  }
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

  let typingBox = null;

  // ------------------------------------------------------------ plan strip (HUD)
  // state: {agent, active, paused, recording, plan: {steps, done}}
  let hudState = null;
  function renderHud(s) {
    hudState = s;
    if (!ui) return;
    const p = ui.plan;
    const steps = s.plan?.steps || [];
    const done = Math.min(s.plan?.done || 0, steps.length);
    const show = s.recording || s.paused || (s.active && steps.length);
    p.classList.toggle('on', !!show);
    p.classList.toggle('paused', !!s.paused);
    p.querySelector('.who').innerHTML = s.recording ? '<span class="rec"></span>' : esc(s.agent || agentName);
    p.querySelector('.now').textContent = s.recording ? `Recording… ${s.recordedCount || 0} steps`
      : s.paused ? (s.pausedReason || 'Paused. Press ▶ to let it continue.')
      : steps[done] || (steps.length ? 'Wrapping up' : '');
    p.querySelector('.count').textContent = steps.length && !s.recording ? `${Math.min(done + 1, steps.length)}/${steps.length}` : '';
    p.querySelector('.bar i').style.width = steps.length ? `${(done / steps.length) * 100}%` : '0';
    const btn = p.querySelector('.pause');
    btn.textContent = s.paused ? '▶' : '⏸';
    btn.setAttribute('aria-label', s.paused ? 'Resume' : 'Pause');
    btn.hidden = !!s.recording;
    p.querySelector('.stop').setAttribute('aria-label', s.recording ? 'Stop recording' : 'Stop this task');
  }

  function readingSweep() {
    if (REDUCED) return;
    const u = overlay();
    active();
    const s = document.createElement('div');
    s.className = 'scan';
    u.root.appendChild(s);
    setTimeout(() => s.remove(), 900);
  }

  // ------------------------------------------------------------ takeover detection
  // While the agent works in this tab, a real click or key press that is not the agent's own (it
  // sets `acting` around every injected event) means the human grabbed the wheel: pause the agent.
  // Moving the mouse or scrolling to read does not count.
  let acting = false, actingDepth = 0, watching = false, tookOver = false;
  function onHumanInput(e) {
    if (!watching || acting || tookOver || !e.isTrusted || e.composedPath?.().includes(host)) return;
    if (e.type === 'keydown' && ['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return; // e.g. the ⌥⇧. shortcut itself
    tookOver = true;
    chrome.runtime.sendMessage({ takeover: true, by: e.type }).catch(() => {});
  }
  for (const t of ['mousedown', 'keydown']) addEventListener(t, onHumanInput, { capture: true, passive: true });

  // ------------------------------------------------------------ recorder (teach mode)
  let recording = false;
  // Fields whose values are never stored in a recording (replay hands them to the human instead).
  const SECRET = /pass|pwd|otp|token|secret|cvv|cvc|csc|pin\b|card|ccnum|iban|ssn|social.?sec|account.?(num|no)|routing|tax.?id|pan\b|aadhaar/i;
  function cssPath(el) {
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && parts.length < 6; n = n.parentElement) {
      if (n.id && !/\d{3,}/.test(n.id)) { parts.unshift(`#${CSS.escape(n.id)}`); break; }
      const sibs = n.parentElement ? [...n.parentElement.children].filter((c) => c.tagName === n.tagName) : [];
      parts.unshift(sibs.length > 1 ? `${n.tagName.toLowerCase()}:nth-of-type(${sibs.indexOf(n) + 1})` : n.tagName.toLowerCase());
    }
    return parts.join(' > ');
  }
  function describe(el) {
    const t = el.closest('a,button,input,select,textarea,summary,label,[role],[onclick],[contenteditable="true"]') || el;
    return {
      role: roleOf(t), name: nameOf(t), tag: t.tagName.toLowerCase(),
      id: t.id && !/\d{3,}/.test(t.id) ? t.id : undefined,
      testid: t.getAttribute('data-testid') || t.getAttribute('data-test') || t.getAttribute('data-qa') || undefined,
      nameAttr: t.getAttribute('name') || undefined, placeholder: t.getAttribute('placeholder') || undefined,
      href: t.tagName === 'A' ? t.getAttribute('href') : undefined, css: cssPath(t),
    };
  }
  function flash(el) {
    const u = overlay();
    const r = el.getBoundingClientRect();
    const b = document.createElement('div');
    b.className = 'flash';
    Object.assign(b.style, { left: `${r.left - 3}px`, top: `${r.top - 3}px`, width: `${r.width + 6}px`, height: `${r.height + 6}px` });
    u.root.appendChild(b);
    setTimeout(() => b.remove(), 950);
  }
  const record = (step, el) => { if (el) flash(el); chrome.runtime.sendMessage({ recorded: { ...step, url: location.href, t: Date.now() } }).catch(() => {}); };
  function onRecClick(e) {
    if (!recording || !e.isTrusted || e.composedPath?.().includes(host)) return;
    const el = e.target;
    if (el.closest?.('input,textarea,select') && !/^(button|submit|checkbox|radio|reset)$/i.test(el.type || '')) return; // typing is recorded on change
    record({ action: 'click', target: describe(el) }, el.closest('a,button,[role],input,label,summary') || el);
  }
  function onRecChange(e) {
    if (!recording || !e.isTrusted) return;
    const el = e.target;
    if (el.tagName === 'SELECT') return record({ action: 'select', target: describe(el), value: el.value, label: el.selectedOptions[0]?.text }, el);
    if (/^(checkbox|radio|button|submit|file)$/i.test(el.type || '')) return;
    if (el.matches?.('input,textarea')) {
      const secret = el.type === 'password' || /^(cc-|one-time-code|new-password|current-password)/.test(el.autocomplete || '')
        || SECRET.test(`${el.name} ${el.id} ${el.autocomplete} ${el.getAttribute('aria-label') || ''} ${el.placeholder || ''}`);
      record({ action: 'type', target: describe(el), value: secret ? '{{password}}' : el.value, secret }, el);
    }
  }
  function onRecKey(e) {
    if (!recording || !e.isTrusted || !['Enter', 'Escape', 'Tab'].includes(e.key)) return;
    const el = e.target;
    if (e.key === 'Enter' && el.matches?.('input,textarea')) onRecChange({ isTrusted: true, target: el }); // capture the value before Enter submits
    record({ action: 'key', key: e.key, target: el && el !== document.body ? describe(el) : undefined });
  }
  addEventListener('click', onRecClick, true);
  addEventListener('change', onRecChange, true);
  addEventListener('keydown', onRecKey, true);

  // ------------------------------------------------------------ replay: find a recorded element again
  function matchTarget(t) {
    const visible = (el) => el && el.isConnected && isVisible(el);
    const by = [
      () => t.id && document.getElementById(t.id),
      () => t.testid && document.querySelector(`[data-testid="${CSS.escape(t.testid)}"],[data-test="${CSS.escape(t.testid)}"],[data-qa="${CSS.escape(t.testid)}"]`),
      () => t.nameAttr && document.querySelector(`${t.tag}[name="${CSS.escape(t.nameAttr)}"]`),
      () => t.name && collect(false).find((el) => roleOf(el) === t.role && nameOf(el) === t.name),
      () => t.placeholder && document.querySelector(`[placeholder="${CSS.escape(t.placeholder)}"]`),
      () => t.href && document.querySelector(`a[href="${CSS.escape(t.href)}"]`),
      () => { try { return t.css && document.querySelector(t.css); } catch { return null; } },
      () => t.name && collect(false).find((el) => nameOf(el).toLowerCase() === t.name.toLowerCase()),
    ];
    for (const f of by) { const el = f(); if (visible(el)) return el; }
    return null;
  }

  // ------------------------------------------------------------ API (called by background.js)
  // CAPTCHA and bot challenges. The agent never solves them; it hands them to the person and notices when they are done.
  const CHALLENGE = 'iframe[src*="recaptcha"], iframe[src*="hcaptcha.com"], iframe[src*="challenges.cloudflare.com"], iframe[src*="arkoselabs"],'
    + ' iframe[src*="funcaptcha"], iframe[src*="geetest"], iframe[src*="captcha-delivery.com"], #challenge-form, #cf-challenge-running, .g-recaptcha, .h-captcha, .cf-turnstile';
  const TOKENS = 'textarea[name="g-recaptcha-response"], textarea[name="h-captcha-response"], input[name="cf-turnstile-response"]';
  function challengeState() {
    if ([...document.querySelectorAll(TOKENS)].some((t) => t.value)) return 'solved';
    const open = [...document.querySelectorAll(CHALLENGE)].some((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 20 && r.height > 20 && getComputedStyle(el).visibility !== 'hidden';
    });
    return open ? 'open' : 'none';
  }

  const API = {
    configure({ name }) { agentName = name || agentName; },

    outline({ interactiveOnly = true } = {}) {
      const els = collect(interactiveOnly);
      const head = [`Page: ${document.title} — ${location.href}`,
        `Viewport ${innerWidth}x${innerHeight}, scrolled ${Math.round(scrollY)}/${Math.max(0, document.documentElement.scrollHeight - innerHeight)}px`];
      if (!els.length) head.push('(no interactive elements found)');
      if (els.length >= 500) head.push('(truncated at 500 elements)');
      return head.concat(els.map(line)).join('\n');
    },

    find({ query }) {
      const q = query.toLowerCase();
      const hits = collect(false).filter((el) => {
        const hay = `${roleOf(el)} ${nameOf(el)} ${el.getAttribute('placeholder') || ''} ${el.getAttribute('name') || ''}`.toLowerCase();
        return hay.includes(q);
      }).slice(0, 25);
      return hits.length ? hits.map(line).join('\n') : `No elements match "${query}"`;
    },

    text({ maxChars = 20000 } = {}) {
      const t = (document.body?.innerText || '').replace(/\n{3,}/g, '\n\n');
      return `Page: ${document.title} — ${location.href}\n\n` + (t.length > maxChars ? t.slice(0, maxChars) + `\n…(truncated, ${t.length} chars total)` : t);
    },

    // What is really under (x, y) right now: the named element (or something inside it), and if it is a frame, where it points.
    hitTest({ ref, x, y }) {
      const at = document.elementFromPoint(x, y);
      if (!at) return { ok: false, frame: '' };
      const el = ref ? elFor(ref) : null;
      const ok = !el || el === at || el.contains(at) || at.contains(el);
      return { ok, frame: at.tagName === 'IFRAME' ? (at.src || '') : '' };
    },

    locate({ ref }) {
      const el = elFor(ref);
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: r.width, h: r.height, desc: line(el) };
    },

    async pointAt({ x, y, ref }) {
      if (ref) highlight(elFor(ref));
      await cursorTo(x, y);
    },

    // Mark the tab in the tab strip: a favicon with a status dot (null restores the page's own icon).
    favicon({ dataUrl }) {
      document.querySelectorAll('link[data-hermes-chrome]').forEach((l) => l.remove());
      if (!dataUrl) return;
      const link = document.createElement('link');
      link.rel = 'icon';
      link.href = dataUrl;
      link.dataset.hermesChrome = '1';
      document.head?.appendChild(link);
    },
    hud(state) { overlay(); renderHud(state); watching = !!state.active && !state.paused && !state.recording; if (!watching) tookOver = false; },
    acting({ on }) { actingDepth = Math.max(0, actingDepth + (on ? 1 : -1)); acting = actingDepth > 0; }, // nested/overlapping actions
    resetTakeover() { tookOver = false; },
    reading() { readingSweep(); },
    record({ on }) { recording = on; },

    async resolveTarget({ target, timeoutMs = 8000 }) {
      const end = Date.now() + timeoutMs;
      for (;;) {
        const el = matchTarget(target);
        if (el) return refFor(el);
        if (Date.now() > end) throw new Error(`Could not find ${target.role || target.tag} "${target.name || target.placeholder || target.css}"`);
        await sleep(250);
      }
    },

    selectOption({ ref, value }) {
      const el = elFor(ref);
      el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return el.value === value;
    },

    press({ x, y }) { return press(x, y); },

    typing({ ref, on }) {
      typingBox?.remove();
      typingBox = null;
      if (on) {
        if (ref) typingBox = highlight(elFor(ref), true);
        toast(`<b>${esc(agentName)}</b> is typing…`, 0);
      } else {
        overlay().toast.classList.remove('on');
      }
    },

    clearField({ ref }) {
      const el = elFor(ref);
      if (el.isContentEditable) el.textContent = '';
      else {
        const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, '');
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
    },

    navToast({ url }) {
      let host = url;
      try { host = new URL(url).host; } catch {}
      toast(`<b>${esc(agentName)}</b> → ${esc(host)}`, 1800);
    },

    viewport() { active(); return { w: innerWidth, h: innerHeight }; },
    scrollInfo() { return `scrolled ${Math.round(scrollX)},${Math.round(scrollY)} of ${document.documentElement.scrollWidth}x${document.documentElement.scrollHeight}`; },

    overlayVisible({ on }) { overlay(); host.style.display = on ? '' : 'none'; },

    handoff({ message, timeoutSec = 600 }) {
      const u = overlay();
      const watchChallenge = challengeState() === 'open'; // a CAPTCHA is on screen: continue by itself once it is solved
      u.root.querySelector('.handoff')?.remove();
      const box = document.createElement('div');
      box.className = 'handoff';
      box.setAttribute('role', 'alertdialog');
      box.innerHTML = `<div class="msg"><span class="who">${esc(agentName)} needs you</span>${esc(message)}</div>
        <button class="skip" type="button">Skip</button><button class="done" type="button">Done</button>`;
      u.root.appendChild(box);
      box.querySelector('.done').focus();
      return new Promise((resolve) => {
        const finish = (status) => { clearTimeout(t); box.remove(); resolve(status); };
        const t = setTimeout(() => finish('timeout'), timeoutSec * 1000);
        box.querySelector('.done').addEventListener('click', () => finish('done'));
        box.querySelector('.skip').addEventListener('click', () => finish('skipped'));
        if (watchChallenge) {
          let clear = 0;
          const poll = setInterval(() => {
            if (!box.isConnected) return clearInterval(poll);
            clear = challengeState() === 'open' ? 0 : clear + 1;
            if (clear >= 2) { clearInterval(poll); finish('solved'); } // solved (token filled in) or gone for 2 s
          }, 1000);
        }
      });
    },

    // The agent is waiting for an Allow / Deny in the extension's own window. Only a notice here: decisions are
    // never taken inside the page, which could restyle or fake its buttons.
    waiting({ message }) {
      const u = overlay();
      u.root.querySelector('.handoff')?.remove();
      const box = document.createElement('div');
      box.className = 'handoff waiting';
      box.setAttribute('role', 'status');
      box.innerHTML = `<div class="msg"><span class="who">Approval needed</span>${esc(message)}</div>`;
      u.root.appendChild(box);
    },
    waitingDone() { overlay().root.querySelector('.handoff.waiting')?.remove(); },
  };

  chrome.storage?.local.get({ agentName: 'Hermes' }).then((s) => API.configure({ name: s.agentName })).catch(() => {});

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.hc !== 1 || !API[msg.fn]) return;
    Promise.resolve()
      .then(() => API[msg.fn](msg.args || {}))
      .then((r) => sendResponse({ ok: true, r }), (e) => sendResponse({ ok: false, e: String(e?.message || e) }));
    return true;
  });
})();
