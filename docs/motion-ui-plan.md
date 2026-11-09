# Hermes Chrome: motion and UI plan

Status: plan, not built. Written 2026-11-09 after the clean-look pass (no cursor caption, no name tag, no hover tooltips).

## The idea

The agent should look like a second person at your desk using your mouse. Not a robot overlay, not a light show. Everything on the page answers one question at a glance: **is it working, waiting for me, or done?** The cursor carries almost all of that. Every other layer is quiet, short and gone when not needed.

Three rules decide every detail:

1. **Motor realism over decoration.** Movement follows how hands move a mouse (Fitts's law, minimum-jerk arcs, small overshoot and settle). No effect exists only to look busy.
2. **One signal per state.** Working, paused, needs you and done each have exactly one visual cue, used the same way on the page, the tab, the toolbar icon and the side panel.
3. **Disappear when idle.** After a task, nothing of Hermes stays on the page except the tab marker.

## What changes on the page

### Today → planned

| Today | Planned |
|---|---|
| Cursor glides on an eased arc at a fixed pace | Human motor model (below): speed depends on distance and target size, slight overshoot on long moves, settle, a short hover before clicking |
| Edge glow that "breathes" the whole time the agent works | Removed. The cursor and the tab marker already say "working" |
| Reading sweep line across the page | Replaced by eye-like reading: the page scrolls in short steps with pauses, the cursor rests near the text being read |
| Highlight box flash on every target, dashed red flash in Teach mode | Highlight only when the user needs to look (approval, handoff target); Teach keeps one subtle outline for the recorded element |
| Click ripple | Kept, smaller (2.5× instead of 4.5×), 280 ms, pointer "press" dip of 0.92 scale |
| Plan strip with name and step text | A small pill: progress dots + current step on hover-free expand when the user moves their own mouse near it; pause/stop stay one tap |
| Handoff banner at the bottom of the viewport | A calm card anchored next to the thing that needs the person (the CAPTCHA, the login form), with one soft ring on that element; auto-continues when solved |
| "Waiting for your OK" notice | Same anchored card style, no buttons (decisions stay in the extension window) |

### Cursor motor model (the memorable part)

- **Path**: minimum-jerk trajectory with a gentle curve whose bend depends on direction (hands arc, they rarely go straight). Real `mouseMoved` events follow the drawn path exactly, as today.
- **Timing (Fitts)**: `MT = a + b · log2(D / W + 1)` with a ≈ 120 ms, b ≈ 110 ms, clamped 180–900 ms. Big near targets are quick; small far targets are slower.
- **Overshoot**: on moves over 400 px, overshoot by 2–5 % past the target and settle back in 80–120 ms.
- **Micro-tremor at rest**: ±0.5 px drift every ~1.5 s while hovering, only during a pause before a click (not while idle).
- **Pre-click hover**: 120–350 ms dwell over the target, longer for risky buttons.
- **Click**: pointer dips (scale 0.92, 70 ms), ripple 280 ms, release.
- **Typing**: cursor switches to an I-beam over text fields and stays still; keys arrive in bursts of 3–7 characters with 60–180 ms gaps and a longer pause at word boundaries (already real input; this only shapes timing).
- **Scrolling**: real wheel events in 2–5 notches with ease-out momentum, a 300–700 ms reading pause between bursts, never a jump.
- **Idle**: after 2.5 s without activity the cursor fades out (like a real pointer when you stop moving the mouse); it fades back in at the next action, from where it was.
- **Takeover**: the moment the person moves their own mouse, the agent's cursor shrinks and fades in 150 ms. No banner, because the toolbar icon already shows paused.

### Pointer look

A pointer that matches the operating system's own arrow (macOS-style outline on Mac, Windows-style on Windows), tinted with the agent colour on its fill, 1 px white outline, soft 2 px shadow. Same size as the real pointer, so it reads as "a second mouse", not a sticker.

## Colour and type

The current terracotta on cream is close to a look that many AI products now share, and it competes with the pages the agent works on. Proposal: let the page stay the page, and give the agent one colour of its own.

| Token | Hex | Use |
|---|---|---|
| Agent | `#2563A8` | Cursor fill, working dot, progress |
| Needs you | `#C2410C` | Handoff ring, needs-you badge |
| Danger | `#B42318` | Deny, unpair, blocked |
| Ink | `#1F2328` | Text on light |
| Surface | `#FFFFFF` / `#202124` | Cards in light / dark (matches Chrome's own dark grey) |
| Hairline | `#E3E5E8` / `#3C4043` | Borders |

Decision for you: keep the terracotta brand (it matches the avatar and HermesNag), or move to the agent-blue above. The motion work does not depend on it.

Type: the browser's system UI font everywhere in extension pages (side panel, Settings, approval window), because they sit inside Chrome's own UI and should feel native. One size scale: 12 / 13 / 15 / 18 px, weights 400 and 600 only.

## Side panel

- Header: agent name, one status dot (same signal as the cursor), nothing else until needed.
- Chat: messages without bubbles for the agent (plain text column), light bubble for the person. Live status line shows the step in a single row that cross-fades between steps (120 ms), never stacks.
- Activity: a vertical timeline of snapshots; tapping one zooms it in place.
- Motion: only on the person's actions (send, open menu, expand). No entrance animations on load.

## Settings and the approval window

Already minimal after today's pass. Remaining polish: match the token table, dark mode for both, and the approval window opening next to the browser window instead of the screen centre.

## Accessibility and performance

- `prefers-reduced-motion`: the cursor teleports with a 120 ms fade, no ripple, no overshoot; real input timing (human pace) stays as the user set it.
- All motion on `transform` and `opacity` only; one `requestAnimationFrame` loop for the cursor; nothing runs while idle.
- The overlay never intercepts the person's clicks (pointer-events none except the anchored cards).

## Build order

1. Cursor motor model and pointer look (largest visible gain), with a demo page to tune the numbers.
2. Remove glow and reading sweep; add reading-style scrolling.
3. Anchored handoff and waiting cards.
4. Plan pill.
5. Colour tokens (after your decision), dark mode, approval window placement.

## How to judge it

Record the same task (search, open a result, fill a form) before and after, side by side at normal speed. It passes when a person watching cannot tell within the first ten seconds whether a human or the agent is moving the mouse, and can still say at any moment whether it is working, waiting or done.
