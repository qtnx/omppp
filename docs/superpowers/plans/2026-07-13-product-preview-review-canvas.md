# Product Preview Review Canvas Implementation Plan
> **For agentic workers:** REQUIRED SUB-SKILL: Use `skill://subagents-development` to implement the locked packages. Each production owner writes and runs its focused behavior tests.


**Goal:** Replace the hand-built comment/fullscreen UX with the selected Review rail workflow and add safe, agent-generated structured canvases for specs, story maps, journey maps, plans, and architecture.

**Design source:** `docs/product/design/2026-07-13-product-preview-review-canvas-ui.md`
**Architecture:** Preserve the Bun/vanilla preview shell and add a generated React island for `kind: "canvas"`. The server validates dedicated `.canvas.json` artifacts and owns feedback/idempotency; the shared Review rail stays in the shell.

**Tech stack:** Bun, TypeScript, React 19, `@xyflow/react` 12.x, `@floating-ui/dom`, native `<dialog>`, `bun:test`.

## Global Constraints

- No generic JSON discovery, executable canvas content, arbitrary styles, or unsafe HTML.
- Feedback mutations succeed only when the owning agent queue accepts the event.
- Flow/diagram inspection is modal, never Fullscreen API.
- Existing Markdown, Mermaid, HTML mockup, share, answer, export, and persisted-comment behavior remains compatible.
- `packages/coding-agent` uses `bun check`; never invoke `tsc`.

---


**Locked choices:**

- Option A Review rail.
- Review-only canvas; agent owns artifact content.
- `@xyflow/react` 12.x for the structured canvas, React 19 island, `@floating-ui/dom` for selection composer positioning, native `<dialog>` for focused flow/node inspection.
- Dedicated `*.canvas.json` artifact and `GET /api/canvas/<id>` route.
- Comments are feedback to the owning agent. Without a live delivery callback, creation/reply/resolve returns `503 side_ask_unavailable` before mutation. The UI preserves draft content and offers Retry.
- Flow/diagram detail uses modal viewing. Remove the Fullscreen API and CSS fallback for these surfaces.
- Existing Markdown, Mermaid, custom HTML mockups, share/read-only behavior, answers, export, and item IDs remain compatible.

## Contracts

### C1 — canvas wire types

Add `"canvas"` to `ItemKind` and define bounded version-1 canvas types in `src/product-preview/canvas-schema.ts`:

- root: `version`, `title`, `artifactType`, optional `description`, `nodes`, `edges`, optional `viewport`;
- node: `id`, enumerated `type`, optional finite `position`, optional bounded `size`, `parentId`, `title`, `body`, `status`, `role`, and `refs`;
- edge: `id`, existing `source`/`target`, enumerated `type`, optional `label`;
- parser returns a typed success or field-specific validation error; no `any`, arbitrary HTML/styles/URLs/React props, or executable content;
- hard limits: 2 MiB, 2,000 nodes, 4,000 edges, bounded strings/IDs/coordinates, unique IDs, valid endpoints/parents, acyclic parent graph; every `refs[].path` is ≤512 characters, relative, has no scheme, no absolute root and no `..` segment.
- positions are all-or-none: either every node supplies a valid position or none do. The parser only validates and reports `layout: "authored" | "deterministic"`; it never computes positions. A present malformed/out-of-range or mixed position set is `invalid_canvas`.

### C2 — comment anchors

Replace the single text shape with a discriminated union:

- `{ type: "text", itemId, quote, prefix, suffix }`;
- `{ type: "canvas-node", itemId, nodeId }`.

`PreviewCommentStore.load` migrates legacy persisted anchors lacking `type` to `type: "text"` once on load. New writes are union-only. On every canvas-node feedback mutation, the server re-reads and validates the current artifact from disk and verifies `nodeId`; a stale/missing node returns `422 { error: { code: "invalid_anchor", message, field: "anchor.nodeId" } }` before mutation. The client preserves the draft and asks the reviewer to reselect a node.

### C3 — route/capability contract

- Add `ROUTE_CANVAS = "/api/canvas/"`.
- `GET /api/canvas/<id>`: 200 `{ item, canvas }`; 404 absent/wrong kind; invalid safe content uses the existing nested envelope `{ error: { code: "invalid_canvas", message, field? } }`; never executes content.
- Every new failure follows that same product-preview envelope: `{ error: { code, message, field? } }`. Comment unavailability uses `503 side_ask_unavailable`; request-ID/body conflict uses `422 idempotency_conflict`.
- Manifest adds `capabilities: { feedback: boolean }` so the client can disable feedback honestly on standalone previews. POST remains authoritative and may return 503 after a disconnect.
- Create, reply, resolve, and reopen require `deliverFeedback` before mutation because each is an agent instruction. Delete is the explicit local-cleanup exception: it remains available after the agent session ends, emits no steering, and preserves the existing permission rule (loopback owner may delete any; shared viewer may delete only an author-matched item).
- Every steering-emitting POST (`/api/comments`, `/api/comments/reply`, `/api/comments/resolve` for resolve or reopen) accepts a client-generated request ID. Repeating the same ID with identical endpoint/body returns the existing result; reusing it with changed endpoint/body returns `422 idempotency_conflict`. Store the request ID with the item/operation receipt and dedupe both durable mutation and steering enqueue.

### C4 — canvas island host

The generated React bundle exposes one narrow top-level host API:

```ts
interface ProductPreviewCanvasHost {
  mount(element: HTMLElement, input: {
    item: BundleItem;
    canvas: PreviewCanvasDocument;
    comments: PreviewCommentWire[];
    onNodeSelected(node: CanvasNodeSelection): void;
    onOpenComment(node: CanvasNodeSelection): void;
  }): ProductPreviewCanvasHandle;
}

interface ProductPreviewCanvasHandle {
  update(input: CanvasUpdate): void;
  focusNode(nodeId: string): void;
  fitView(): void;
  destroy(): void;
}
```

Use named types, not `ReturnType<>` or `any`. The vanilla shell owns routing, fetching, SSE refresh, auth/share state, and Review rail. The island owns React Flow rendering, search, minimap, controls, selected node state, modal detail, and local-only layout changes.

### C5 — deterministic client layout

The server returns positions exactly as authored, possibly omitted. Layout belongs only to P-client.

- If all positions exist, render them unchanged.
- If none exist, preserve node array order as the stable tie-breaker.
- Lay out top-level `lane`/`group` nodes left-to-right at 360 px intervals; lay out their children top-to-bottom at 140 px intervals inside the parent, using `parentId`.
- Lay out remaining unparented nodes in topological columns from `sequence` and `dependency` edges: x by depth at 320 px intervals, y by stable row at 160 px intervals.
- Cycles and nodes without ordering edges use the next stable row in source order.
- The function is pure and returns a new positioned node array. It never mutates or persists the artifact.
- `refs[].path` is clickable only when it resolves to a manifest item; otherwise render its label as inert text.

## Ready-horizon wave plan

| Package | Owner | Production files | Acceptance |
|---|---|---|---|
| P-server | `heavy_task` | `types.ts`, new `canvas-schema.ts`, `scan.ts`, `server.ts`, `comments.ts`; focused tests | safe canvas parsing/route/export; legacy anchor migration; comment 503-before-mutation; idempotent retry; existing comment concurrency tests green |
| P-client | `frontend_ui` | `client.js`, `index.html`, `styles.css`, `assets.ts`, new `canvas-app.tsx`, generated assets/build script/package manifest/lock; focused UI/parser tests | React Flow canvas reachable; Review rail and Floating UI composer; node feedback; modal not fullscreen; generated bundle drift check; browser states |
| P-agent | `quick_task` | `presenter.md`, `preview-templates.md`, relevant product skills, discovery tests | agents emit validated `.canvas.json` for spatial artifacts and keep `.md`/`.html` contracts for prose/custom UI |
| P-docs | integration cleanup owner | design/spec/CHANGELOG/runbook only after runtime works | user-facing behavior and artifact format documented; no released changelog edits |

C1–C4 are locked now. P-server and P-client may run concurrently against these contracts; type/file overlap is resolved by assigning `types.ts` to P-server and having P-client import it without editing. `package.json` and `bun.lock` belong only to P-client. P-agent owns no runtime files.

## Phase 1 — server/schema vertical slice

### Production change

1. [ ] Implement the canvas parser as a pure module with field-aware errors, all-or-none optional positions, `layout` eligibility, safe relative refs, and limits; do not compute layout server-side.
2. [ ] Extend scanner classification to exact `.canvas.json`; generic JSON remains ignored; hidden/runtime directories remain ignored.
3. [ ] Add canvas kind/route/manifest capability and export inclusion using the standard nested error envelope.
4. [ ] Extend comment anchor parsing and legacy load migration.
5. [ ] Enforce delivery availability before create/reply/resolve/reopen; keep delete as a documented local-cleanup exception.
6. [ ] Add request-ID idempotency for create/reply/resolve/reopen that dedupes both serialized store mutations and steering delivery.

### Tests owned by P-server

- valid story map, journey map, plan, and spec examples parse;
- malformed JSON, oversized content, duplicate IDs, dangling edges, cyclic parents, invalid enum/string/coordinate limits fail with exact fields;
- fully omitted positions parse with `layout: "deterministic"`; mixed or present-invalid positions return 422 with the exact field path; no server test computes layout;
- scanner admits `.canvas.json`, ignores `.json`, preserves deterministic IDs/order;
- route returns 200/404/422 with standard shape and no content execution;
- export contains canvas artifact;
- legacy text anchors migrate; node anchors round-trip;
- no delivery callback: comment POST returns 503 and store/count/state file remain unchanged;
- callback present: one delivery and one durable item;
- retry the same request ID for create, reply, resolve, and reopen: same result and no second delivery; conflicting endpoint/body: 422;
- existing 20-way concurrency and forced-write-failure tests remain green.

### Incremental gate

Run focused parser/scanner/server/comment suites. Failure model: unsafe or unreachable artifacts, silent comment persistence, duplicate steering, or lost state.

## Phase 2 — Review rail + canvas vertical slice

### Production change

1. [ ] Pin versions that declare React 19 support (`@xyflow/react@12.11.2`, matching explicit `react`/`react-dom`, and a pinned `@floating-ui/dom` after inspecting the installed API), then add a Bun browser-bundle generator with committed output plus `--check` drift mode. `package.json`, `bun.lock`, generator, and generated assets have this single owner. The package check and binary build invoke the drift check under the repo-pinned Bun version.
2. [ ] Mount a React 19 + React Flow island only for canvas items. Memoize node types/callbacks, keep selection separate from the full node array, and collapse hidden groups for large canvases.
3. [ ] Implement the pure C5 deterministic layout in the client only when every position is omitted; explicit valid positions win and mixed/invalid positions never reach rendering.
4. [ ] Add toolbar: search, zoom out/in, fit, reset local layout, minimap toggle. Add empty/loading/invalid/ended states.
5. [ ] Implement accessible custom nodes for card/lane/group/milestone/decision/actor/step; title/body are text-only.
6. [ ] Replace the old comment drawer with the selected Review rail: `Open`, `Sent to agent`, `Resolved`; source excerpt/node, delivery status, retry/error, focus context, resolve/reopen/reply/delete actions.
7. [ ] Use Floating UI for selected-text composer. Canvas node selection invokes the same composer with a node anchor.
8. [ ] Disable feedback controls when manifest capability is false, preserve draft on 503, and retry with the same request ID.
9. [ ] Replace flow/diagram fullscreen actions with `Open flow`/`Open detail` native-dialog modal. Remove Fullscreen API calls, fallback classes, and fullscreen copy/CSS.
10. [ ] Preserve existing Markdown/Mermaid/mockup/question/share/navigation behavior.

### Tests owned by P-client

- generated bundle drift test and package/source import safety;
- host mount/update/focus/destroy behavior through a browser-capable test seam;
- canvas toolbar and search center/focus nodes;
- deterministic C5 layout exact positions for groups/children/topological columns/cycles, while authored positions remain byte-for-byte values;
- node selection opens composer with canvas-node anchor;
- no-feedback capability disables composer with explanation;
- 503 preserves draft and Retry reuses request ID;
- stale canvas-node 422 preserves draft, explains regeneration, and requires re-selection;
- review item focuses text mark or node;
- dialog opens, traps/restores focus, Escape/backdrop/Close work; no Fullscreen API invocation remains;
- 360/768/1280 layouts have no page overflow; rail becomes bottom sheet at narrow width;
- existing Markdown/mockup/question/anchoring tests remain green.
- canvas references navigate only to manifest items; unsafe/unresolved refs are inert text;

### Incremental gate

Start the real preview server from current source, open one `.canvas.json` artifact in the real browser, and exercise toolbar, node selection, modal, and no-agent failure path. Build/type tests alone do not close this phase.

## Phase 3 — agent generation vertical slice

### Production change

1. Update `presenter` to choose `.canvas.json` for spatial information; use Markdown for prose and self-contained HTML only for custom UI mockups.
2. Extend `preview-templates` with the exact version-1 schema, bounded values, artifact recipes, and examples for story map, journey map, plan, and specification.
3. Update relevant product skills to request a canvas companion only when spatial structure improves review; no mandatory duplicate artifact for prose-only work.
4. Route presenter to existing model rules; no new alias or provider contract.

### Tests owned by P-agent

- bundled agent/skill registration and frontmatter checks;
- semantic assertions that canvas schema/version/artifact kinds and review-only constraints are present;
- invoke the presenter once against a small story-map prompt and validate the emitted artifact through the real parser.

### Incremental gate

Run the actual presenter path and render its generated canvas in Product Preview. Reverting either the agent prompt or scanner/parser must break the proof.

## Phase 4 — integration and final verification

1. Generate four real canvas fixtures through the presenter: story map, journey map, plan, and specification.
2. Start a session-attached production preview server.
3. Browser path: open each artifact; pan/zoom/fit/search/minimap; select a node; send feedback; observe `Delivered to agent`; open/close modal; verify Review rail focus/resolution.
4. State path: inspect store/state to prove exactly one comment/feedback item for a retry and no item after standalone 503.
5. Continuous capstone: browser node comment reaches the owning session as a preview-feedback steering block containing canvas item ID, node ID/title, and body.
6. Verify 360/768/1280 widths, keyboard-only path, focus return, 200% zoom, reduced motion, long labels, 1,000-node stress sample, and no console errors.
7. Run package check and focused product-preview/agent/present suites once.
8. Two independent `ui_ux_reviewer` passes after production implementation; fix P0/P1 only, maximum two corrective iterations.
9. One code reviewer focuses on schema/input safety and comment delivery/idempotency.
10. Update `[Unreleased]` changelog and product docs after runtime gates pass.
11. Delete generated QA screenshots/temp fixtures and ensure runtime state is ignored. Leave the user’s active preview server running with a fresh URL.
12. Read `skill://verify-before-done`, collect exact command output, browser evidence, steering block, working-tree hygiene, and a final done-review verdict before claiming completion.

## Rollback and observability

- The change is additive at the artifact boundary: removing `.canvas.json` artifacts and the canvas bundle restores prior Markdown/HTML behavior.
- Existing items and comment IDs remain stable because IDs continue to derive from relative paths.
- Invalid canvas artifacts are isolated to their item and never crash navigation.
- Log one structured warning per invalid artifact load (path shortened; no content/PII), and delivery failures at the handling boundary. Avoid per-node logs and metrics cardinality.
- The signal to watch during manual rollout is canvas load failure count plus feedback `side_ask_unavailable` rate.

## Completion denominator

- 4 artifact recipes generated and rendered;
- all canvas routes/schema/scan tests green;
- one node-feedback browser-to-owning-session capstone observed;
- standalone comment 503 leaves store unchanged;
- existing Markdown/HTML/share/question contracts pass;
- 2 UI review passes clear P0/P1;
- final independent QA and done-review return PASS.
