---
name: frontend-design
description: Foundation for all production frontend/UI/UX work, bounded to the requested executable vertical slice. Covers project context, tokens, aesthetic direction, states, responsive behavior, and anti-slop; it never authorizes a general design-system Foundation phase before product UI ships.
---

# Frontend Design

Precedence for every decision below: **project guidelines > this skill > model defaults.**

## 1. Project context first

Before design decisions, inspect only enough project context to identify the current slice's existing system and newest pattern:

- Docs: `DESIGN*.md`, `STYLEGUIDE*`, `docs/design*`, `docs/brand*`, `CONTRIBUTING*`, brand asset folders.
- Tokens/themes: `tailwind.config.*`, `theme.*`, `tokens.*`, CSS custom properties, MUI/Chakra/styled-system theme files.
- Living system: Storybook (`.storybook/`, `*.stories.*`), shared primitives in `components/ui`, `packages/ui`, `src/lib/components`.
- Project-level agent rules or skills, if the workspace defines them.

Anything found there overrides this skill. When project convention conflicts with a rule below, follow the project and note the conflict in your report — never silently "improve" an established convention.

## 2. Design-system discipline

Work inside the current executable UI slice:

1. **Bounded token scan.** Read token/theme sources plus 2–3 newest analogous components. Stop when naming, spacing, color, and type patterns agree.
2. **Missing primitive? Add only what this slice uses.** Define the smallest token/primitive in the SAME implementation package; NEVER build a general palette/component Foundation first.
3. **Compose with the system.** Reuse tokens/primitives; a new token must be used by the current slice now, not reserved for future screens.
4. **Verify selected UI risks.** Check rendered states, responsive boundaries, accessibility, and theme modes that the changed slice actually supports; do not turn style consistency into an unbounded audit.

Prefer **semantic tokens** over literal ones: `--color-surface`, `--text-muted` — not `gray-100` scattered through components.

If the project has theme modes, every change is verified in both; in dark mode prefer borders and surface tints over heavy shadows for elevation.

## 3. Aesthetic direction

Choose one aesthetic direction once in the package brief or internal reasoning, then code. NEVER create or re-review a separate design plan artifact after direction is locked.

- **Typography.** At most two families (display + body; optional mono for data). Set a modular scale (ratio ~1.2–1.333) and use only its steps. Body line-height 1.4–1.6, tighter for display; measure 45–75ch. When the choice is free, pick faces with character over reflexive Inter/Roboto/Open Sans — but an existing project font is a convention: keep it.
- **Color.** Tint neutrals toward the brand hue — never pure `#000`/`#fff`. One accent that does real work (primary actions), not decoration. Semantic colors (success/warning/danger) reserved for meaning only. On colored backgrounds, derive text/borders from shades of that background hue, not flat gray.
- **Hierarchy.** One primary action per view. Importance is encoded by size, weight, contrast, and position — not by making everything bold or every button primary. Group by proximity first, borders/cards last. Left-align text blocks by default; center only short, symmetric content.
- **Restraint.** Spend boldness in one place: choose a single signature element and keep everything around it quiet. Before shipping, remove one decoration — if nothing is lost, it was slop.

## 4. Interface states — every surface ships all of them

- **Loading:** skeletons that mirror the final layout for content; spinners only for actions; progress indication past ~3s; no layout shift when content resolves.
- **Empty:** what this space is for + the first action + why it's worth doing. Never a bare "No data". (Copy formulas: frontend-ui-copy.)
- **Error:** what happened + impact + recovery action; user input preserved; field-level errors inline, form-level summary on submit.
- **Disabled:** show why (helper text/tooltip) — or don't render the control at all.
- **Hover / focus / active:** on every interactive element; the focus style is distinct from hover.
- **Success:** confirm the specific outcome ("Invoice sent to Anna"), never the mechanism ("Operation completed successfully").
- **Dense/stress:** 200-character names, unbroken strings, thousands of rows, exactly one item, 200% zoom, slow network.

## 5. Responsive behavior

Mobile-first. Breakpoints live where the content breaks, not at device names. No fixed heights on text containers. `min-width: 0` on flex/grid children so long content can't blow the layout. Prefer intrinsic layouts (`auto-fit`/`minmax`) over hand-managed column counts. Verify at ~360px, ~768px, and ≥1280px.

## 6. Real UI, not a mockup

- Every control is wired to a real handler, or is honestly disabled with a visible reason. No dead buttons, no `href="#"`.
- No lorem ipsum anywhere — write plausible domain copy even in drafts; real labels are longer and expose layout truth.
- No fabricated numbers, stats, testimonials, or logos presented as real. Demo content must be labeled ("Sample data").
- No `TODO` / `FIXME` / `TBD` / placeholder text reachable in the rendered UI.
- Backend or API not ready → build the true empty state, a disabled control with a reason, or a feature-flagged "coming soon". Never simulate success.
- Forms validate and submit for real, or are not rendered.
- Images: real assets or clearly labeled placeholders — never a broken `<img>`, never stock filler passed off as final.

## 7. Anti-slop

Three principles decide every case the table below doesn't:

1. **Decoration must encode meaning.** Every gradient, glow, blur, icon, or animation must communicate hierarchy, state, or identity. If removing it loses nothing, remove it.
2. **Sameness is a choice, not a default.** Identical cards, uniform spacing, and center-everything read as unexamined output. Vary scale, weight, and alignment with intent.
3. **Defaults are undesigned.** Default fonts, default component-library look, default palettes signal that nobody decided. Adopt a default consciously (and say so) or deviate consciously.

**Escape clause:** if the project's established language already uses a pattern below, follow the project (§1 precedence).

Known AI-look clusters to avoid *when the direction is yours to choose* — legitimate for some briefs, but as reflexes they read as generated: (a) warm cream background + high-contrast serif display + terracotta accent; (b) near-black background + a single acid-green or vermilion accent + glow; (c) hairline-rule "broadsheet" with zero border-radius and dense columns.

Common tells → fix:

|Tell|Fix|
|---|---|
|Glassmorphism / blur / glow everywhere|Reserve elevation and effects for real layering|
|Cyan-purple gradient on dark|Build the palette from the brand hue + tinted neutrals|
|Gradient text on headings/metrics|Emphasis via size and weight, not paint|
|Identical card grids (icon + title + text × N)|Vary layout by importance; fold trivial items into lists|
|Cards nested inside cards|Flatten; group with spacing and rules|
|Big rounded icon above every heading|Icons only where they aid scanning|
|Hero metric (huge number + gradient accent) as default|Context (trend, comparison) beats size|
|Emoji as production icons|One icon set with consistent stroke and weight|
|✨ sparkles on every AI feature|Name the capability plainly|
|Badge/pill soup|≤1 status indicator per row unless the data demands more|
|Uniform 16px spacing everywhere|Spacing scale with contrast: tight within groups, generous between|
|Center-align everything|Left-align; deliberate asymmetry reads designed|
|Modal for every interaction|Inline edit / popover / dedicated page; modals only for true interruptions|
|Pure `#000`/`#fff`; gray text on colored backgrounds|Tinted neutrals; on color, use shades of that hue|
|Bounce/elastic easing|ease-out (quart/expo) on enter, ease-in on exit|
|Animated gradient or particle backgrounds|Static texture or nothing|
|Mixed radii (4px buttons, 24px cards, pill inputs)|Radius scale tied to component size|
|Off-scale one-off font sizes (13/15/17px…)|Type-scale steps only|
|Numbered markers (01/02/03) on non-sequences|Number only real order; otherwise plain labels|
|Fake logos, testimonials, avatars|Real ones or none (see §6)|

## 8. Motion

Micro-interactions 120–200ms; panel/page transitions 200–350ms; anything over 500ms needs a reason. Enter with ease-out, exit with ease-in, moves with ease-in-out; never bounce/elastic. Animate `transform` and `opacity` only — never layout properties. Motion must show causality (origin, destination, state change), never ambience. Always honor `prefers-reduced-motion`: swap movement for opacity, or drop it.

## 9. Definition of done

- [ ] Zero hardcoded colors/spacing — tokens and scale only
- [ ] All §4 states implemented
- [ ] Keyboard path works, focus visible (frontend-accessibility)
- [ ] Contrast passes: 4.5:1 text, 3:1 UI components
- [ ] Verified at 360 / 768 / 1280+; both theme modes if the project has them
- [ ] Stress-tested with long, dense, and empty content
- [ ] No new console errors or warnings
- [ ] Rendered result observed in a browser when one is available; otherwise the report explicitly says "not visually verified" — never claim otherwise
- [ ] No internal-note leakage in any rendered string (frontend-ui-copy hard rule)
