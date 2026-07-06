---
name: frontend-accessibility
description: Accessibility rules and review checklist for frontend work — semantics, keyboard and focus, labels, buttons, errors, empty states, forms, dialogs, responsive constraints, contrast, reduced motion, and touch targets. Use whenever building, modifying, or reviewing any UI, not only when accessibility is explicitly requested.
---

# Frontend Accessibility

Accessibility is production quality, not an audit phase. Build it in; verify it explicitly.

## Semantic structure

- One `<main>` per view.
- Heading levels never skip; headings describe structure, not styling.
- Landmarks: exactly one `<main>`; label each `<nav>` when there are several.
- Images: informative -> `alt` describes function; decorative -> `alt=""`.
- Icon-only buttons get `aria-label`; icons beside text get `aria-hidden="true"`.
- Interactive semantics: use `<button>` for actions, `<a href>` for navigation — never `div`/`span` + `onClick`. If truly unavoidable, add `role`, `tabindex="0"`, and Enter/Space handlers, and treat it as debt.

## Keyboard & focus

- The whole task path is operable with Tab/Shift+Tab/Enter/Space/Arrows/Escape alone.
- Focus is always visible — never `outline: none` without an equal-or-better `:focus-visible` replacement.
- DOM order = tab order = visual order; no positive `tabindex`.
- Overlays (modal/menu/popover): focus moves in on open, is trapped while modal, Escape closes, focus returns to the trigger on close.

## Forms

- Every input has a real `<label for>` or `aria-labelledby`. Placeholder is never the label.
- Errors: `aria-invalid` on the field, message linked via `aria-describedby`, announced (move focus to the summary or use a live region), user input preserved.
- Required is marked in the label text, not by color or a bare asterisk.
- Radio groups use `<fieldset>`/`legend`.

## Color, motion, zoom, targets

- Contrast: text ≥ 4.5:1 (3:1 for ≥24px, or 19px bold); UI components and focus indicators ≥ 3:1. Check both themes.
- Never color-only meaning: pair with an icon or text (error = icon + message, not just a red border).
- Honor `prefers-reduced-motion`.
- Usable at 200% zoom / 320px width.
- Touch targets ≥ 44x44px or adequately spaced.

## Status & async

- Announce async results: `role="status"` (polite) for success/progress, `role="alert"` for errors; don't spam live regions.
- Loading is communicated to screen readers (`aria-busy` or status text), not only a visual spinner.
- `aria-disabled` is not enough for native controls; if a control is disabled, explain why near it.

## Greppable red flags

Flag these in review unless there is a documented exception:

- `onClick` on `div`/`span`/`li`/`img` without `role` and keyboard handlers.
- `outline: none`.
- `<img` without `alt`.
- `tabindex="[1-9]`.
- `placeholder=` with no matching label.
- hover-only menus (`onMouseEnter` without a focus/click path).
- `autoFocus` on page load (fine inside dialogs).
