import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { commands } from "../src/cli-commands";
import {
	makeShareController,
	PreviewCommentStore,
	type PreviewFeedback,
	type PreviewServerHandle,
	ROUTE_ANSWER,
	ROUTE_ANSWERS,
	ROUTE_COMMENTS,
	ROUTE_COMMENTS_DELETE,
	ROUTE_COMMENTS_REPLY,
	ROUTE_COMMENTS_RESOLVE,
	ROUTE_DOC,
	ROUTE_EXPORT,
	ROUTE_MANIFEST,
	ROUTE_MOCKUP_FRAMED,
	ROUTE_SIDE_ASK,
	type ShareController,
	SIDE_ASK_HEADER,
	startPreviewServer,
} from "../src/product-preview";
import * as commentsModule from "../src/product-preview/comments";
import { BUILTIN_SLASH_COMMAND_DEFS } from "../src/slash-commands/builtin-registry";
import { BUILTIN_TOOLS } from "../src/tools";

const APP_CSP =
	"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; form-action 'none'; base-uri 'none'";
const RAW_MOCKUP_CSP =
	"sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; form-action 'none'";
const PRODUCT_ROOT = path.resolve(import.meta.dir, "../../../docs/product");

const handles: PreviewServerHandle[] = [];
const roots: string[] = [];

afterEach(async () => {
	for (const handle of handles.splice(0)) await handle.stop();
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
	vi.restoreAllMocks();
});

function endpoint(handle: PreviewServerHandle, route: string): string {
	return `${handle.localUrl.slice(0, -1)}${route}`;
}

async function startFixtureServer(
	deliveries: PreviewFeedback[],
	options: { extraPaths?: string[]; beforeStart?: (root: string) => Promise<void> } = {},
): Promise<{
	handle: PreviewServerHandle;
	share: ShareController;
}> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "ompx-product-preview-integration-"));
	roots.push(root);
	await fs.writeFile(path.join(root, "product.md"), "# Product brief\n\nPreview content.\n");
	await fs.writeFile(path.join(root, "mockup.html"), "<!doctype html><title>Mockup</title><button>Ship</button>");
	await options.beforeStart?.(root);

	vi.spyOn(os, "networkInterfaces").mockReturnValue({
		tailscale0: [
			{
				address: "100.101.102.103",
				family: "IPv4",
				internal: false,
				mac: "00:00:00:00:00:00",
				netmask: "255.192.0.0",
				cidr: "100.64.0.0/10",
			},
		],
	});
	const real = makeShareController();
	// The real controller resolves the mocked tailnet IP (100.101.102.103),
	// which is not bindable in tests. Amendment A1 makes enableShare() actually
	// bind info.host, so wrap the real controller and point the listener at the
	// loopback alias 127.0.0.2 while keeping the real token/export logic.
	const share: ShareController = {
		enabled: () => real.enabled(),
		enable: async (port: number) => {
			const info = await real.enable(port);
			return { ...info, host: "127.0.0.2", shareUrl: `http://127.0.0.2:${info.port}/?t=${info.token}` };
		},
		disable: () => real.disable(),
		verifyToken: candidate => real.verifyToken(candidate),
		mintExportToken: () => real.mintExportToken(),
		consumeExportToken: candidate => real.consumeExportToken(candidate),
		handoffPrompt: (info, bundleId) => real.handoffPrompt(info, bundleId),
	};
	const handle = await startPreviewServer({
		extraPaths: options.extraPaths,
		root,
		port: 0,
		share,
		deliverFeedback: delivery => deliveries.push(delivery),
	});
	handles.push(handle);
	return { handle, share };
}

describe("product preview public integration", () => {
	test("registers present, CLI, and slash command entry points", () => {
		expect(BUILTIN_TOOLS.present).toBeDefined();
		expect(commands.some(command => command.name === "product-preview")).toBe(true);
		expect(BUILTIN_SLASH_COMMAND_DEFS.some(command => command.name === "product-preview")).toBe(true);
	});

	test("serves real artifacts through the public entry point", async () => {
		const handle = await startPreviewServer({ root: PRODUCT_ROOT, port: 0 });
		handles.push(handle);

		const shell = await fetch(handle.localUrl);
		expect(shell.status).toBe(200);
		expect(shell.headers.get("content-security-policy")).toBe(APP_CSP);
		expect(await shell.text()).toContain('class="app"');

		const manifestResponse = await fetch(endpoint(handle, ROUTE_MANIFEST));
		expect(manifestResponse.status).toBe(200);
		const manifest = (await manifestResponse.json()) as {
			items: Array<{ id: string; relPath: string }>;
		};
		expect(manifest.items.length).toBeGreaterThan(0);
		const artifact = manifest.items.find(item => item.relPath.startsWith("specs/"));
		expect(artifact).toBeDefined();

		const documentResponse = await fetch(endpoint(handle, `${ROUTE_DOC}${artifact?.id ?? "missing"}`));
		expect(documentResponse.status).toBe(200);
		expect((await documentResponse.json()) as { content: string }).toMatchObject({
			content: expect.stringContaining("Product Preview WebUI"),
		});
	});

	test("delivers side-asks and exports only scanned files", async () => {
		const deliveries: PreviewFeedback[] = [];
		const { handle, share } = await startFixtureServer(deliveries);
		const manifest = (await (await fetch(endpoint(handle, ROUTE_MANIFEST))).json()) as {
			items: Array<{ id: string; relPath: string }>;
		};
		const mockup = manifest.items.find(item => item.relPath === "mockup.html");
		expect(mockup).toBeDefined();

		const mockupResponse = await fetch(endpoint(handle, `${ROUTE_MOCKUP_FRAMED}${mockup?.id ?? "missing"}`));
		expect(mockupResponse.status).toBe(200);
		expect(mockupResponse.headers.get("content-security-policy")).toBe(RAW_MOCKUP_CSP);
		const mockupHtml = await mockupResponse.text();
		// Direct template document with bridge injected — no nested srcdoc shell.
		expect(mockupHtml).toContain("window.OmpxPreview");
		expect(mockupHtml).not.toContain("srcdoc=");
		expect(mockupHtml).toContain("<button>Ship</button>");

		const askResponse = await fetch(endpoint(handle, ROUTE_SIDE_ASK), {
			method: "POST",
			headers: { "Content-Type": "application/json", [SIDE_ASK_HEADER]: "1" },
			body: JSON.stringify({ comment: "Can we change <this>?", itemId: mockup?.id }),
		});
		expect(askResponse.status).toBe(202);
		expect(deliveries).toEqual([
			expect.objectContaining({
				type: "side-ask",
				source: "user",
				comment: "Can we change &lt;this&gt;?",
				itemId: mockup?.id,
				viaShare: false,
			}),
		]);

		const shareInfo = await handle.enableShare();
		const unauthorized = await fetch(`${handle.localUrl}?t=not-a-valid-share-token`);
		expect(unauthorized.status).toBe(401);

		const exchange = await fetch(`${handle.localUrl}?t=${shareInfo.token}`, { redirect: "manual" });
		expect(exchange.status).toBe(302);
		expect(exchange.headers.get("location")).toBe("/");
		expect(exchange.headers.get("set-cookie")).toContain("HttpOnly");

		const exportToken = share.mintExportToken();
		const archiveResponse = await fetch(endpoint(handle, ROUTE_EXPORT), {
			headers: { Authorization: `Bearer ${exportToken}` },
		});
		expect(archiveResponse.status).toBe(200);
		const archive = new Bun.Archive(await archiveResponse.bytes());
		const files = await archive.files();
		expect([...files.keys()].sort()).toEqual(["mockup.html", "product.md"]);
		expect(await files.get("product.md")?.text()).toContain("Preview content.");
	});

	test("keeps symlinked extra files out of manifest, document routes, and exports", async () => {
		const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ompx-product-preview-export-secret-"));
		try {
			const { handle, share } = await startFixtureServer([], {
				extraPaths: ["extras/reference.txt", "extras/secret.canvas.json"],
				beforeStart: async root => {
					await Promise.all([
						Bun.write(path.join(root, "extras", "reference.txt"), "safe reference"),
						Bun.write(path.join(outsideRoot, "secret.canvas.json"), '{"secret":"must not leak"}'),
					]);
					await fs.symlink(
						path.join(outsideRoot, "secret.canvas.json"),
						path.join(root, "extras", "secret.canvas.json"),
					);
				},
			});
			const manifest = (await (await fetch(endpoint(handle, ROUTE_MANIFEST))).json()) as {
				items: Array<{ id: string; relPath: string }>;
			};
			expect(manifest.items.map(item => item.relPath).sort()).toEqual([
				"extras/reference.txt",
				"mockup.html",
				"product.md",
			]);
			const secretId = new Bun.CryptoHasher("sha256").update("extras/secret.canvas.json").digest("hex").slice(0, 12);
			expect((await fetch(endpoint(handle, `${ROUTE_DOC}${secretId}`))).status).toBe(404);

			await handle.enableShare();
			const exportToken = share.mintExportToken();
			const archiveResponse = await fetch(endpoint(handle, ROUTE_EXPORT), {
				headers: { Authorization: `Bearer ${exportToken}` },
			});
			expect(archiveResponse.status).toBe(200);
			const archive = new Bun.Archive(await archiveResponse.bytes());
			expect([...(await archive.files()).keys()].sort()).toEqual([
				"extras/reference.txt",
				"mockup.html",
				"product.md",
			]);
		} finally {
			await fs.rm(outsideRoot, { recursive: true, force: true });
		}
	});

	test("rejects comments before mutation when no feedback callback is attached", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "ompx-product-preview-no-feedback-"));
		roots.push(root);
		await fs.writeFile(path.join(root, "product.md"), "# Product brief\n\nPreview content.\n");

		const handle = await startPreviewServer({ root, port: 0 });
		handles.push(handle);
		const manifest = (await (await fetch(endpoint(handle, ROUTE_MANIFEST))).json()) as {
			items: Array<{ id: string; relPath: string }>;
		};
		const product = manifest.items.find(item => item.relPath === "product.md");
		expect(product).toBeDefined();
		const itemId = product?.id ?? "missing";
		const headers = { "Content-Type": "application/json", [SIDE_ASK_HEADER]: "1" };

		const commentResponse = await fetch(endpoint(handle, ROUTE_COMMENTS), {
			method: "POST",
			headers,
			body: JSON.stringify({
				anchor: { type: "text", itemId, quote: "Preview", prefix: "", suffix: " content" },
				body: "must not persist without callback",
				requestId: "standalone-comment",
			}),
		});
		expect(commentResponse.status).toBe(503);
		await expect(commentResponse.json()).resolves.toMatchObject({
			error: { code: "side_ask_unavailable" },
		});

		const commentsResponse = await fetch(endpoint(handle, `${ROUTE_COMMENTS}?itemId=${itemId}`), {
			headers: { [SIDE_ASK_HEADER]: "1" },
		});
		expect(commentsResponse.status).toBe(200);
		expect((await commentsResponse.json()) as { comments: Array<{ id: string; mine: boolean }> }).toEqual({
			comments: [],
		});
		expect(await Bun.file(path.join(root, ".ompx-preview", "state.json")).exists()).toBe(false);

		// Answers remain independently durable without a session callback.
		const answerResponse = await fetch(endpoint(handle, ROUTE_ANSWER), {
			method: "POST",
			headers,
			body: JSON.stringify({
				questionId: "callback-free-question",
				itemId,
				question: "Ship it?",
				selection: ["yes"],
			}),
		});
		expect(answerResponse.status).toBe(202);
		const answersResponse = await fetch(endpoint(handle, `${ROUTE_ANSWERS}?itemId=${itemId}`), {
			headers: { [SIDE_ASK_HEADER]: "1" },
		});
		expect(answersResponse.status).toBe(200);
		expect((await answersResponse.json()) as { answers: Record<string, unknown> }).toMatchObject({
			answers: { "callback-free-question": expect.objectContaining({ selection: ["yes"] }) },
		});

		const state = JSON.parse(await Bun.file(path.join(root, ".ompx-preview", "state.json")).text()) as {
			comments: Array<{ body: string }>;
			answers: Record<string, unknown>;
		};
		expect(state.comments).toEqual([]);
		expect(state.answers).toHaveProperty("callback-free-question");
	});

	test("keeps loopback delete available after the owner session is absent", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "ompx-product-preview-delete-without-session-"));
		roots.push(root);
		await fs.writeFile(path.join(root, "product.md"), "# Product brief\n");
		const store = await PreviewCommentStore.load(root);
		const comment = await store.add({
			id: "persisted-comment",
			anchor: { type: "text", itemId: "product", quote: "Product", prefix: "", suffix: " brief" },
			body: "local cleanup remains allowed",
			author: "loopback",
			viaShare: false,
			ts: 1,
			resolved: false,
			replies: [],
			ownerSid: "loopback",
		});
		const handle = await startPreviewServer({ root, port: 0 });
		handles.push(handle);
		const headers = { "Content-Type": "application/json", [SIDE_ASK_HEADER]: "1" };
		const unavailableMutations = await Promise.all([
			fetch(endpoint(handle, ROUTE_COMMENTS_REPLY), {
				method: "POST",
				headers,
				body: JSON.stringify({ commentId: comment.id, body: "must not reply", requestId: "offline-reply" }),
			}),
			fetch(endpoint(handle, ROUTE_COMMENTS_RESOLVE), {
				method: "POST",
				headers,
				body: JSON.stringify({ commentId: comment.id, resolved: true, requestId: "offline-resolve" }),
			}),
			fetch(endpoint(handle, ROUTE_COMMENTS_RESOLVE), {
				method: "POST",
				headers,
				body: JSON.stringify({ commentId: comment.id, resolved: false, requestId: "offline-reopen" }),
			}),
		]);
		expect(unavailableMutations.map(response => response.status)).toEqual([503, 503, 503]);
		const unchanged = await PreviewCommentStore.load(root);
		expect(unchanged.list()).toEqual([expect.objectContaining({ id: comment.id, resolved: false, replies: [] })]);

		const response = await fetch(endpoint(handle, ROUTE_COMMENTS_DELETE), {
			method: "POST",
			headers: { "Content-Type": "application/json", [SIDE_ASK_HEADER]: "1" },
			body: JSON.stringify({ commentId: comment.id }),
		});
		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({ ok: true });
		const comments = await fetch(endpoint(handle, ROUTE_COMMENTS), { headers: { [SIDE_ASK_HEADER]: "1" } });
		await expect(comments.json()).resolves.toEqual({ comments: [] });
	});

	test("deduplicates steering comment mutations by client request ID", async () => {
		const deliveries: PreviewFeedback[] = [];
		const { handle } = await startFixtureServer(deliveries);
		const root = roots.at(-1)!;
		const manifest = (await (await fetch(endpoint(handle, ROUTE_MANIFEST))).json()) as {
			items: Array<{ id: string; relPath: string }>;
		};
		const itemId = manifest.items.find(item => item.relPath === "product.md")?.id;
		if (!itemId) throw new Error("fixture product item missing");
		const headers = { "Content-Type": "application/json", [SIDE_ASK_HEADER]: "1" };
		const post = async (route: string, payload: unknown): Promise<Response> =>
			await fetch(endpoint(handle, route), { method: "POST", headers, body: JSON.stringify(payload) });
		const readComment = async (
			response: Response,
		): Promise<{ id: string; resolved: boolean; replyCount: number }> => {
			const payload: unknown = await response.json();
			if (!payload || typeof payload !== "object" || !("comment" in payload))
				throw new Error("comment response missing");
			const comment = payload.comment;
			if (
				!comment ||
				typeof comment !== "object" ||
				!("id" in comment) ||
				typeof comment.id !== "string" ||
				!("resolved" in comment) ||
				typeof comment.resolved !== "boolean" ||
				!("replies" in comment) ||
				!Array.isArray(comment.replies)
			) {
				throw new Error("comment response malformed");
			}
			return { id: comment.id, resolved: comment.resolved, replyCount: comment.replies.length };
		};
		const create = {
			anchor: { type: "text", itemId, quote: "Preview", prefix: "", suffix: " content" },
			body: "dedupe create",
			requestId: "create-once",
		};

		const createResponses = await Promise.all([post(ROUTE_COMMENTS, create), post(ROUTE_COMMENTS, create)]);
		expect(createResponses.map(response => response.status)).toEqual([201, 201]);
		const comment = await readComment(createResponses[0]!);
		expect((await readComment(await post(ROUTE_COMMENTS, create))).id).toBe(comment.id);

		const reply = { commentId: comment.id, body: "dedupe reply", requestId: "reply-once" };
		const replyResponses = await Promise.all([post(ROUTE_COMMENTS_REPLY, reply), post(ROUTE_COMMENTS_REPLY, reply)]);
		expect((await readComment(replyResponses[0]!)).replyCount).toBe(1);
		expect((await readComment(await post(ROUTE_COMMENTS_REPLY, reply))).replyCount).toBe(1);

		const resolve = { commentId: comment.id, resolved: true, requestId: "resolve-once" };
		const resolveResponses = await Promise.all([
			post(ROUTE_COMMENTS_RESOLVE, resolve),
			post(ROUTE_COMMENTS_RESOLVE, resolve),
		]);
		expect((await readComment(resolveResponses[0]!)).resolved).toBe(true);
		expect((await readComment(await post(ROUTE_COMMENTS_RESOLVE, resolve))).resolved).toBe(true);

		const reopen = { commentId: comment.id, resolved: false, requestId: "reopen-once" };
		const reopenResponses = await Promise.all([
			post(ROUTE_COMMENTS_RESOLVE, reopen),
			post(ROUTE_COMMENTS_RESOLVE, reopen),
		]);
		expect((await readComment(reopenResponses[0]!)).resolved).toBe(false);
		expect((await readComment(await post(ROUTE_COMMENTS_RESOLVE, reopen))).resolved).toBe(false);

		const conflict = await post(ROUTE_COMMENTS, { ...create, body: "changed body" });
		expect(conflict.status).toBe(422);
		await expect(conflict.json()).resolves.toMatchObject({ error: { code: "idempotency_conflict" } });
		const endpointConflict = await post(ROUTE_COMMENTS_REPLY, {
			commentId: comment.id,
			body: "different endpoint",
			requestId: "create-once",
		});
		expect(endpointConflict.status).toBe(422);

		const commentDeliveries = deliveries.filter(
			(delivery): delivery is Extract<PreviewFeedback, { type: "comment" }> => delivery.type === "comment",
		);
		expect(commentDeliveries.map(delivery => delivery.event)).toEqual(["new", "reply", "resolve", "reopen"]);
		const durable = await PreviewCommentStore.load(root);
		expect(durable.list()).toEqual([
			expect.objectContaining({ id: comment.id, resolved: false, replies: [expect.any(Object)] }),
		]);
	});

	test("rejects stale canvas-node feedback before it mutates review state", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "ompx-product-preview-stale-node-"));
		roots.push(root);
		await Bun.write(
			path.join(root, "flow.canvas.json"),
			JSON.stringify({
				version: 1,
				title: "Review flow",
				artifactType: "plan",
				nodes: [{ id: "current-node", type: "card", title: "Current node", body: "Current state" }],
				edges: [],
			}),
		);
		const deliveries: PreviewFeedback[] = [];
		const handle = await startPreviewServer({
			root,
			port: 0,
			deliverFeedback: feedback => {
				deliveries.push(feedback);
			},
		});
		handles.push(handle);
		const manifest: unknown = await (await fetch(endpoint(handle, ROUTE_MANIFEST))).json();
		if (
			!manifest ||
			typeof manifest !== "object" ||
			!("items" in manifest) ||
			!Array.isArray(manifest.items) ||
			!manifest.items[0] ||
			typeof manifest.items[0] !== "object" ||
			!("id" in manifest.items[0]) ||
			typeof manifest.items[0].id !== "string"
		) {
			throw new Error("canvas manifest missing item");
		}
		const response = await fetch(endpoint(handle, ROUTE_COMMENTS), {
			method: "POST",
			headers: { "Content-Type": "application/json", [SIDE_ASK_HEADER]: "1" },
			body: JSON.stringify({
				anchor: { type: "canvas-node", itemId: manifest.items[0].id, nodeId: "removed-node" },
				body: "This node is stale",
				requestId: "stale-node",
			}),
		});
		expect(response.status).toBe(422);
		await expect(response.json()).resolves.toEqual({
			error: {
				code: "invalid_anchor",
				message: "Canvas node no longer exists",
				field: "anchor.nodeId",
			},
		});
		const comments = await fetch(endpoint(handle, ROUTE_COMMENTS), { headers: { [SIDE_ASK_HEADER]: "1" } });
		await expect(comments.json()).resolves.toEqual({ comments: [] });
		expect(deliveries).toEqual([]);
		expect(await Bun.file(path.join(root, ".ompx-preview", "state.json")).exists()).toBe(false);
	});

	test("rejects canvas-node create after the node becomes stale while queued behind a durable write", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "ompx-product-preview-queued-create-"));
		roots.push(root);
		const canvasPath = path.join(root, "flow.canvas.json");
		const canvas = (includeNode: boolean) =>
			JSON.stringify({
				version: 1,
				title: "Review flow",
				artifactType: "plan",
				nodes: includeNode
					? [{ id: "current-node", type: "card", title: "Current node", body: "Current state" }]
					: [],
				edges: [],
			});
		await Bun.write(canvasPath, canvas(true));
		const deliveries: PreviewFeedback[] = [];
		const handle = await startPreviewServer({
			root,
			port: 0,
			deliverFeedback: feedback => deliveries.push(feedback),
		});
		handles.push(handle);
		const manifest = (await (await fetch(endpoint(handle, ROUTE_MANIFEST))).json()) as {
			items: Array<{ id: string; relPath: string }>;
		};
		const itemId = manifest.items.find(item => item.relPath === "flow.canvas.json")?.id;
		expect(itemId).toBeDefined();
		const headers = { "Content-Type": "application/json", [SIDE_ASK_HEADER]: "1" };
		const post = async (body: unknown) =>
			await fetch(endpoint(handle, ROUTE_COMMENTS), { method: "POST", headers, body: JSON.stringify(body) });

		let releaseWrite: (() => void) | undefined;
		let markWriteStarted: (() => void) | undefined;
		const writeStarted = new Promise<void>(resolve => {
			markWriteStarted = resolve;
		});
		const writeReleased = new Promise<void>(resolve => {
			releaseWrite = resolve;
		});
		const writeSpy = vi.spyOn(commentsModule, "writePreviewStateTmp").mockImplementation(async (tmpPath, json) => {
			markWriteStarted?.();
			await writeReleased;
			return await Bun.write(tmpPath, json);
		});
		try {
			const blocking = post({
				anchor: { type: "text", itemId, quote: "Current", prefix: "", suffix: " state" },
				body: "serialize this write",
				requestId: "queued-create-blocker",
			});
			await writeStarted;
			const stale = post({
				anchor: { type: "canvas-node", itemId, nodeId: "current-node" },
				body: "must not persist",
				requestId: "queued-stale-create",
			});
			await Bun.write(canvasPath, canvas(false));
			releaseWrite?.();

			expect((await blocking).status).toBe(201);
			const staleResponse = await stale;
			expect(staleResponse.status).toBe(422);
			await expect(staleResponse.json()).resolves.toMatchObject({ error: { code: "invalid_anchor" } });
			expect((await PreviewCommentStore.load(root)).list().map(comment => comment.body)).toEqual([
				"serialize this write",
			]);
			expect(
				deliveries
					.filter(
						(delivery): delivery is Extract<PreviewFeedback, { type: "comment" }> => delivery.type === "comment",
					)
					.map(delivery => delivery.comment.body),
			).toEqual(["serialize this write"]);
		} finally {
			writeSpy.mockRestore();
		}
	});

	test("rejects canvas-node resolve after the node becomes stale while queued behind a durable write", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "ompx-product-preview-queued-resolve-"));
		roots.push(root);
		const canvasPath = path.join(root, "flow.canvas.json");
		const canvas = (includeNode: boolean) =>
			JSON.stringify({
				version: 1,
				title: "Review flow",
				artifactType: "plan",
				nodes: includeNode
					? [{ id: "current-node", type: "card", title: "Current node", body: "Current state" }]
					: [],
				edges: [],
			});
		await Bun.write(canvasPath, canvas(true));
		const deliveries: PreviewFeedback[] = [];
		const handle = await startPreviewServer({
			root,
			port: 0,
			deliverFeedback: feedback => deliveries.push(feedback),
		});
		handles.push(handle);
		const manifest = (await (await fetch(endpoint(handle, ROUTE_MANIFEST))).json()) as {
			items: Array<{ id: string; relPath: string }>;
		};
		const itemId = manifest.items.find(item => item.relPath === "flow.canvas.json")?.id;
		expect(itemId).toBeDefined();
		const headers = { "Content-Type": "application/json", [SIDE_ASK_HEADER]: "1" };
		const post = async (route: string, body: unknown) =>
			await fetch(endpoint(handle, route), { method: "POST", headers, body: JSON.stringify(body) });
		const created = await post(ROUTE_COMMENTS, {
			anchor: { type: "canvas-node", itemId, nodeId: "current-node" },
			body: "existing canvas comment",
			requestId: "queued-resolve-create",
		});
		expect(created.status).toBe(201);
		const comment = (await created.json()) as { comment: { id: string } };
		deliveries.length = 0;

		let releaseWrite: (() => void) | undefined;
		let markWriteStarted: (() => void) | undefined;
		const writeStarted = new Promise<void>(resolve => {
			markWriteStarted = resolve;
		});
		const writeReleased = new Promise<void>(resolve => {
			releaseWrite = resolve;
		});
		const writeSpy = vi.spyOn(commentsModule, "writePreviewStateTmp").mockImplementation(async (tmpPath, json) => {
			markWriteStarted?.();
			await writeReleased;
			return await Bun.write(tmpPath, json);
		});
		try {
			const blocking = post(ROUTE_COMMENTS, {
				anchor: { type: "text", itemId, quote: "Current", prefix: "", suffix: " state" },
				body: "serialize this write",
				requestId: "queued-resolve-blocker",
			});
			await writeStarted;
			const stale = post(ROUTE_COMMENTS_RESOLVE, {
				commentId: comment.comment.id,
				resolved: true,
				requestId: "queued-stale-resolve",
			});
			await Bun.write(canvasPath, canvas(false));
			releaseWrite?.();

			expect((await blocking).status).toBe(201);
			const staleResponse = await stale;
			expect(staleResponse.status).toBe(422);
			await expect(staleResponse.json()).resolves.toMatchObject({ error: { code: "invalid_anchor" } });
			const stored = (await PreviewCommentStore.load(root)).list();
			expect(stored.find(entry => entry.id === comment.comment.id)).toMatchObject({ resolved: false, replies: [] });
			expect(stored.map(entry => entry.body)).toEqual(["existing canvas comment", "serialize this write"]);
			expect(
				deliveries
					.filter(
						(delivery): delivery is Extract<PreviewFeedback, { type: "comment" }> => delivery.type === "comment",
					)
					.map(delivery => delivery.comment.body),
			).toEqual(["serialize this write"]);
		} finally {
			writeSpy.mockRestore();
		}
	});

	test("comments and answers persist with mine/delete rules", async () => {
		const deliveries: PreviewFeedback[] = [];
		const { handle, share } = await startFixtureServer(deliveries);
		const root = roots.at(-1)!;
		const manifest = (await (await fetch(endpoint(handle, ROUTE_MANIFEST))).json()) as {
			items: Array<{ id: string; relPath: string; title: string }>;
		};
		const product = manifest.items.find(item => item.relPath === "product.md");
		expect(product).toBeDefined();
		const itemId = product?.id ?? "missing";

		const headers = {
			"Content-Type": "application/json",
			[SIDE_ASK_HEADER]: "1",
		};

		// POST comment → GET roundtrip with mine flag for loopback owner.
		const createResponse = await fetch(endpoint(handle, ROUTE_COMMENTS), {
			method: "POST",
			headers,
			body: JSON.stringify({
				anchor: { type: "text", itemId, quote: "Preview", prefix: "", suffix: " content" },
				body: "loopback comment",
				author: "Owner",
				requestId: "loopback-create",
			}),
		});
		expect(createResponse.status).toBe(201);
		const created = (await createResponse.json()) as {
			comment: { id: string; mine: boolean; ownerSid?: string; body: string };
		};
		expect(created.comment.mine).toBe(true);
		expect(created.comment.ownerSid).toBeUndefined();
		expect(created.comment.body).toBe("loopback comment");

		const listResponse = await fetch(endpoint(handle, `${ROUTE_COMMENTS}?itemId=${itemId}`), {
			headers: { [SIDE_ASK_HEADER]: "1" },
		});
		expect(listResponse.status).toBe(200);
		const listed = (await listResponse.json()) as {
			comments: Array<{ id: string; mine: boolean; ownerSid?: string }>;
		};
		expect(listed.comments).toHaveLength(1);
		expect(listed.comments[0]?.id).toBe(created.comment.id);
		expect(listed.comments[0]?.mine).toBe(true);
		expect(listed.comments[0]?.ownerSid).toBeUndefined();

		// 20 mixed comment/answer POSTs via Promise.all.
		const mixed = await Promise.all(
			Array.from({ length: 20 }, async (_, index) => {
				if (index % 2 === 0) {
					const response = await fetch(endpoint(handle, ROUTE_COMMENTS), {
						method: "POST",
						headers,
						body: JSON.stringify({
							anchor: { type: "text", itemId, quote: `q${index}`, prefix: "", suffix: "" },
							body: `comment-${index}`,
							author: `A${index}`,
							requestId: `mixed-comment-${index}`,
						}),
					});
					expect(response.status).toBe(201);
					return { kind: "comment" as const };
				}
				const response = await fetch(endpoint(handle, ROUTE_ANSWER), {
					method: "POST",
					headers,
					body: JSON.stringify({
						questionId: `q-${index}`,
						itemId,
						question: `Question ${index}?`,
						selection: [`opt-${index}`],
						author: `A${index}`,
					}),
				});
				expect(response.status).toBe(202);
				return { kind: "answer" as const };
			}),
		);
		expect(mixed).toHaveLength(20);

		const allComments = (await (
			await fetch(endpoint(handle, ROUTE_COMMENTS), { headers: { [SIDE_ASK_HEADER]: "1" } })
		).json()) as { comments: Array<Record<string, unknown>> };
		// 1 initial + 10 parallel comments
		expect(allComments.comments).toHaveLength(11);
		for (const comment of allComments.comments) {
			expect(comment.ownerSid).toBeUndefined();
		}

		const allAnswers = (await (
			await fetch(endpoint(handle, `${ROUTE_ANSWERS}?itemId=${itemId}`), {
				headers: { [SIDE_ASK_HEADER]: "1" },
			})
		).json()) as { answers: Record<string, unknown> };
		expect(Object.keys(allAnswers.answers)).toHaveLength(10);

		// Fresh store reload sees durable JSON for all 20 writes + the first comment.
		const reloaded = await PreviewCommentStore.load(root);
		expect(reloaded.list()).toHaveLength(11);
		expect(Object.keys(reloaded.answers())).toHaveLength(10);
		const stateRaw = await Bun.file(path.join(root, ".ompx-preview", "state.json")).text();
		expect(() => JSON.parse(stateRaw)).not.toThrow();

		// Answer delivery uses AnswerFeedback.
		const answerDeliveries = deliveries.filter(d => d.type === "answer");
		expect(answerDeliveries.length).toBeGreaterThan(0);
		expect(answerDeliveries[0]).toMatchObject({ type: "answer", question: expect.any(String) });

		// Share guest flow on the share listener (127.0.0.2). Cookie sessions are
		// Host-bound to that listener; source peer may still be loopback on this
		// kernel, so delete-403 is exercised with Bearer-only sessions when peer
		// is non-loopback, and with seeded ownerSid mismatch otherwise.
		const shareInfo = await handle.enableShare();
		const shareBase = `http://127.0.0.2:${handle.port}`;

		const guestAExchange = await fetch(`${shareBase}/?t=${shareInfo.token}`, { redirect: "manual" });
		const cookieA = guestAExchange.headers.get("set-cookie")?.split(";")[0] ?? "";
		expect(cookieA.length).toBeGreaterThan(0);

		const guestBExchange = await fetch(`${shareBase}/?t=${shareInfo.token}`, { redirect: "manual" });
		const cookieB = guestBExchange.headers.get("set-cookie")?.split(";")[0] ?? "";
		expect(cookieB.length).toBeGreaterThan(0);
		expect(cookieB).not.toBe(cookieA);

		const guestCreate = await fetch(`${shareBase}${ROUTE_COMMENTS}`, {
			method: "POST",
			headers: { ...headers, Cookie: cookieA },
			body: JSON.stringify({
				anchor: { type: "text", itemId, quote: "guest", prefix: "", suffix: "" },
				body: "guest comment",
				author: "GuestA",
				requestId: "guest-create",
			}),
		});
		expect(guestCreate.status).toBe(201);
		const guestComment = (await guestCreate.json()) as {
			comment: { id: string; mine: boolean; ownerSid?: string };
		};
		expect(guestComment.comment.ownerSid).toBeUndefined();

		// Own-session delete of guest comment.
		const ownDelete = await fetch(`${shareBase}${ROUTE_COMMENTS_DELETE}`, {
			method: "POST",
			headers: { ...headers, Cookie: cookieA },
			body: JSON.stringify({ commentId: guestComment.comment.id }),
		});
		expect(ownDelete.status).toBe(200);

		// Create again as guest A for cross-session checks.
		const guestCreate2 = await fetch(`${shareBase}${ROUTE_COMMENTS}`, {
			method: "POST",
			headers: { ...headers, Cookie: cookieA },
			body: JSON.stringify({
				anchor: { type: "text", itemId, quote: "guest2", prefix: "", suffix: "" },
				body: "guest comment 2",
				author: "GuestA",
				requestId: "guest-create-2",
			}),
		});
		expect(guestCreate2.status).toBe(201);
		const guestComment2 = (await guestCreate2.json()) as { comment: { id: string } };

		const otherDelete = await fetch(`${shareBase}${ROUTE_COMMENTS_DELETE}`, {
			method: "POST",
			headers: { ...headers, Cookie: cookieB },
			body: JSON.stringify({ commentId: guestComment2.comment.id }),
		});
		// Non-loopback share peers → 403; kernel loopback source → 200 (loopback may delete any).
		expect([200, 403]).toContain(otherDelete.status);
		if (otherDelete.status === 403) {
			const ownerDelete = await fetch(`${shareBase}${ROUTE_COMMENTS_DELETE}`, {
				method: "POST",
				headers: { ...headers, Cookie: cookieA },
				body: JSON.stringify({ commentId: guestComment2.comment.id }),
			});
			expect(ownerDelete.status).toBe(200);
		}

		// Loopback (owner localUrl) can delete any remaining guest comment.
		const stillThere = (await (
			await fetch(endpoint(handle, ROUTE_COMMENTS), { headers: { [SIDE_ASK_HEADER]: "1" } })
		).json()) as { comments: Array<{ id: string; body: string }> };
		const target = stillThere.comments.find(c => c.body === "guest comment 2") ?? stillThere.comments[0];
		expect(target).toBeDefined();
		const loopbackDelete = await fetch(endpoint(handle, ROUTE_COMMENTS_DELETE), {
			method: "POST",
			headers,
			body: JSON.stringify({ commentId: target?.id }),
		});
		expect(loopbackDelete.status).toBe(200);

		// share controller still live for the fixture lifecycle
		expect(share.enabled()).toBe(true);
	});
});
