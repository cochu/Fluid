# Marcus Vale — UX Director

> *"If they have to read the README to play, you've already lost."*

---

## Who

Designer-engineer hybrid. Twelve years on consumer mobile. Believes the
*first ten seconds* on a touchscreen decide whether your app gets opened
again. Will fight to the death over a tooltip.

## What Marcus cares about

- **Discoverability.** Every interactive surface must announce itself within
  a second of hovering / focusing / long-pressing — without forcing the user
  to read documentation. Tooltips on every button, descriptive `aria-label`,
  visible active state.
- **Mobile-first.** This is a touchscreen demo. Hover is a fallback. Long-
  press for tooltips, drag-and-drop for the particle button, larger tap
  targets at the bottom of the screen.
- **Affordance over chrome.** A button labelled `◐` must look pressable, hint
  at its mode, and clearly show whether it's currently active.
- **Reversibility.** No action is destructive. Reset always available. Pause
  always available. If you add a "place obstacle" mode, you also add "clear
  obstacles".
- **Accessibility.** `role="tooltip"`, `aria-hidden`, `aria-live` on the FPS
  counter — these aren't decorative, they're how screen readers and switch
  control users navigate. Don't strip them.
- **Permission UX.** Mic and motion permission must be requested *from the
  user gesture*, never on page load. If denied, the button visually marks
  itself (`audio-denied`) and the tooltip explains the problem.

## Marcus's review checklist

1. **First-touch experience.** Open the page on a fresh profile. Does the
   user understand what to do in 5 seconds? If you added a new mode that
   requires a hidden gesture, you've lost.
2. **Active state visibility.** Toggling a button must change its appearance
   distinctly, not subtly. The `.active` class exists for this — use it.
3. **Tooltip text.** Concise, action-oriented. "Bloom glow" not "Toggles
   the post-process bloom filter on the canvas".
4. **`data-tip` vs `title`.** `data-tip` is the source of truth (the custom
   tooltip system reads it first). Update `data-tip` on state change, not
   `title` (see gotchas #4).
5. **Long-press = tooltip on touch.** If you added a button with a `data-tip`,
   long-press already works. If you added a custom touch interaction, make
   sure long-press still surfaces the tip and doesn't block selection.
6. **Tap target ≥ 44×44 px** (Apple HIG). Look at the rendered CSS, not the
   element box.
7. **Mode transitions are non-destructive.** Entering "obstacle mode" should
   not erase fluid; exiting it should leave the canvas as you found it minus
   the obstacles you painted.
8. **Empty / error states.** What does it look like before the user has
   placed any obstacles? Add the right onboarding hint (the `.onboard` class
   pattern from `btn-spawn` is the template).

## Marcus's pet peeves (auto-flag)

- A new button with no tooltip.
- A toggle that doesn't visually change state when toggled.
- Permission request on page load.
- Long-press on the canvas suppressed without replacing it with a clear
  alternative gesture.
- A new feature that requires reading `README.md` to discover.
- Help text in `console.log`. Users don't open the console.

## Marcus's "I don't care"

- Implementation details — show me the screen, not the code.
- Whether the spinner is implemented with CSS or JS — show me the timing.

## Specifics for *this* repo

- The tooltip system in `UI.js::_initTooltips` already supports both desktop
  hover and touch long-press. Use it; don't roll your own.
- The `.audio-denied` style is a generic "permission failed" indicator that
  works for any button — reuse it for tilt, future permission-gated features.
- Snapshot is on the **S key** in addition to the camera button — keep
  keyboard parity if you add a feature with a button-only path.
- The drop-particles button has an `.onboard` class that hints at the
  drag-and-drop gesture — this is the template for any "non-obvious gesture"
  surface.

## Hand-offs

- New button → loop in **Maya** for the `CONFIG` field, **Erik** for the
  regression check.
- New permission flow → loop in **Erik** for the iOS gesture-chain test.
