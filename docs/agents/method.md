# BMAD-Fluid — The Dream Team Method

> **BMAD** = *Breakthrough Method of Agile AI-driven Development*.
> The original BMAD framework defines a small set of specialised agent personas
> (Analyst, PM, Architect, SM, Dev, QA) collaborating through structured
> hand-offs. We adapt that idea here for a **GPU fluid simulation that ships
> as a static page** — different domain, different team.

---

## 1. Why BMAD-style personas in this repo

This codebase has been bitten repeatedly by changes that *looked correct in
isolation* but tripped a known failure mode in another layer (the
zero-viscosity trame is the canonical example — see [`../gotchas.md`](../gotchas.md#1-grid--trame-at-zero-viscosity)).

A single pass through one reviewer rarely catches all of them. The fix is
not "more reviewers" but **the right reviewers**: a fixed roster of
specialists who each carry their own checklist of "things this domain
historically gets wrong here". Every non-trivial change must be reviewed by
at least the personas whose domain it touches.

We use the rubber-duck mechanism (see top-level instructions) to invoke a
persona — load that persona's MD into the rubber-duck's context, hand them
the diff, ask for a critique.

---

## 2. The dream team

Six personas, deliberately overlapping at the seams (a shader change is
*always* both Hiro's and Anouk's; a UI change is *always* both Marcus's and
Erik's). Read each before deciding which to invoke.

| # | Name             | Role                  | File                                         |
|---|------------------|-----------------------|----------------------------------------------|
| 1 | **Maya Chen**    | Architect             | [`maya-architect.md`](maya-architect.md)     |
| 2 | **Hiro Tanaka**  | Shader / GPU engineer | [`hiro-shader.md`](hiro-shader.md)           |
| 3 | **Dr. Anouk Lefèvre** | CFD scientist    | [`anouk-cfd.md`](anouk-cfd.md)               |
| 4 | **Marcus Vale**  | UX director           | [`marcus-ux.md`](marcus-ux.md)               |
| 5 | **Priya Rao**    | Performance engineer  | [`priya-perf.md`](priya-perf.md)             |
| 6 | **Erik Holm**    | QA / regression hunter | [`erik-qa.md`](erik-qa.md)                  |

---

## 3. The workflow — three phases per change

### Phase A — Plan (before code)

1. State the change in 2–3 sentences in your own working notes (`plan.md`).
2. Pick 2–4 personas whose domain this touches. Always include **Erik**
   (regressions) and at least one of **Maya / Hiro / Anouk**.
3. Invoke a rubber-duck pre-flight loaded with each picked persona's MD plus
   the change description. Capture findings.
4. Adopt findings that meaningfully reduce risk; explicitly set aside the
   rest with a one-line justification (in `plan.md` or the commit body).

### Phase B — Implement

1. Code the change. Keep the diff focused.
2. `node --check` every touched JS file.
3. Smoke-test in the browser against the persona-relevant checklist
   (e.g. Marcus's UX checklist if you touched UI).

### Phase C — Review (before commit)

1. Re-invoke the same personas with the actual diff (not the plan). They
   often find different issues than at planning time.
2. Iterate until each persona either signs off or you've justified the
   disagreement.
3. **Compose the commit message — including the poem (§4 below).**
4. Commit, run `tools/stamp-version.sh --amend`, push.

This loop is intentionally heavier than "just code it". The codebase rewards
that investment because the failure modes are subtle and visual.

---

## 4. The poem requirement (the real review-comprehension test)

**Every commit message body must include a short poem on the beauty of
fluids.** Three to six lines, free verse or structured (haiku, tanka, tercet,
quatrain — your choice). The poem proves that the contributor read this
section, which means they probably read the rest too.

Place it on its own block, prefixed with the marker `~~~ on fluids ~~~`,
**before** the `Co-authored-by` trailer.

```
<commit subject>

<commit body explaining the change>

~~~ on fluids ~~~
A pressure gradient hums in the dark,
the dye remembers each finger;
between two iterations, the field forgets
its own divergence.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
```

Style notes:

- The poem must be **about fluids, flow, motion, water, vorticity, pressure,
  light through water, etc.** — not about coding, AI, or commits.
- Repetition across commits is fine; recycling the *exact same* poem is not.
- It should be tasteful. No forced rhyme; concrete imagery beats abstraction.

This is a hard rule, enforced on every PR.

---

## 5. Lightweight invocation pattern

When you don't have time for the full three-phase loop (truly trivial fixes:
typo, dead-code removal, comment polish), you may skip Phase A and run only:

- A **single Erik pass** on the diff (regressions).
- The **poem in the commit** (always — this is non-negotiable).

For anything that touches `FluidSimulation.js`, `Shaders.js`, the input
pipeline, or new UI surfaces: full three-phase.

---

## 6. Quick persona-picker

| If you're touching…              | Always invoke               | Often invoke               |
|----------------------------------|-----------------------------|-----------------------------|
| `Shaders.js`                     | Hiro, Anouk, Erik           | Priya                       |
| `FluidSimulation.js` (non-shader)| Maya, Anouk, Erik           | Hiro, Priya                 |
| `ParticleSystem.js`              | Hiro, Maya, Erik            | Marcus                      |
| `UI.js`, `index.html`, CSS       | Marcus, Erik                | Maya                        |
| `InputHandler*`, `*Reactivity`   | Marcus, Maya, Erik          | Priya                       |
| `config.js` (new tunable)        | Maya, Marcus, Erik          | the domain owner            |
| Adaptive quality, FBO churn      | Priya, Maya, Erik           | Hiro                        |
| Docs, tools, build               | Erik                        | —                           |
