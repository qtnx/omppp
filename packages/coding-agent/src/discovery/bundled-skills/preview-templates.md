---
name: preview-templates
description: Product-preview presentation recipes — version-1 structured `.canvas.json` spatial maps (spec, story-map, journey-map, plan, architecture) plus single-file HTML mockups with sandbox/bridge rules. Use when building story maps, journey maps, plans, architecture canvases, or custom UI presentations for the product preview WebUI.
---

# Preview Templates

Ship review-ready product-preview artifacts.

| Artifact | Path / form | Preview kind | When |
|---|---|---|---|
| Structured canvas | `docs/product/canvases/<name>.canvas.json` | `canvas` | Spatial structure improves review |
| HTML mockup | self-contained `.html` in preview root | `mockup` | Custom interactive UI only |
| Markdown prose | product skill paths (`docs/product/...`) | `document` | Specs, design notes, ADRs — prose source of truth |

Canvases are **review-only**: agents create/update content; reviewers pan, zoom, fit, search, open detail, and send feedback to the owning agent. Local node drag is inspection-only and does not mutate source.

---

## A. Canvas — version-1 contract

### A1. Schema (exact)

```ts
interface PreviewCanvasDocument {
  version: 1;
  title: string;
  artifactType: "spec" | "story-map" | "journey-map" | "plan" | "architecture";
  description?: string;
  nodes: PreviewCanvasNode[];
  edges: PreviewCanvasEdge[];
  viewport?: { x: number; y: number; zoom: number };
}

interface PreviewCanvasNode {
  id: string;
  type: "card" | "lane" | "group" | "milestone" | "decision" | "actor" | "step";
  position?: { x: number; y: number };
  size?: { width: number; height: number };
  parentId?: string;
  title: string;
  body?: string;
  status?: "draft" | "ready" | "blocked" | "done";
  role?: "primary" | "secondary" | "risk" | "success" | "neutral";
  refs?: Array<{ label: string; path: string; anchor?: string }>;
}

interface PreviewCanvasEdge {
  id: string;
  source: string;
  target: string;
  type?: "sequence" | "dependency" | "association" | "decision";
  label?: string;
}
```

### A2. Hard limits (server rejects otherwise)

- File ≤ 2 MiB; ≤ 2000 nodes; ≤ 4000 edges.
- IDs unique, opaque, ≤ 128 chars.
- Edge `source`/`target` and node `parentId` MUST reference existing node IDs; parent graph acyclic.
- Positions **all-or-none**: every node has a valid finite position in ±1,000,000, or none do. Mixed / malformed / out-of-range → invalid. Prefer omit positions so the client applies deterministic layout.
- Strings: title ≤ 200; body/description ≤ 4000; edge label ≤ 200.
- `refs[].path` ≤ 512 chars, **relative**, no scheme (`https:`), no absolute root (`/…`), no `..` segment.
- Viewport zoom, when set, in 0.1–4.
- ONLY enumerated `artifactType`, node `type`, edge `type`, `status`, `role` values.
- **NEVER** HTML, scripts, style strings, URLs, or arbitrary React Flow / presentation props.

### A3. Placement & discovery

- Write `docs/product/canvases/<kebab-name>.canvas.json` (exact `.canvas.json` suffix).
- Generic `.json` is ignored by the scanner.
- Invalid canvases surface a safe error state; they never execute content.

### A4. Safe refs

```json
"refs": [{ "label": "Spec §Stories", "path": "docs/product/specs/2026-07-13-topic.md", "anchor": "stories" }]
```

A ref is clickable only when `path` resolves to a current manifest item; otherwise inert text. Prefer paths that already exist in the preview tree.

### A5. Deterministic layout expectation (client-owned)

When all positions are omitted:

1. Top-level `lane` / `group` left-to-right.
2. Children top-to-bottom inside parents via `parentId`.
3. Remaining nodes in topological columns from `sequence` / `dependency` edges; cycles → stable source-order rows.

You author structure + edges; you do NOT invent layout engines in the JSON.

---

## B. Canvas recipes (5 artifact types)

Use real product names. Empty placeholder cards are failure.

### B1. `story-map`

- Top row: activity/journey steps as `step` or `group` nodes in sequence (`sequence` edges).
- Under each activity: story `card` nodes with `parentId` = activity.
- Releases/priorities as horizontal `lane` groups when useful.
- Status/risk roles sparingly (`status`, `role: "risk"`).
- Refs point at the Markdown story map / spec sections.

Minimal skeleton:

```json
{
  "version": 1,
  "title": "Checkout — story map",
  "artifactType": "story-map",
  "description": "Activities across the top; stories beneath.",
  "nodes": [
    { "id": "act-browse", "type": "step", "title": "Browse", "role": "primary" },
    { "id": "act-pay", "type": "step", "title": "Pay", "role": "primary" },
    { "id": "s-search", "type": "card", "parentId": "act-browse", "title": "Search catalog", "status": "ready", "refs": [{ "label": "Spec S1", "path": "docs/product/specs/2026-07-13-checkout.md", "anchor": "s1" }] },
    { "id": "s-checkout", "type": "card", "parentId": "act-pay", "title": "One-click pay", "status": "draft", "role": "risk" }
  ],
  "edges": [
    { "id": "e1", "source": "act-browse", "target": "act-pay", "type": "sequence" }
  ]
}
```

### B2. `journey-map`

- Phases = column `group` / `lane` nodes left-to-right.
- Swimlanes inside phases: actor actions, touchpoints, evidence, pain, opportunity as `actor` / `step` / `card` children.
- `sequence` edges for movement across phases.
- Long evidence → short `body` + ref to Markdown; detail modal holds the rest.

### B3. `plan`

- Phases as `group` nodes left-to-right.
- Tasks as `card` children (`parentId`).
- Cross-phase `dependency` edges only when real.
- `milestone` and blocked `decision` nodes for gates.
- Refs to the plan Markdown / issue paths when present.

### B4. `spec`

- Primary capabilities as central `group` / `card` hierarchy.
- Acceptance / states attach as secondary `card` nodes (`role: "secondary"`).
- Risks/open questions as `decision` or `role: "risk"` cards.
- Every capability SHOULD ref its Markdown anchor.

### B5. `architecture`

- Containers/capabilities as `group` / `card` hierarchy.
- Actors as `actor` nodes; key choices as `decision`.
- `association` / `dependency` / `sequence` for topology and critical flows.
- Risks as secondary/risk-role nodes.
- Refs to architecture Markdown + ADRs.

### B6. Recipe selection

| Material | `artifactType` |
|---|---|
| User-story backbone / releases | `story-map` |
| Phase × swimlane experience | `journey-map` |
| Delivery phases, deps, milestones | `plan` |
| Requirements hierarchy / AC map | `spec` |
| System/context/containers/flows | `architecture` |

---

## C. HTML mockups (custom UI only)

Use HTML when interaction, layout fidelity, or a non-spatial visual mock is the point — **not** for story/journey/plan/architecture maps.

### C1. File contract

- **One file.** Exactly one self-contained `.html` per template.
- **Inline everything.** CSS in `<style>`, JS in `<script>`. No external stylesheets, modules, fonts, or images via URL.
- **Preview root.** Write into the active preview root (or the path the assignment names). Scanner picks up `.html` as mockup items.
- **No bridge tag.** Do NOT include a bridge `<script src>` or re-implement the bridge. Server injects `window.OmpxPreview` before `</body>`.
- **No build step.** Open-as-file HTML only.

### C2. Sandbox constraints (hard)

| Constraint | Consequence |
|---|---|
| Opaque origin | No parent DOM/storage access |
| No cookies | Session APIs unavailable |
| `sandbox="allow-scripts"` | Scripts run; forms/top-nav/popups not allowed |
| No external fetches | CDN/remote fonts/images/XHR blocked by design |

Talk to the parent ONLY through `window.OmpxPreview`.

### C3. `window.OmpxPreview` bridge API

```js
window.OmpxPreview = {
  sendPrompt(text),
  submitAnswer({ questionId, question, selection }),
  ready(),
};
```

Caps (parent-enforced): `sendPrompt` ≤ 4000; question ≤ 500; each selection ≤ 200; ≤ 10 selections.

**Prompt-back:**

```js
window.OmpxPreview.sendPrompt(text);
```

**Answer:**

```js
window.OmpxPreview.submitAnswer({
  questionId: "layout-choice",
  question: "Which dashboard layout?",
  selection: ["Sidebar"],
});
```

Do not invent alternate `postMessage` shapes.

### C4. Theme tokens

```css
:root {
  --bg-0: #0f1115;
  --bg-1: #161922;
  --bg-2: #1d212c;
  --border: #2e3445;
  --text: #d8dee9;
  --text-muted: #8b93a7;
  --accent: #7aa2f7;
  --ok: #9ece6a;
  --warn: #e0af68;
  --err: #f7768e;
  --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  --r-md: 8px;
}
html, body { margin: 0; background: var(--bg-0); color: var(--text); font-family: var(--font-sans); }
```

Responsive floor: usable at **≥360px**.

### C5. Recipe — UI mockup

1. Chrome bar with real app/nav labels.
2. Primary workspace under review.
3. Real copy for labels, empty/error, primary actions — no lorem.
4. Hotspots: local mock state and/or `submitAnswer` / `sendPrompt`.
5. Optional footer composer → `sendPrompt`.

Do not pull CDN assets, nest iframes, or re-create the preview shell.

### C6. Interactive question patterns

- Stable unique `questionId`s; `selection` always `string[]`.
- Show answered state after submit.
- Real option labels only.

---

## D. Format routing (presenter + product skills)

1. **Spatial structure improves review** → emit `.canvas.json` companion (and keep Markdown prose).
2. **Custom UI interaction is the question** → HTML mockup.
3. **Prose-only** → Markdown only; NEVER mandatory duplicate canvas.

Product skills request a canvas companion when maps/hierarchies/flows benefit from pan-zoom review; they NEVER force a canvas for every document.

---

## E. Done checklist

### Canvas

- [ ] Path ends with `.canvas.json` under `docs/product/canvases/`
- [ ] `version: 1` + valid `artifactType` + only enumerated enums
- [ ] Positions all-or-none; IDs unique; endpoints/parents valid
- [ ] Safe relative `refs` only; no HTML/style/URL/extra props
- [ ] Real product titles/bodies; recipe matches material

### HTML mockup

- [ ] Single self-contained `.html`; inline CSS/JS; zero network/CDN
- [ ] No bridge script tag; uses `window.OmpxPreview` only
- [ ] Dark tokens; ≥360px; real content; stable question ids
