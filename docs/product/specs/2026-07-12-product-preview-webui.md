# Product Preview WebUI — Product Spec (2026-07-12)

## Problem (from brief)

**Problem statement**: After the product pipeline produces artifacts (briefs, specs, wireframes, mockups, architecture docs), the owner reviews them as raw markdown in a terminal and teammates cannot see or comment on them at all. Review friction hides big-picture gaps until implementation.
**Who + how many**: OMPx users running the product skills — solo owner-devs and their tailnet teammates [reported: user request, 3 requirement rounds]
**Trigger & frequency**: every product/architecture phase review gate — several times per feature [reported]
**Cost of pain**: slow reviews, feedback lost outside the agent session, teammates re-briefed manually, remote machines re-plan from scratch [reported]
**Today's alternative**: terminal ASCII rendering + screen sharing + copy-pasting docs into chat [reported]
**Job-to-be-done**: When my agent finishes a product/architecture phase, I want to review the whole picture visually and feed comments straight back into the session, so I can approve or redirect in minutes.
**Success signal**: `present` tool invocations appear in product-phase sessions (tracked by omp-stats) and feedback round-trips (annotate/side-ask deliveries) occur without leaving the browser.
**Original request (verbatim, condensed)**: webUI preview + annotate feedback/comment + story map/phases/overview/mockups + architecture view (mermaid/C4) + live reload + side ask + agent-invokable tool + general data/server/client + Tailscale share with token + teammate copy-prompt pull.

## Direction & why

In-process Bun.serve module inside `packages/coding-agent` with a zero-build embedded client. Chosen over a separate package/React dashboard (stats-style) because the server must reach the agent session (YieldQueue for side-asks) in-process, and text-import embedding removes an entire build/embed pipeline; over terminal-only rendering because rects, story maps, and C4 diagrams need a real canvas. Validated by two adversarial review rounds (all blockers closed — see architecture doc ADRs).

## Non-goals

- Public-internet sharing (Tailscale Funnel explicitly refused at share-enable).
- Editing artifacts from the browser — the agent stays the only writer; the web is a read+feedback surface.
- Per-viewer identity/audit on the tailnet (v1 trust = token possession; NEXT trigger below).
- Real-time collaborative cursors/presence (YAGNI).
- Replacing `ompx stats` or the TUI mermaid path.

## Stories & acceptance criteria

**S1 — Review rendered artifacts** (Owner). As the owner, when my agent reaches a review gate, I can open the preview and see every artifact rendered (markdown, wireframes, mermaid incl. C4, HTML mockups), so I review the big picture fast.
- AC1: `GET /` lists all bundle items grouped by kind; clicking renders the doc with mermaid diagrams drawn and ASCII wireframes in monospace blocks.
- AC2: a bundle of 50 mixed docs renders its nav in <1s on localhost.
- AC3: a doc with invalid mermaid shows the code block + a parse-error badge instead of a blank pane.

**S2 — Story map & phases at a glance** (Owner). As the owner, I can see specs as a story-map board and cut-line phases as a NOW/NEXT/NOT table, so scope is visible without reading walls of text.
- AC1: docs of kind=spec render a board of stories parsed from `## Stories & acceptance criteria` with a "parsed N/M stories" indicator.
- AC2: parse failure or 0 stories → automatic raw-markdown fallback, indicator shows the failure, never a blank board.
- AC3: `## Scope & cut-lines` tables render as a three-column phase view.

**S3 — Rect feedback on any doc** (Owner). As the owner, I can draw rectangles + comment on any rendered doc or mockup via the existing annotate overlay, so visual feedback lands in the agent session with a screenshot.
- AC1: with annotate mode on, a rect+comment submission arrives in the owner session as the standard annotation message (screenshot attached).
- AC2: mockups annotated via the loopback raw route render full-page (no nested scroll traps).

**S4 — Side-ask from the page** (Owner + Teammate). As a viewer, I can type a question/refine request in a side panel, so the owner agent receives it without me touching the terminal.
- AC1: POST /api/side-ask with comment 1..10000 chars → 202 and the owner agent receives it labeled `[side-ask from <peer> via shared preview]` wrapped in the untrusted envelope; envelope delimiters in the comment arrive escaped.
- AC2: missing `X-OMPX-Preview: 1` header → 403; comment >10k → 422 error envelope; 7th request in a minute from one IP → 429.
- AC3: no owner session wired (standalone CLI) → 503 with body explaining the in-session requirement, and the box shows that hint.

**S5 — Live reload** (Owner + Teammate). As a viewer, when the agent edits artifacts, the open page updates within ~2s, so I never review stale content.
- AC1: editing a doc on disk → `doc-changed` SSE within 2s; the open doc re-renders; the nav updates on add/remove.
- AC2: SSE connection dropped → client banner "reconnecting…" and automatic resubscribe with a full manifest refresh.
- AC3: a multi-file write burst (5 files in 300ms) produces one settled refresh, not five torn renders.

**S6 — Human-gated share** (Owner). As the owner, I can enable sharing with a keystroke command (never the agent alone), so a teammate on my tailnet can view with a token URL.
- AC1: `/product-preview share on` (or CLI `--share`) prints share URL + token to the TUI; the model-visible result is redacted.
- AC2: `present(share: true)` from the agent → tool error directing to the slash command; no server state change.
- AC3: share on with no Tailscale interface → refusal with a clear error (never binds 0.0.0.0); active Funnel on the port → refusal naming Funnel.
- AC4: `share off` → token, cookie sessions, and export tokens revoked; open shared tabs receive `share-revoked` SSE and show a "sharing ended" screen; subsequent requests 401.

**S7 — Teammate viewing** (Teammate). As a teammate, I can open the share URL once with the token and then browse normally, so the token doesn't live in every link I click.
- AC1: first `GET /?t=<token>` → HttpOnly SameSite=Strict cookie + 302 to `/` (query stripped); browsing works cookie-only.
- AC2: wrong/absent token from non-loopback → uniform 401 (no existence hints); 11th bad attempt in a minute from one IP → temporary throttle.
- AC3: cookie replayed against a different Host (or after share-off) → 401.
- AC4: teammates never see the share panel/token; mockup raw route from non-loopback → 403 (framed sandboxed mockup still renders).

**S8 — Pull-to-implement handoff** (Teammate). As a teammate, I can copy a prompt from the share panel into my own ompx session, so my agent pulls the bundle and plans implementation from the same artifacts.
- AC1: share panel (owner, loopback only) shows a copyable prompt containing: env-var bearer form (`OMPX_ET=… curl -H "Authorization: Bearer $OMPX_ET" …/api/export | tar -xz --no-same-owner -C docs/product-shared/<bundle-id>/`), fresh-dir instruction, and untrusted-content warning telling the receiving agent to review with its user before acting.
- AC2: export token is single-use with 15-min TTL: second use or expiry → 401; export tar contains only regular files with sanitized relative paths.
- AC3: unpacking yields the exact scanned bundle files (byte-identical spot check).

**S9 — Agent-invokable present** (Agent). As the agent at a review gate, I can call the `present` tool, so the preview is served and opened in one call.
- AC1: `present({})` starts (or reuses) the server on docs/product, opens the browser tab when `open` ≠ false, returns local URL + item count.
- AC2: `present({root, extraPaths})` serves an arbitrary doc set (kind=doc) — general mode.
- AC3: repeated `present` calls reuse the running server and trigger a rescan, not a second server.

## Journey & states

Journey: agent finishes phase → calls `present` → browser opens → owner reviews (S1-S2) → annotates/side-asks (S3-S4) → agent refines → live reload (S5) → owner approves → share on (S6) → teammate reviews + side-asks (S7) → teammate pulls to implement (S8).

Per-surface states (design doc carries the wireframes):

| Surface | Empty | Loading | Error | Success | Partial |
|---|---|---|---|---|---|
| Nav/tree | "No artifacts under <root>" + hint to run product skills | skeleton | scan error banner | grouped tree | stale badge while rescanning |
| Doc view | "Select a document" | spinner | 404 doc removed → nav refresh; mermaid parse badge | rendered md | reconnecting banner |
| Story map | no specs → hidden tab | — | parse fail → raw fallback + indicator | board + N/M indicator | partial parse (some stories) + indicator |
| Phases | no cut-lines → hidden | — | raw fallback | NOW/NEXT/NOT columns | — |
| Mockups | none → hidden tab | iframe onload | 404; raw route 403 for non-loopback | framed sandbox render | — |
| Share panel (owner/loopback only) | share off → enable instructions (slash command text) | enabling… | no tailscale / funnel error verbatim | URL+token+handoff prompt+copy buttons | rotated → old token marked revoked |
| Side-ask box | placeholder text | sending… | 403/422/429/503 messages verbatim from error envelope | "delivered" toast | rate-limited countdown |

Cross-cutting: permissions matrix = loopback owner {view, annotate raw mockups, share panel, side-ask} vs share viewer {view, side-ask} vs token-less {401}. i18n: English-only v1 (matches ompx TUI; internal dev tool) — named limitation. Abuse: caps/limits per S4/S7. Concurrency: N viewers read-only + SSE broadcast; rescan during read → next SSE wins; two `present` calls → single server (S9-AC3). Data lifecycle: share off revokes everything; artifacts remain plain files owned by the user; no server-side persistence.

## Scope & cut-lines

| Phase | Contents |
|---|---|
| NOW | S1-S9 full production grade (vertical slices per the implementation plan — draft, activates on this spec's approval) |
| NEXT (named triggers) | per-viewer identity + comment audit (trigger: recurring multi-team use or "who said this" asked); annotate anchors on mermaid nodes (trigger: node-level feedback requested); static HTML export for non-tailnet stakeholders (trigger: first such stakeholder) |
| NOT | public-internet share (funnel risk, refused); browser-side doc editing (agent stays sole writer); realtime presence (YAGNI) |

## Metrics & guardrails

Hypothesis: shipping in-browser preview+feedback to product-skill users increases review-gate feedback round-trips because visual review lowers friction.
- Primary: `present` tool invocations per product-phase session (omp-stats tool tracking, existing).
- Guardrails: side-ask delivery failures = 0 in logs; preview server crash count = 0; no `token` strings in any log line (grep gate in tests).
- Kill/iterate: if `present` stays ~0 across 30 days of product-skill usage, remove the skill-gate offers and revisit UX.

## Open questions & risks

| Item | Owner | Default |
|---|---|---|
| MagicDNS hostname in share URL (nicer than IP) | implement-time | v1 = IP only |
| mermaid bundle size in binary (~2-3MB) acceptable? | verify at P7 | yes unless binary gate fails |
| Story-map parse resilience against future skill-template drift | spec+skill co-owned | indicator + raw fallback (never blank) |

Self-check: rubric of skill://product-spec applied — no TBD, every story ≥1 failure-class AC, permissions matrix present, criteria observable, metrics mapped to an existing tracker, non-goals non-empty, no two-way readings found on re-read.

## v2

**S10 — Per-section comments** (Owner + Teammate). As a viewer, I can select prose in a rendered document and add a comment to that exact section, so feedback remains tied to the source even after a review session.
- AC1: selecting non-injected document text shows a Comment action that stores a W3C TextQuoteSelector-style anchor (`quote`, 32-character `prefix`, `suffix`) and the comment body; matching text is marked again after every re-render.
- AC2: the comment panel shows threads with replies and a resolved state; anchors that no longer resolve after an edit remain visible under "Orphaned" rather than disappearing.
- AC3: delete is offered only when the API marks a comment `mine`; the server authorizes it by the owning share-cookie session (or loopback identity), never by the display name.

**S11 — Interactive option questions** (Owner + Teammate). As a viewer, I can answer an option question embedded in a product document, so the agent receives a clear choice instead of inferring it from free-form feedback.
- AC1: a valid `ompx-question` fenced JSON block renders as a single- or multi-select question card; malformed blocks remain visible as source code.
- AC2: submitting a selection persists the answer and delivers it to the owner agent; the card displays its answered state and supports changing the answer.
- AC3: an answered card stays answered after document refresh or live-reload; answers are hydrated per item on every render.

**S12 — Custom presentation templates** (Presenter). As a presenter agent, I can create a self-contained HTML template that asks the viewer for feedback, so story maps, journey boards, and UI mockups can be interactive without a separate app.
- AC1: HTML mockups render in a sandboxed preview iframe with a server-injected `window.OmpxPreview` bridge exposing `sendPrompt`, `submitAnswer`, and `ready`.
- AC2: bridge prompts and answers are validated by the parent preview and delivered to the owning agent session as preview feedback; template authors never add their own bridge script tag.
- AC3: the raw mockup route remains loopback-only for annotation; sharing renders only the framed, sandboxed branch.

**S13 — Focused review mode** (Owner + Teammate). As a viewer, I can fullscreen the content I am reviewing, so dense documents, diagrams, and mockups are readable without surrounding chrome.
- AC1: document-pane, diagram, and mockup controls enter fullscreen when available and provide an explicit close control; Escape exits.
- AC2: browsers without the fullscreen API use the styled fullscreen fallback and retain a usable exit control.

**S14 — Presenter capability** (Agent). As the product workflow agent, I can delegate custom visual artifacts to a bundled presenter agent with template guidance, so interactive presentations follow the preview's security and bridge contract.
- AC1: the `presenter` agent is registered with the designer route and the `preview-templates` skill loaded automatically.
- AC2: the skill requires one self-contained responsive HTML file, inline CSS/JS, no external network requests or CDNs, and no manually included bridge script.


## Preview feedback question

```ompx-question
{"id":"product-preview-review-priority","question":"What should the next product-preview review focus on?","options":[{"label":"Comment workflow"},{"label":"Story map clarity"},{"label":"Share flow"}],"multi":false}
```
