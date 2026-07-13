/**
 * P3 throwaway dev harness.
 *
 * Serves CLIENT_ASSETS verbatim + fakes the real server routes (manifest, doc,
 * SSE events) so the client can be exercised in a real browser WITHOUT the
 * real server.ts (owned by P2). Not imported by production code.
 *
 * Run:  bun src/product-preview/client/dev-harness.ts
 * Then open the printed URL in a browser.
 */

import { CLIENT_ASSETS } from "./assets";

const PORT = Number(process.env.PREVIEW_PORT) || 4877;

// --- Fake bundle -------------------------------------------------------

const SPEC_MD = `# Spec: Auth & Invites

## Problem
Teams need a safe way to invite members without exposing the full workspace.

## Direction & why
Token-based invites with expiry keep blast radius small. We avoid email-based
magic links because deliverability is unreliable for self-hosted installs.

## Stories

**Persona:** Owner
Acceptance criteria:
- Owner sees pending invites in a list
- Owner can revoke an invite before it is accepted
- Revoked invite shows a "revoked" badge

### S2 Teammate accepts invite
**Persona:** Teammate
Acceptance criteria:
- Clicking invite link shows workspace name
- Accepting creates a session cookie
- Expired invite shows a clear error

### S3 Auth handles expired invites
**Persona:** Teammate
Acceptance criteria:
- Expired invite returns a friendly message
- Owner is notified that the invite expired
- No session is created for expired tokens

## Cut-lines
| NOW | NEXT | NOT |
| invite flow | viewer identity (multi-team use) | public share (funnel risk) |
| revoke + badge | rate limiting | email magic links |
`;

const ARCH_MD = `# Architecture

## Overview

\`\`\`mermaid
flowchart LR
  A[Client] --> B[API Gateway]
  B --> C[Auth Service]
  C --> D[(User Store)]
\`\`\`

## Decisions

### ADR-1 Token-based invites

We chose opaque random tokens over JWT for invites because they are revocable
without a shared secret rotation.
`;

const BRIEF_MD = `# Brief: Product Preview WebUI

A live, read-only preview of product artifacts (specs, design, architecture)
rendered from the docs tree, with an optional share + side-ask channel.
`;

const ITEMS = [
	{
		id: "a1b2c3d4e5f6",
		kind: "spec" as const,
		relPath: "specs/auth-invites.md",
		title: "Spec: Auth & Invites",
		mtimeMs: Date.now() - 2 * 60 * 1000,
		size: SPEC_MD.length,
	},
	{
		id: "b2c3d4e5f6a1",
		kind: "architecture" as const,
		relPath: "architecture/overview.md",
		title: "Architecture",
		mtimeMs: Date.now() - 10 * 60 * 1000,
		size: ARCH_MD.length,
	},
	{
		id: "c3d4e5f6a1b2",
		kind: "brief" as const,
		relPath: "brief.md",
		title: "Brief: Product Preview WebUI",
		mtimeMs: Date.now() - 60 * 60 * 1000,
		size: BRIEF_MD.length,
	},
];

const CONTENTS: Record<string, string> = {
	[ITEMS[0].id]: SPEC_MD,
	[ITEMS[1].id]: ARCH_MD,
	[ITEMS[2].id]: BRIEF_MD,
};

const MANIFEST = {
	bundle: {
		title: "Product Preview WebUI",
		root: "docs/product",
		generatedAt: Date.now(),
	},
	items: ITEMS,
};

// --- SSE clients -------------------------------------------------------

const sseClients = new Set<ReadableStreamDefaultController<Uint8Array>>();
let sideAskWindowStart = Date.now();
let sideAskCount = 0;

function broadcast(event: string, data: unknown) {
	const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
	for (const controller of sseClients) {
		try {
			controller.enqueue(new TextEncoder().encode(payload));
		} catch {
			sseClients.delete(controller);
		}
	}
}

// --- Server ------------------------------------------------------------

const server = Bun.serve({
	port: PORT,
	async fetch(req) {
		const url = new URL(req.url);
		const path = url.pathname;

		// Static client assets
		const asset = CLIENT_ASSETS[path];
		if (asset) {
			return new Response(asset.body, {
				headers: { "Content-Type": asset.contentType, "Cache-Control": "no-cache" },
			});
		}

		// Fake API routes
		if (path === "/api/manifest") {
			return Response.json(MANIFEST);
		}

		const docMatch = path.match(/^\/api\/doc\/([a-f0-9]+)$/);
		if (docMatch) {
			const id = docMatch[1];
			const item = ITEMS.find(i => i.id === id);
			const content = CONTENTS[id];
			if (!item || !content) return new Response("Not found", { status: 404 });
			return Response.json({ item, content });
		}

		if (path === "/api/side-ask" && req.method === "POST") {
			// Reset rate window each minute
			const now = Date.now();
			if (now - sideAskWindowStart > 60_000) {
				sideAskWindowStart = now;
				sideAskCount = 0;
			}
			sideAskCount++;
			// Echo to stdout so the browser POST is visible alongside the network panel.
			const sideAskBody = await req.json().catch(() => "(no body)");
			process.stdout.write(`[dev-harness] side-ask received: ${Bun.inspect(sideAskBody)}\n`);
			if (sideAskCount > 6) {
				return new Response("rate limited", { status: 429, headers: { "retry-after": "30" } });
			}
			return new Response(null, { status: 202 });
		}

		// SSE
		if (path === "/events") {
			const stream = new ReadableStream({
				start(controller) {
					sseClients.add(controller);
					// Heartbeat to keep alive
					const hb = setInterval(() => {
						try {
							controller.enqueue(new TextEncoder().encode(`: heartbeat\n\n`));
						} catch {
							clearInterval(hb);
							sseClients.delete(controller);
						}
					}, 15_000);
				},
				cancel() {
					// controller removed by caller
				},
			});
			return new Response(stream, {
				headers: {
					"Content-Type": "text/event-stream",
					"Cache-Control": "no-cache",
					Connection: "keep-alive",
				},
			});
		}

		return new Response("Not found", { status: 404 });
	},
});

// --- Simulated live edits (for testing SSE reload) --------------------
// Every 30s, touch a doc mtime and broadcast doc-changed so the client reloads.
setInterval(() => {
	const item = ITEMS[0];
	item.mtimeMs = Date.now();
	broadcast("doc-changed", { id: item.id, relPath: item.relPath });
}, 30_000);

process.stdout.write(
	`\n  Product Preview dev harness → http://localhost:${server.port}/\n` +
		`  Manifest: ${ITEMS.length} items (1 spec with stories + phases, 1 arch with mermaid, 1 brief)\n` +
		`  Try: select the spec → Story map tab → Phases tab\n` +
		`  Side-ask: type a question, Send (check network panel for x-ompx-preview header)\n` +
		`  SSE: waits 30s for a doc-changed reload, or restart this harness\n\n`,
);
