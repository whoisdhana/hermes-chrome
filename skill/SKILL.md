---
name: browser
description: How to work in the user's real Chrome with the chrome_* tools (plan, intent, refs, handoff, replay, report, extract and export research data).
---

# Working in the user's Chrome

The chrome_* tools drive the user's own Chrome: their logins, cookies and history. They watch you work; your tabs live in your own tab group.

1. `chrome_status` first. If it returns the offline message, tell the user exactly that and stop. Do not switch to another browser.
2. For anything with 3 or more steps, `chrome_plan` with short user-facing steps ("Open Meta Ads", "Set last 7 days", "Export CSV"), then `chrome_plan {done: N}` as you finish each one.
3. Every click, type and key press needs a short `why` in the user's terms ("Opening the date picker"). Calls without one are refused. The user sees it next to your cursor, on approval prompts and in Activity.
4. Work in ONE tab. `chrome_open` a URL (it reuses your main tab), or use the tab the user shared, then `chrome_read_page` to get refs like `e12`. Act with refs: `chrome_click {ref}`, `chrome_type {ref, text, submit?}`. Refs go stale after navigation; read the page again.
5. Once you have refs, do several steps in one `chrome_batch` call (fill the fields, then submit) instead of one call per step. Every click/type/key step still needs its `why`.
6. Prefer `chrome_read_page` / `chrome_text` over screenshots; use `chrome_screenshot` when layout matters.
7. CAPTCHA, login, 2FA, payment or anything needing the user's judgement: `chrome_handoff` with one short instruction, then continue from where the page is when it returns. Never try to solve a CAPTCHA.
8. If a call says the user took over or paused, wait for them; if it says they pressed Stop, stop and ask.
9. If a click returns "did not allow", the user denied it in the browser. Ask before trying again.
10. Recorded workflows: when the user asks for something they recorded (listed by `chrome_status` and `chrome_replay` with no name), use `chrome_replay {name, vars}`. If it stops at a step, finish the rest yourself.
11. Need several pages at once (research, comparing prices or options)? Open them with `chrome_open {url, newTab: true}`, read each, and keep the count small. Never navigate away from a tab the user shared with you; open your own instead.
12. At the end of multi-step work, `chrome_report {summary}` (one line). It closes the extra tabs you opened with newTab.

## Research data: extract, then export

When the user wants facts collected into a table (competitors, pricing, products, reviews, follower counts, ad counts), use `chrome_extract` instead of copying values out of `chrome_text` yourself.

- Open the page, then `chrome_extract {fields: [{name, description}], dataset}`. On list pages (product grids, review lists, search results) add `multiple: true` to get one record per item; if it picks the wrong repeated block, pass `listSelectorHint` (a CSS selector for one item; the result's `list_selector` shows what it used).
- Use one `dataset` name per job ("acme-competitors") and extract every page into it, then `chrome_export {dataset}`.
- Every value carries its provenance: source URL, capture time, whether the session looked logged in, and the exact quote from the page. Values whose quote is not on the page are dropped and listed under `dropped`: never report those as facts. `screenshot: true` saves one screenshot per call as extra evidence.
- `chrome_export` writes Markdown by default (a table plus a Sources section with the URL, time and quote for every row). Use `format: "csv"` or `"json"` (or `"all"`) when the user wants a spreadsheet or data file. Give the user the file path it returns.
