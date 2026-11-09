// Approval window: every Allow / Deny decision is made here, in a window the extension owns, never in the web
// page (a page could hide or fake buttons drawn inside it). The background passes the question through session
// storage under the id in the URL and waits for the answer message.
const id = new URLSearchParams(location.search).get('id');
const $ = (x) => document.getElementById(x);

chrome.storage.session.get(`approval:${id}`).then((store) => {
  const q = store[`approval:${id}`];
  if (!q) { $('msg').textContent = 'This request is no longer waiting.'; setTimeout(() => window.close(), 1500); return; }
  $('site').textContent = q.site || '';
  $('msg').textContent = q.message;
  const buttons = q.choices.map((c) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = c.label;
    if (c.primary) b.className = 'primary';
    b.disabled = true; // a short pause so a click already on its way cannot land on a button by accident
    b.onclick = () => { chrome.runtime.sendMessage({ approval: id, answer: c.value }); window.close(); };
    $('acts').appendChild(b);
    return b;
  });
  setTimeout(() => { buttons.forEach((b) => { b.disabled = false; }); buttons[0].focus(); }, 400); // the first choice (deny) has focus
});
