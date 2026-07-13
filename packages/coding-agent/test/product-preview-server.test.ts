import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PreviewAuth } from "@oh-my-pi/pi-coding-agent/product-preview/auth";
import { createPreviewServer, validateCanvasNodeAnchor } from "@oh-my-pi/pi-coding-agent/product-preview/server";
import {
	AUTH_FAIL_LIMIT,
	type BundleItem,
	type BundleManifest,
	type ClientAssetMap,
	PREVIEW_COOKIE_NAME,
	type PreviewFeedback,
	type PreviewServerHandle,
	ROUTE_CANVAS,
	ROUTE_DOC,
	ROUTE_EVENTS,
	ROUTE_EXPORT,
	ROUTE_MANIFEST,
	ROUTE_MOCKUP_FRAMED,
	ROUTE_MOCKUP_RAW,
	ROUTE_SIDE_ASK,
	type ShareController,
	type ShareInfo,
	ShareUnavailableError,
	SIDE_ASK_HEADER,
	SSE_HEARTBEAT_MS,
} from "@oh-my-pi/pi-coding-agent/product-preview/types";

const APP_CSP =
	"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; form-action 'none'; base-uri 'none'";
const RAW_MOCKUP_CSP =
	"sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; form-action 'none'";

const CLIENT_ASSETS: ClientAssetMap = {
	"/": { body: "<!doctype html><title>Product Preview</title>", contentType: "text/html; charset=utf-8" },
	"/client.js": { body: "window.previewLoaded = true;", contentType: "text/javascript; charset=utf-8" },
};

class FakeShareController implements ShareController {
	#enabled = false;
	#exportConsumed = false;
	#info: ShareInfo | null = null;
	/** Resolved when enable() is entered; lets tests interleave deterministically. */
	enableEntered = Promise.withResolvers<void>();
	/** When set, enable() waits for it before minting — no wall-clock sleeps. */
	enableRelease: Promise<void> | null = null;
	/** Bare-DNS Host alias the server should accept while sharing. */
	readonly aliasHost = "preview.test";

	// 127.0.0.2 is a loopback alias, so enableShare() can really bind it in tests.
	constructor(readonly host: string = "127.0.0.2") {}

	enabled(): boolean {
		return this.#enabled;
	}

	async enable(port: number): Promise<ShareInfo> {
		this.enableEntered.resolve();
		if (this.enableRelease) await this.enableRelease;
		this.#enabled = true;
		this.#exportConsumed = false;
		this.#info = {
			shareUrl: `http://${this.host}:${port}/?t=share-token`,
			token: "share-token",
			host: this.host,
			port,
			hostAliases: [this.aliasHost],
		};
		return this.#info;
	}

	disable(): void {
		this.#enabled = false;
		this.#info = null;
	}

	verifyToken(candidate: string): boolean {
		return this.#enabled && candidate === "share-token";
	}

	mintExportToken(): string {
		return "export-once";
	}

	consumeExportToken(candidate: string): boolean {
		if (!this.#enabled || this.#exportConsumed || candidate !== "export-once") return false;
		this.#exportConsumed = true;
		return true;
	}

	handoffPrompt(): string {
		return "handoff";
	}
}

interface PreviewHarness {
	handle: PreviewServerHandle;
	root: string;
	share: FakeShareController;
	deliveries: PreviewFeedback[];
	manifest: BundleManifest;
}

const handles: PreviewServerHandle[] = [];
const roots: string[] = [];

afterEach(async () => {
	for (const handle of handles.splice(0)) await handle.stop();
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

function item(id: string, kind: BundleItem["kind"], relPath: string, mtimeMs = 1): BundleItem {
	return { id, kind, relPath, title: relPath, mtimeMs, size: 1 };
}

async function createHarness(deliver = true): Promise<PreviewHarness> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "ompx-preview-server-"));
	roots.push(root);
	await fs.writeFile(path.join(root, "brief.md"), "# Brief\nHello preview\n");
	await fs.writeFile(path.join(root, "mockup.html"), "<button>Run mockup</button>");
	await fs.writeFile(
		path.join(root, "review.canvas.json"),
		JSON.stringify({
			version: 1,
			title: "Review map",
			artifactType: "story-map",
			nodes: [
				{ id: "root", type: "group", title: "Root" },
				{ id: "child", type: "card", title: "Child", parentId: "root" },
			],
			edges: [{ id: "edge", source: "root", target: "child", type: "sequence" }],
		}),
	);
	await fs.symlink(path.join(root, "brief.md"), path.join(root, "linked.md"));

	const manifest: BundleManifest = {
		bundle: { title: "Preview fixture", root, generatedAt: 1 },
		capabilities: { feedback: false },
		items: [
			item("brief", "brief", "brief.md"),
			item("mockup", "mockup", "mockup.html"),
			item("linked", "doc", "linked.md"),
			item("evil", "doc", "../outside.md"),
			item("canvas", "canvas", "review.canvas.json"),
		],
	};
	const share = new FakeShareController();
	const deliveries: PreviewFeedback[] = [];
	const handle = await createPreviewServer(
		{ root, share, deliverFeedback: deliver ? delivery => deliveries.push(delivery) : undefined, port: 0 },
		{ clientAssets: CLIENT_ASSETS, scan: async () => structuredClone(manifest) },
	);
	handles.push(handle);
	return { handle, root, share, deliveries, manifest };
}

function endpoint(harness: PreviewHarness, route: string): string {
	return `${harness.handle.localUrl.slice(0, -1)}${route}`;
}

async function request(
	harness: PreviewHarness,
	route: string,
	init: RequestInit & { host?: string } = {},
): Promise<Response> {
	const headers = new Headers(init.headers);
	if (init.host) headers.set("Host", init.host);
	return await fetch(endpoint(harness, route), { ...init, headers, redirect: init.redirect ?? "manual" });
}

function assertStandardHeaders(response: Response): void {
	expect(response.headers.get("referrer-policy")).toBe("no-referrer");
	expect(response.headers.get("x-content-type-options")).toBe("nosniff");
	expect(response.headers.get("access-control-allow-origin")).toBeNull();
}

async function readUntil(
	// Structural: bun-types and node:stream/web disagree on the reader type
	// (readMany), and fetch() can bind to either depending on lib order.
	reader: { read(): Promise<{ done: boolean; value?: Uint8Array }> },
	predicate: (frame: string) => boolean,
	timeoutMs: number,
): Promise<string> {
	const decoder = new TextDecoder();
	let received = "";
	while (true) {
		const next = reader.read();
		const result = await Promise.race([
			next,
			Bun.sleep(timeoutMs).then(() => {
				throw new Error(`Timed out waiting for SSE frame after ${timeoutMs}ms: ${received}`);
			}),
		]);
		if (result.done) throw new Error(`SSE closed before expected frame: ${received}`);
		received += decoder.decode(result.value, { stream: true });
		if (predicate(received)) return received;
	}
}

describe("product preview server", () => {
	it("rejects an unapproved Host before attempting authentication", async () => {
		const harness = await createHarness();
		await harness.handle.enableShare();

		const response = await request(harness, `${ROUTE_MANIFEST}?t=share-token`, { host: "attacker.invalid" });

		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({ error: { code: "forbidden", message: "Forbidden" } });
		assertStandardHeaders(response);
	});

	it("exchanges a share token for a Host-bound HttpOnly cookie and strips it from the URL", async () => {
		const harness = await createHarness();
		await harness.handle.enableShare();

		const response = await request(harness, "/?t=share-token");
		const cookie = response.headers.get("set-cookie");

		expect(response.status).toBe(302);
		expect(response.headers.get("location")).toBe("/");
		expect(cookie).toContain(`${PREVIEW_COOKIE_NAME}=`);
		expect(cookie).toContain("HttpOnly");
		expect(cookie).toContain("SameSite=Strict");
		assertStandardHeaders(response);
	});
	it("honors a preview session only on the exact Host that minted it", () => {
		const auth = new PreviewAuth();
		const sid = auth.exchangeToken("share-token", "100.64.0.2:3877", candidate => candidate === "share-token");
		expect(sid).not.toBeNull();

		expect(
			auth.authenticate({
				authorization: null,
				cookie: `${PREVIEW_COOKIE_NAME}=${sid}`,
				host: "100.64.0.2:3877",
				loopback: false,
				shareEnabled: true,
				verifyShareToken: () => false,
			}),
		).toEqual({ method: "cookie", viaShare: true });
		expect(
			auth.authenticate({
				authorization: null,
				cookie: `${PREVIEW_COOKIE_NAME}=${sid}`,
				host: "localhost:3877",
				loopback: false,
				shareEnabled: true,
				verifyShareToken: () => false,
			}),
		).toBeNull();
	});

	it("returns a uniform unauthorized envelope until the per-peer failure throttle activates", async () => {
		const harness = await createHarness();
		await harness.handle.enableShare();

		for (let attempt = 0; attempt < AUTH_FAIL_LIMIT; attempt++) {
			const response = await request(harness, "/?t=not-the-token");
			expect(response.status).toBe(401);
			expect(await response.json()).toEqual({ error: { code: "unauthorized", message: "Unauthorized" } });
		}

		const throttled = await request(harness, "/?t=not-the-token");
		expect(throttled.status).toBe(429);
		expect(await throttled.json()).toEqual({
			error: { code: "too_many_auth_failures", message: "Too many authentication failures" },
		});
	});

	it("serves injected same-origin assets and applies route-class CSP without CORS", async () => {
		const harness = await createHarness();

		const shell = await request(harness, "/");
		expect(shell.status).toBe(200);
		expect(shell.headers.get("content-security-policy")).toBe(APP_CSP);
		expect(await shell.text()).toContain("Product Preview");
		assertStandardHeaders(shell);

		const client = await request(harness, "/client.js");
		expect(client.status).toBe(200);
		expect(client.headers.get("content-type")).toContain("text/javascript");
		expect(await client.text()).toContain("previewLoaded");
		expect(client.headers.get("content-security-policy")).toBe(APP_CSP);

		const doc = await request(harness, `${ROUTE_DOC}brief`);
		expect(doc.status).toBe(200);
		expect(doc.headers.get("content-security-policy")).toBe(APP_CSP);
		expect(await doc.json()).toMatchObject({ item: { id: "brief" }, content: "# Brief\nHello preview\n" });

		const framed = await request(harness, `${ROUTE_MOCKUP_FRAMED}mockup`);
		expect(framed.status).toBe(200);
		expect(framed.headers.get("content-security-policy")).toBe(RAW_MOCKUP_CSP);
		// C6: template served directly with bridge IIFE; sandbox lives in CSP header.
		const framedHtml = await framed.text();
		expect(framedHtml).toContain("window.OmpxPreview");
		expect(framedHtml).not.toContain("srcdoc=");

		const raw = await request(harness, `${ROUTE_MOCKUP_RAW}mockup`);
		expect(raw.status).toBe(200);
		expect(raw.headers.get("content-security-policy")).toBe(RAW_MOCKUP_CSP);
		expect(await raw.text()).toContain("Run mockup");
	});

	it("uses the socket peer rather than X-Forwarded-For when deciding loopback access", async () => {
		const harness = await createHarness();
		await harness.handle.enableShare();

		const response = await request(harness, ROUTE_MANIFEST, { headers: { "X-Forwarded-For": "100.64.0.9" } });

		expect(response.status).toBe(200);
		const body = (await response.json()) as { bundle: { title: string } };
		expect(body.bundle.title).toBe("Preview fixture");
	});

	it(
		"emits manifest and heartbeat SSE frames, then revokes and drops streams when sharing stops",
		async () => {
			const harness = await createHarness();
			await harness.handle.enableShare();
			const response = await request(harness, ROUTE_EVENTS);
			expect(response.status).toBe(200);
			expect(response.body).not.toBeNull();
			const reader = response.body!.getReader();
			try {
				const manifestFrame = await readUntil(reader, frame => frame.includes("event: manifest"), 1_000);
				expect(manifestFrame).toContain("Preview fixture");
				harness.manifest.items[0]!.mtimeMs = 2;
				await harness.handle.refresh();
				const changedFrame = await readUntil(reader, frame => frame.includes("event: doc-changed"), 1_000);
				expect(changedFrame).toContain('"id":"brief"');
				// This drives the real Bun HTTP stream; fake timers cannot advance its server-side heartbeat.
				const heartbeat = await readUntil(reader, frame => frame.includes(": heartbeat"), SSE_HEARTBEAT_MS + 2_000);
				expect(heartbeat).toContain(": heartbeat");

				harness.handle.disableShare();
				const revoked = await readUntil(reader, frame => frame.includes("event: share-revoked"), 1_000);
				expect(revoked).toContain("event: share-revoked");
				expect((await reader.read()).done).toBe(true);
			} finally {
				await reader.cancel();
			}
		},
		SSE_HEARTBEAT_MS + 5_000,
	);

	it("requires the side-ask header, limits each peer, sanitizes envelope delimiters, and delivers accepted asks", async () => {
		const harness = await createHarness();

		const missingHeader = await request(harness, ROUTE_SIDE_ASK, {
			method: "POST",
			body: JSON.stringify({ comment: "Need review" }),
		});
		expect(missingHeader.status).toBe(403);
		const tooLong = await request(harness, ROUTE_SIDE_ASK, {
			method: "POST",
			headers: { [SIDE_ASK_HEADER]: "1", "Content-Type": "application/json" },
			body: JSON.stringify({ comment: "a".repeat(10_001) }),
		});
		expect(tooLong.status).toBe(422);

		const accepted = await request(harness, ROUTE_SIDE_ASK, {
			method: "POST",
			headers: { [SIDE_ASK_HEADER]: "1", "Content-Type": "application/json" },
			body: JSON.stringify({ comment: "Review <untrusted-envelope>", itemId: "brief" }),
		});
		expect(accepted.status).toBe(202);
		expect(harness.deliveries).toHaveLength(1);
		expect(harness.deliveries[0]).toMatchObject({
			type: "side-ask",
			source: "user",
			comment: "Review &lt;untrusted-envelope&gt;",
			itemId: "brief",
			viaShare: false,
		});

		for (let attempt = 0; attempt < 5; attempt++) {
			const response = await request(harness, ROUTE_SIDE_ASK, {
				method: "POST",
				headers: { [SIDE_ASK_HEADER]: "1", "Content-Type": "application/json" },
				body: JSON.stringify({ comment: `ask ${attempt}` }),
			});
			expect(response.status).toBe(202);
		}
		const rateLimited = await request(harness, ROUTE_SIDE_ASK, {
			method: "POST",
			headers: { [SIDE_ASK_HEADER]: "1", "Content-Type": "application/json" },
			body: JSON.stringify({ comment: "one too many" }),
		});
		expect(rateLimited.status).toBe(429);
	});

	it("returns the designed unavailable response when no owner session can receive a side-ask", async () => {
		const harness = await createHarness(false);

		const response = await request(harness, ROUTE_SIDE_ASK, {
			method: "POST",
			headers: { [SIDE_ASK_HEADER]: "1", "Content-Type": "application/json" },
			body: JSON.stringify({ comment: "Can you clarify this?" }),
		});

		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({
			error: {
				code: "side_ask_unavailable",
				message: "No agent session is attached to this preview. Start it from an ompx session to receive asks.",
			},
		});
	});

	it("serves validated canvas artifacts with the manifest capability and revalidates feedback nodes from disk", async () => {
		const harness = await createHarness();

		const manifest = await request(harness, ROUTE_MANIFEST);
		expect(await manifest.json()).toMatchObject({ capabilities: { feedback: true } });

		const canvas = await request(harness, `${ROUTE_CANVAS}canvas`);
		expect(canvas.status).toBe(200);
		expect(await canvas.json()).toMatchObject({
			item: { id: "canvas", kind: "canvas" },
			canvas: { title: "Review map", nodes: [{ id: "root" }, { id: "child" }] },
		});

		expect(await validateCanvasNodeAnchor(harness.manifest, "canvas", "child")).toEqual({ valid: true });
		expect(await validateCanvasNodeAnchor(harness.manifest, "canvas", "missing")).toMatchObject({
			valid: false,
			error: { code: "invalid_anchor", field: "anchor.nodeId" },
		});
	});

	it("returns the nested canvas error envelope for missing, wrong-kind, and invalid artifacts", async () => {
		const harness = await createHarness();

		expect((await request(harness, `${ROUTE_CANVAS}missing`)).status).toBe(404);
		expect((await request(harness, `${ROUTE_CANVAS}brief`)).status).toBe(404);

		await fs.writeFile(path.join(harness.root, "review.canvas.json"), JSON.stringify({ version: 1 }));
		const invalid = await request(harness, `${ROUTE_CANVAS}canvas`);

		expect(invalid.status).toBe(422);
		expect(await invalid.json()).toMatchObject({
			error: { code: "invalid_canvas", field: "title" },
		});
		expect(await validateCanvasNodeAnchor(harness.manifest, "canvas", "child")).toMatchObject({
			valid: false,
			error: { code: "invalid_anchor", field: "anchor.nodeId" },
		});
	});

	it("reports feedback capability false without a live delivery callback", async () => {
		const harness = await createHarness(false);
		const manifest = await request(harness, ROUTE_MANIFEST);

		expect(await manifest.json()).toMatchObject({ capabilities: { feedback: false } });
	});

	it("rejects traversal paths and exports exactly the regular, sanitized bundle files with a single-use bearer token", async () => {
		const harness = await createHarness();
		await harness.handle.enableShare();

		const traversalDoc = await request(harness, `${ROUTE_DOC}%2E%2E%2Foutside.md`);
		expect(traversalDoc.status).toBe(403);
		const unsafeItem = await request(harness, `${ROUTE_DOC}evil`);
		expect(unsafeItem.status).toBe(403);
		const traversalExport = await request(harness, `${ROUTE_EXPORT}/%2E%2E%2Foutside.tar.gz`, {
			headers: { Authorization: "Bearer export-once" },
		});
		expect(traversalExport.status).toBe(403);

		const archiveResponse = await request(harness, ROUTE_EXPORT, {
			headers: { Authorization: "Bearer export-once" },
		});
		expect(archiveResponse.status).toBe(200);
		expect(archiveResponse.headers.get("content-type")).toBe("application/gzip");
		const archive = new Bun.Archive(await archiveResponse.bytes());
		const files = await archive.files();
		expect([...files.keys()].sort()).toEqual(["brief.md", "mockup.html", "review.canvas.json"]);
		expect(await files.get("brief.md")?.text()).toBe("# Brief\nHello preview\n");

		const replay = await request(harness, ROUTE_EXPORT, { headers: { Authorization: "Bearer export-once" } });
		expect(replay.status).toBe(401);
	});
});

function shareEndpoint(harness: PreviewHarness, route: string): string {
	return `http://${harness.share.host}:${harness.handle.port}${route}`;
}

describe("share listener lifecycle (amendment A1)", () => {
	it("enableShare starts a reachable tailnet listener; owner loopback stays up", async () => {
		const harness = await createHarness();
		await harness.handle.enableShare();

		// Peer auth semantics can't be exercised over loopback aliases (the
		// kernel-assigned source address is still loopback, which authenticate()
		// legitimately trusts); remote-peer auth paths are covered by the Host
		// and token-exchange tests above. A1's contract here: the listener exists.

		const allowed = await fetch(shareEndpoint(harness, ROUTE_MANIFEST), {
			headers: { Authorization: "Bearer share-token" },
		});
		expect(allowed.status).toBe(200);

		const local = await request(harness, ROUTE_MANIFEST);
		expect(local.status).toBe(200);
	});

	it("disableShare tears the tailnet listener down and clears share state", async () => {
		const harness = await createHarness();
		await harness.handle.enableShare();
		const before = await fetch(shareEndpoint(harness, ROUTE_MANIFEST), {
			headers: { Authorization: "Bearer share-token" },
		});
		expect(before.status).toBe(200);

		harness.handle.disableShare();

		expect(harness.share.enabled()).toBe(false);
		expect(harness.handle.shareInfo()).toBeNull();
		await expect(fetch(shareEndpoint(harness, ROUTE_MANIFEST))).rejects.toThrow();
	});

	it("concurrent enableShare calls serialize onto one working listener", async () => {
		const harness = await createHarness();
		await Promise.all([harness.handle.enableShare(), harness.handle.enableShare()]);

		const allowed = await fetch(shareEndpoint(harness, ROUTE_MANIFEST), {
			headers: { Authorization: "Bearer share-token" },
		});
		expect(allowed.status).toBe(200);
	});

	it("disableShare during an in-flight enableShare rolls the mint back and stays off", async () => {
		const harness = await createHarness();
		const release = Promise.withResolvers<void>();
		harness.share.enableRelease = release.promise;
		const pending = harness.handle.enableShare();
		await harness.share.enableEntered.promise; // mint is now in flight inside the lock
		harness.handle.disableShare();
		release.resolve();

		await expect(pending).rejects.toThrow(ShareUnavailableError);
		expect(harness.share.enabled()).toBe(false);
		expect(harness.handle.shareInfo()).toBeNull();
		await expect(fetch(shareEndpoint(harness, ROUTE_MANIFEST))).rejects.toThrow();
	});

	it("enableShare after stop() rejects without leaving a minted token", async () => {
		const harness = await createHarness();
		await harness.handle.stop();

		await expect(harness.handle.enableShare()).rejects.toThrow(ShareUnavailableError);
		expect(harness.share.enabled()).toBe(false);
	});

	it("bind failure on the share host revokes the freshly minted token", async () => {
		const harness = await createHarness();
		const blocker = Bun.serve({
			hostname: harness.share.host,
			port: harness.handle.port,
			fetch: () => new Response("blocked"),
		});
		try {
			await expect(harness.handle.enableShare()).rejects.toThrow();
			expect(harness.share.enabled()).toBe(false);
			expect(harness.handle.shareInfo()).toBeNull();
		} finally {
			blocker.stop(true);
		}
	});

	it("accepts the hostname-alias Host with share auth while sharing", async () => {
		const harness = await createHarness();
		await harness.handle.enableShare();
		const aliasHost = `${harness.share.aliasHost}:${harness.handle.port}`;

		// Host is the hostname alias, not the bind IP — proves #isAllowedHost honors
		// ShareInfo.hostAliases while sharing. (The unauthenticated-401 path needs a
		// real non-loopback peer: over the 127.0.0.2 alias the kernel picks a
		// loopback source, so authenticate() trusts it. That path is proven by the
		// real `http://codemc:3877` curl in the e2e harness.)
		const withAuth = await fetch(shareEndpoint(harness, ROUTE_MANIFEST), {
			headers: { Host: aliasHost, Authorization: "Bearer share-token" },
		});
		expect(withAuth.status).toBe(200);
	});

	it("rejects the hostname-alias Host once sharing stops", async () => {
		const harness = await createHarness();
		await harness.handle.enableShare();
		harness.handle.disableShare();

		// Owner loopback listener is still up; the alias must no longer be allowed.
		const res = await request(harness, ROUTE_MANIFEST, {
			host: `${harness.share.aliasHost}:${harness.handle.port}`,
		});
		expect(res.status).toBe(403);
	});
});
