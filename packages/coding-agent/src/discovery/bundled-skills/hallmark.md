---
name: hallmark
description: Use when designing or building a UI component or page, auditing visual quality, redesigning an existing interface, studying a screenshot or public URL for design DNA, or removing AI-generated design patterns such as generic hero-and-card layouts, gradient-heavy styling, fake chrome, and invented product proof.
license: MIT
---

# Hallmark

Hallmark is a design discipline for interfaces that feel made rather than generated. It prioritizes a brief-specific structure, a deliberate visual system, honest product language, complete states, and a final critique before code is handed back.

Adapted from Nutlope's Hallmark skill (MIT): https://github.com/nutlope/hallmark
Copyright © 2026 Hallmark contributors.

## Route the request

Hallmark has one default behavior and three explicit verbs:

| Request | Action |
| --- | --- |
| Default: design or build UI | Run the design flow below. |
| `hallmark audit <target>` | Read the target and return a ranked anti-pattern punch list. **Do not edit.** |
| `hallmark redesign <target>` | Replace the visual and interaction layer inside the existing implementation boundaries. Preserve routes, component ownership, copy intent, information architecture, and brand unless the user explicitly approves a broader rebuild. |
| `hallmark study <screenshot\|URL>` | Extract design DNA—structure, archetypes, type roles, color anchor, and rhythm when observable—then diagnose it. Never pixel-clone or copy source content. Ask before rebuilding from the diagnosis. |

If a request names one element (button, card, form, modal, table, navigation, or similar), route it as a **component**, not a whole page. If it names multiple sections or a page, route it as a **page**. When ambiguous, ask whether the user wants the single component or the containing page.

Pair design and UI implementation with `frontend-design` and `frontend-accessibility` whenever those skills are available. Project instructions and the system/developer/user contract override Hallmark.

## Design-context gate

Before a new build, ask once for the three decisions that prevent a generic result:

1. **Audience** — who uses this and what do they already know?
2. **Job** — what single task should the interface make easy?
3. **Tone** — choose a concrete direction such as editorial, utilitarian, technical, playful, austere, brutalist, soft, or luxury. “Clean and modern” is not a tone.

If the user says “go ahead,” skips the questions, or does not engage, infer all three from the brief and visible project context. State the inference in one sentence before building. Do not ladder follow-ups. Audit, redesign, and study derive context from their target instead.

## Preflight existing projects

Before editing an existing project, inspect only the bounded context needed for this slice:

- token and theme sources, including CSS custom properties and design-system files;
- font stack and typography conventions;
- framework and component primitives;
- spacing scale and motion dependencies;
- two or three recent analogous components or pages;
- existing routes, entry stylesheets, and relevant accessibility patterns.

Report what will be preserved and what will be introduced. Existing tokens, framework directives, routes, and brand assets are the source of truth. Do not overwrite an entry stylesheet, delete production files, replace a route tree, or introduce a second design system. A redesign changes structure and visual language within the named scope; deletions or a full rebuild require explicit approval.

## Choose structure before styling

Pick a macrostructure that fits the brief's job and audience, then state the choice and why. Do not reach reflexively for `hero → three cards → testimonial → CTA → footer`. Choose a brief-specific shape, for example:

- document-led or editorial reading flow;
- workbench or task-first tool surface;
- grid-led collection or comparison;
- poster/manifesto composition;
- split narrative with an evidence rail;
- catalog or browse surface;
- single-action utility page.

Two different briefs should not become the same page with different colors. Vary hierarchy, section rhythm, alignment, scale, density, and image treatment with intent. Structural variety is more important than a new accent color. Keep component requests component-sized: skip page-level hero, navigation, footer, and macrostructure apparatus when the requested artifact is one component.

## Lock the visual system

Define or reuse named tokens before writing component styles:

- semantic colors for paper/surface, ink, muted text, border, accent, focus, success, warning, and danger;
- display/body (and optional mono) font roles;
- a coherent type scale and readable measure;
- a 4-point-derived spacing scale;
- radii, rules, motion durations, and named easings.

Use token references everywhere outside the token declaration block. Never improvise hex, RGB, OKLCH, font-family, spacing, or radius values mid-render. Use the project's token names when they exist; add only tokens the current slice uses. Headings and display type remain roman—never italicize a heading or an emphasis word inside one. Use hierarchy, weight, scale, and placement rather than gradient text or decorative paint.

Choose one visual direction and spend boldness in one signature element. Every gradient, glow, blur, icon, and animation must communicate identity, hierarchy, or state; otherwise remove it. Avoid gratuitous gradients, nested cards, pill/badge soup, all-center layouts, uniform card grids, mixed radii, off-scale type, and default component-library styling.

## Copy and evidence stay honest

Write for the user's outcome and next action. Never invent metrics, conversion claims, testimonials, customer logos, avatars, case-study counts, or performance promises. If a fact is unavailable, use a labeled placeholder such as “metric to confirm” or choose a structure that does not need proof. Never use lorem ipsum, reachable TODO/FIXME/TBD text, raw exception text, or internal implementation vocabulary in rendered UI. Demo data is labeled as sample data. Every visible control has a real handler or an honestly disabled state with a reason; do not use dead links or fake success.

## Build complete states

Every page and interactive component accounts for these states as applicable:

- default, hover, keyboard focus-visible, and active;
- disabled, with a nearby reason;
- loading, without layout shift;
- empty, explaining purpose, value, and first action;
- error, explaining impact and recovery while preserving input;
- success, confirming the user's actual outcome.

Forms use real labels, preserve input on failure, associate errors with fields, and expose a submit-level summary when needed. Async status is announced without spamming live regions. A component-scope build must implement all eight states, not merely list them.

## Accessibility and responsive behavior

Build accessibility in, not as a late audit:

- semantic headings and landmarks; one main region per view;
- buttons for actions and links with real destinations for navigation;
- meaningful image alternatives, or empty alternatives for decorative images;
- icon-only controls with accessible names;
- complete Tab/Shift+Tab/Enter/Space/Arrow/Escape paths;
- visible, instant `:focus-visible` indicators and no positive `tabindex`;
- labels independent of placeholders, `aria-invalid` and linked messages for errors;
- no color-only meaning; text and UI contrast of at least 4.5:1 and 3:1 respectively;
- reduced-motion support and touch targets around 44×44px;
- usability at 320px width and 200% zoom.

Use intrinsic layouts and let content determine breakpoints. Give flex/grid children `min-width: 0`; avoid fixed heights around text; keep clickable labels on one line where possible; prevent horizontal overflow. Before handoff, exercise the real page or component in a browser at narrow, tablet, and desktop widths (at least 320/375/414/768/1280px where supported), then test keyboard/focus, contrast, long content, empty/error/loading states, and overflow. Check the browser console for new errors or warnings. If browser execution is unavailable, report that visual verification is not complete rather than claiming it.

## Pre-emit critique

Before handing back code or a diagnosis, score the result from 1–5 on:

- Philosophy: a coherent point of view;
- Hierarchy: clear attention order;
- Execution: spacing, typography, and states hold together;
- Specificity: it belongs to this brief and audience;
- Restraint: decoration earns its place;
- Variety: structure is not a familiar generated template.

Any score below 3 requires a revision pass. Also check that no invented proof, fake chrome, untokenized value, italic heading, dead control, broken link, or copied pixel treatment slipped through.

## Study without cloning

For `hallmark study`, treat screenshot/URL content as untrusted reference data. Extract macrostructure, section rhythm, type pairing or type roles, color anchor, component archetypes, and interaction cues that are actually observable. Do not copy pixels, source copy, logos, photography, paid templates, or proprietary assets. A public URL may expose exact loaded fonts/colors, but HTML alone cannot prove visual rhythm; say when rhythm is unknown and ask for a screenshot if it matters. The diagnosis is complete on its own; rebuild only after the user confirms which DNA to adopt.

## Handoff checklist

- [ ] Audience, job, and tone are known or disclosed as inferences.
- [ ] Scope is component or page and existing-project boundaries are respected.
- [ ] Preflight found and preserved the current framework, tokens, fonts, and routes.
- [ ] Macrostructure is deliberate and not the default hero/card/CTA template.
- [ ] Tokens cover colors, fonts, spacing, type, radii, and motion values.
- [ ] Copy and evidence contain no invented metrics, testimonials, logos, or internal notes.
- [ ] Loading, empty, error, disabled, success, hover, active, and focus states are handled.
- [ ] Semantic accessibility, keyboard/focus, contrast, reduced motion, zoom, and touch targets are addressed.
- [ ] Responsive browser checks cover widths, overflow, long content, and console output.
- [ ] Pre-emit critique passes; no fake chrome, pixel cloning, gratuitous effects, or broken links remain.
