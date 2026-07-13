# Product Preview Review Canvas UI

**Status:** Approved by user direction; implementation contract
**Date:** 2026-07-13

## Product decision

Product Preview uses a **review canvas**, not a whiteboard editor.

- The agent creates and updates structured canvas artifacts.
- The reviewer pans, zooms, fits, searches, opens details, and may rearrange nodes locally for inspection.
- Reviewer feedback is always sent to the owning agent session.
- Review history remains visible so reviewers can track delivery and resolution; it is not a teammate chat surface.
- Flow and diagram detail opens in an accessible modal. The Fullscreen API is not part of this interaction.

The selected comment layout is **Option A: Review rail**. The document or canvas remains visible on the left; open feedback, agent activity, delivery failures, and resolved items remain visible in a persistent rail on the right.

## Component choices

### Canvas: `@xyflow/react` 12.x

Use React Flow as a React island inside the existing preview shell.

Reasons:

- MIT licensed and self-hosted.
- Structured nodes, edges, groups, parent-child containment, custom node components, minimap, controls, fit view, and serializable state are first-class.
- Better match for deterministic agent-generated story maps, journey maps, specifications, architectures, and plans than a freehand whiteboard.
- `tldraw` is rejected because its current default license prohibits production use without a paid license key.
- Excalidraw is retained only as a future fallback for explicitly freehand artifacts; it is not the primary data model.

### Selection composer: `@floating-ui/dom`

Use Floating UI to position the selected-text feedback composer. It handles viewport collision, scrolling, and resize. The existing text anchoring algorithm remains the persistence contract for Markdown documents.

### Modal: native `<dialog>`

Use the platform dialog element for node/flow inspection. It provides the correct modality primitive without adopting an archived or framework-heavy component package. Production behavior includes focus entry, focus return, Escape close, backdrop close, labelled title, scroll containment, and reduced-motion treatment.

### Build boundary

The current product-preview client is a static vanilla IIFE. Preserve the shell, server, navigation, SSE refresh, share controls, and existing Markdown/mockup paths. Add a generated browser bundle for a React canvas island instead of rewriting the whole client.

- Source: `src/product-preview/client/canvas-app.tsx`
- Generated browser asset: `src/product-preview/client/generated/canvas-app.js`
- Generated stylesheet: `src/product-preview/client/generated/canvas-app.css`
- The generated assets are committed and checked for drift so source-mode CLI, compiled binary, and packaged installs behave identically.
- The vanilla shell mounts the island only for `kind: "canvas"` items.
- Canvas selection emits a typed host event; the shell opens the shared Review rail and composer.

## Artifact contract

Agents write a dedicated `*.canvas.json` artifact. Generic `.json` files remain ignored.

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

Validation is strict and bounded at the HTTP edge:

- document ≤ 2 MiB;
- ≤ 2,000 nodes and ≤ 4,000 edges;
- unique opaque IDs, each ≤ 128 characters;
- all edge endpoints and `parentId` references must exist;
- positions are all-or-none. When every position is omitted the client applies the deterministic layout; when every position is supplied, coordinates must be finite within ±1,000,000. Mixed, malformed, or out-of-range positions are rejected rather than repaired. The server validates only and never computes layout; zoom is within 0.1–4;
- title ≤ 200, body/description ≤ 4,000, edge label ≤ 200; each `refs[].path` is ≤512 characters, relative, has no scheme, absolute root, or `..` segment;
- no HTML, scripts, style strings, URLs, or arbitrary React Flow props; a reference becomes clickable only when its path resolves to an item in the current manifest, otherwise it renders as inert text;
- only the enumerated node, edge, status, and role values are accepted.

Invalid artifacts appear in the manifest but open to a safe error state naming the invalid field and recovery action. They never execute content.

All API failures use the existing product-preview envelope `{ error: { code, message, field? } }`; canvas validation never introduces a route-specific shape.

Deterministic layout has one owner: the client island. It preserves source array order as the tie-breaker, lays top-level lanes/groups left-to-right, children top-to-bottom within parents, and remaining nodes in topological columns from sequence/dependency edges; cycles and unordered nodes use stable source-order rows. Authored positions remain unchanged.

## Reachability

1. Product skills and the `presenter` agent may emit `docs/product/canvases/<name>.canvas.json` for spatial artifacts.
2. The scanner admits only the exact `.canvas.json` suffix and assigns `kind: "canvas"`.
3. The manifest exposes the canvas item additively; existing Markdown and HTML IDs remain unchanged.
4. `GET /api/canvas/<id>` reads, parses, validates, and returns `{ item, canvas }`.
5. The client mounts the React Flow island for canvas items.
6. Node selection and selected-text feedback both open the same Review rail.
7. Feedback delivery enters the owning agent session through the existing preview-feedback message type.
8. Export includes the original `.canvas.json` artifact.

## Canvas layouts

The artifact type changes the default deterministic layout recipe, not the schema.

### Story map

- horizontal journey sequence across the top;
- vertical slices below each activity;
- releases or priorities represented as horizontal lanes;
- story cards use status and risk roles sparingly.

### Journey map

- phases form columns;
- actor/actions, touchpoints, evidence, pain points, and opportunities form labelled swimlanes;
- sequence edges show movement through phases;
- detail modal holds long evidence instead of expanding every node.

### Plan

- phases form groups from left to right;
- tasks are cards inside phase groups;
- dependency edges cross groups only when necessary;
- milestones and blocked decisions use dedicated node types.

### Specification or architecture

- primary capabilities form the central hierarchy;
- decisions and risks attach as secondary nodes;
- references link back to the source Markdown path and anchor;
- architecture flows can open in the node/flow modal for focused inspection.

## Review interaction

### Select and send

1. Selecting text in a document shows a Floating UI action bubble.
2. Selecting a canvas node shows an anchored `Comment` action and highlights the node.
3. The composer identifies the owning agent and the selected quote or node.
4. Primary CTA is always **Send to agent**.
5. Submission states: `Ready`, `Sending`, `Delivered to agent`, `Resolved`. The UI never claims `Agent working` without a real agent acknowledgement signal.
6. If no owning session exists, submission returns `503 side_ask_unavailable` before mutation, preserves the draft in the browser, and shows **Couldn’t reach the agent. Reconnect the preview and retry.** The UI never presents a saved-only success.
7. Retry reuses the same client request ID. The server stores it with the review item and deduplicates both durable creation and steering enqueue.
8. Create, reply, resolve, and reopen are agent instructions and require live delivery. Delete is local, permission-checked cleanup and remains available after the session ends without emitting steering.
9. Every steering-emitting operation (create, reply, resolve, reopen) carries a client request ID and is deduplicated across both storage and agent enqueue. A stale canvas node is revalidated from the current artifact at POST time; `422 invalid_anchor` preserves the draft and requires node re-selection.

### Review rail

- tabs: `Open`, `Sent to agent`, `Resolved`;
- each item shows source context, author, truthful delivery state, and actions appropriate to state;
- clicking an item focuses its text mark or canvas node and centers it in view;
- resolving hides the active marker but retains history;
- replies remain follow-up instructions to the agent, not user-to-user chat.

### Canvas navigation

- pointer: pan, wheel/pinch zoom, click to select, double-click to open detail;
- controls: zoom out, zoom in, fit, reset layout, minimap toggle;
- search finds node title/body and centers the selected result;
- keyboard: Tab traverses toolbar and nodes, Enter opens node, arrow keys move focus between nearby nodes, `0` fits view, `+`/`-` zoom, Escape closes modal or clears selection;
- local node movement is view-only and resets when the artifact reloads; it does not mutate source.

### Modal viewer

- opens from `Open flow` or node detail;
- remains inside the product page rather than entering fullscreen;
- contains title, source reference, zoom controls, fit, and Close;
- traps focus while open and restores focus to the invoking node or button;
- at narrow widths it uses the full viewport area while remaining a dialog.

## Visual system

Use the current preview neutral-blue tokens and dense review-product hierarchy:

- quiet canvas background with a subtle dot grid;
- white nodes with semantic left-edge accents, not decorative gradients;
- 8 px radius scale, restrained elevation only for active composer/modal;
- persistent right rail around 320 px at desktop widths;
- rail becomes a bottom sheet below the content breakpoint;
- status is always icon/text plus color;
- no Atlassian logos, copied branding, fake avatars, badge soup, glassmorphism, or freehand aesthetic.

## States

- **Loading:** canvas skeleton matching groups and rail; `aria-busy` on the canvas region.
- **Empty:** explain that the agent has not generated a canvas and offer `Ask agent to create canvas` only when a session exists.
- **Invalid artifact:** identify the field and file; preserve navigation and offer `Send error to agent`.
- **Disconnected agent:** browsing remains available; composer preserves draft and offers Retry after reconnection.
- **Large canvas:** progressively show collapsed groups; search and minimap remain available.
- **Ended preview:** canvas remains readable; feedback controls are disabled with an explanation.

## Acceptance

1. A generated story map, journey map, plan, and specification canvas each render with the correct grouping recipe from safe `.canvas.json` input.
2. Selecting a node and sending feedback reaches the owning agent in one continuous browser-to-session run; the Review rail changes from Sending to Delivered.
3. A server without `deliverFeedback` returns 503 before creating a review item; the draft remains in the composer and Retry works after reconnect.
4. The canvas supports pan, zoom, fit, minimap, search, node focus, and modal inspection at 360, 768, and 1280+ widths without horizontal page overflow.
5. The flow viewer uses `<dialog>` and no Fullscreen API path remains for flow/diagram.
6. Existing Markdown, Mermaid, custom HTML mockups, answers, share links, comments, and exported bundles remain functional.
7. Package check, schema/parser tests, scanner/server/integration suites, generated-asset drift check, and browser checks pass.
