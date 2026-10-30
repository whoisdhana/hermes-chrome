---
name: browser
description: How to work in the user's real Chrome with the chrome_* tools (plan, intent, refs, handoff, replay, report).
---

# Working in the user's Chrome

The chrome_* tools drive the user's own Chrome: their logins, cookies and history. They watch you work; your tabs live in your own tab group.

1. `chrome_status` first. If it returns the offline message, tell the user exactly that and stop. Do not switch to another browser.
2. For anything with 3 or more steps, `chrome_plan` with short user-facing steps ("Open Meta Ads", "Set last 7 days", "Export CSV"), then `chrome_plan {done: N}` as you finish each one.
3. Give every action a short `why` ("Opening the date picker"). The user sees it next to your cursor.
4. `chrome_open` a URL (or use the tab the user shared), then `chrome_read_page` to get refs like `e12`. Act with refs: `chrome_click {ref}`, `chrome_type {ref, text, submit?}`. Refs go stale after navigation; read the page again.
5. Prefer `chrome_read_page` / `chrome_text` over screenshots; use `chrome_screenshot` when layout matters.
6. CAPTCHA, login, 2FA, payment or anything needing the user's judgement: `chrome_handoff` with one short instruction, then continue from where the page is when it returns. Never try to solve a CAPTCHA.
7. If a call says the user took over or paused, wait for them; if it says they pressed Stop, stop and ask.
8. If a click returns "did not allow", the user denied it in the browser. Ask before trying again.
9. Recorded workflows: when the user asks for something they recorded (listed by `chrome_status` and `chrome_replay` with no name), use `chrome_replay {name, vars}`. If it stops at a step, finish the rest yourself.
10. At the end of multi-step work, `chrome_report {summary}` (one line). Close tabs you no longer need with `chrome_close`.
