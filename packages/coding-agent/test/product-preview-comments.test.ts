import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as commentsModule from "../src/product-preview/comments";
import type { PreviewComment, PreviewCommentReply } from "../src/product-preview/types";

const { PreviewCommentStore, renamePreviewStateFile, writePreviewStateTmp } = commentsModule;

const roots: string[] = [];

afterEach(async () => {
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function tempRoot(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "ompx-preview-comments-"));
	roots.push(root);
	return root;
}

function sampleComment(overrides: Partial<PreviewComment> = {}): PreviewComment {
	return {
		id: crypto.randomUUID(),
		anchor: { type: "text", itemId: "item-1", quote: "hello", prefix: "", suffix: "" },
		body: "body",
		author: "alice",
		viaShare: false,
		ts: Date.now(),
		resolved: false,
		replies: [],
		ownerSid: "loopback",
		...overrides,
	};
}

function sampleReply(overrides: Partial<PreviewCommentReply> = {}): PreviewCommentReply {
	return {
		id: crypto.randomUUID(),
		body: "reply body",
		author: "bob",
		viaShare: false,
		ts: Date.now(),
		...overrides,
	};
}

describe("PreviewCommentStore", () => {
	test("add/reply/resolve/remove and persist across reload", async () => {
		const root = await tempRoot();
		const store = await PreviewCommentStore.load(root);
		const created = await store.add(sampleComment({ body: "first" }));
		expect(store.list()).toHaveLength(1);

		const replied = await store.reply(created.id, sampleReply({ body: "second" }));
		expect(replied?.replies).toHaveLength(1);
		expect(replied?.replies[0]?.body).toBe("second");

		const resolved = await store.setResolved(created.id, true);
		expect(resolved?.resolved).toBe(true);

		const removed = await store.remove(created.id);
		expect(removed).toBe(true);
		expect(store.list()).toHaveLength(0);

		const durable = await store.add(sampleComment({ body: "durable" }));
		await store.recordAnswer("q1", { selection: ["A"], author: "alice", ts: 1, itemId: "item-1" });

		const reloaded = await PreviewCommentStore.load(root);
		expect(reloaded.list().map(c => c.body)).toEqual(["durable"]);
		expect(reloaded.list()[0]?.id).toBe(durable.id);
		expect(reloaded.answers()).toEqual({ q1: { selection: ["A"], author: "alice", ts: 1 } });
		expect(reloaded.answers("item-1")).toEqual({ q1: { selection: ["A"], author: "alice", ts: 1 } });
		expect(reloaded.answers("other")).toEqual({});
	});

	test("migrates persisted legacy text anchors to the discriminated union on load", async () => {
		const root = await tempRoot();
		const dir = path.join(root, ".ompx-preview");
		await fs.mkdir(dir, { recursive: true });
		const legacyAnchor = { itemId: "item-1", quote: "hello", prefix: "", suffix: "" };
		const comment = sampleComment({ anchor: { type: "text", ...legacyAnchor } });
		await Bun.write(
			path.join(dir, "state.json"),
			JSON.stringify({ version: 1, comments: [{ ...comment, anchor: legacyAnchor }], answers: {} }),
		);

		const store = await PreviewCommentStore.load(root);
		expect(store.list()[0]?.anchor).toEqual({ type: "text", ...legacyAnchor });
		const persisted: unknown = JSON.parse(await Bun.file(path.join(dir, "state.json")).text());
		if (
			!persisted ||
			typeof persisted !== "object" ||
			!("comments" in persisted) ||
			!Array.isArray(persisted.comments) ||
			!persisted.comments[0] ||
			typeof persisted.comments[0] !== "object" ||
			!("anchor" in persisted.comments[0]) ||
			!persisted.comments[0].anchor ||
			typeof persisted.comments[0].anchor !== "object" ||
			!("type" in persisted.comments[0].anchor)
		) {
			throw new Error("migrated state missing text anchor");
		}
		expect(persisted.comments[0].anchor.type).toBe("text");
	});

	test("corrupt state file recovers to empty committed state", async () => {
		const root = await tempRoot();
		const dir = path.join(root, ".ompx-preview");
		await fs.mkdir(dir, { recursive: true });
		await Bun.write(path.join(dir, "state.json"), "{not-json");

		const store = await PreviewCommentStore.load(root);
		expect(store.list()).toEqual([]);
		expect(store.answers()).toEqual({});
	});

	test("leftover state.json.tmp is ignored and deleted on load", async () => {
		const root = await tempRoot();
		const dir = path.join(root, ".ompx-preview");
		await fs.mkdir(dir, { recursive: true });
		await Bun.write(
			path.join(dir, "state.json.tmp"),
			JSON.stringify({
				version: 1,
				comments: [sampleComment({ body: "tmp-only" })],
				answers: {},
			}),
		);

		const store = await PreviewCommentStore.load(root);
		expect(store.list()).toEqual([]);
		expect(await Bun.file(path.join(dir, "state.json.tmp")).exists()).toBe(false);
	});

	test("failed add rejects, stays invisible, and later enqueued mutation succeeds", async () => {
		const root = await tempRoot();
		const store = await PreviewCommentStore.load(root);

		const writeSpy = spyOn(commentsModule, "writePreviewStateTmp");
		let failNext = true;
		writeSpy.mockImplementation(async (tmpPath, json) => {
			if (failNext) {
				failNext = false;
				throw new Error("forced write failure");
			}
			return await Bun.write(tmpPath, json);
		});

		try {
			const failing = store.add(sampleComment({ body: "ghost" }));
			// Enqueued before the first settles — must still run after the failure.
			const succeeding = store.add(sampleComment({ body: "real" }));

			await expect(failing).rejects.toThrow("forced write failure");
			const saved = await succeeding;
			expect(saved.body).toBe("real");
			expect(store.list().map(c => c.body)).toEqual(["real"]);

			const reloaded = await PreviewCommentStore.load(root);
			expect(reloaded.list().map(c => c.body)).toEqual(["real"]);
		} finally {
			writeSpy.mockRestore();
		}
	});

	test("reply to a never-committed add returns null", async () => {
		const root = await tempRoot();
		const store = await PreviewCommentStore.load(root);
		const ghostId = crypto.randomUUID();

		const writeSpy = spyOn(commentsModule, "writePreviewStateTmp");
		let failOnce = true;
		writeSpy.mockImplementation(async (tmpPath, json) => {
			if (failOnce) {
				failOnce = false;
				throw new Error("forced write failure");
			}
			return await Bun.write(tmpPath, json);
		});

		try {
			const failingAdd = store.add(sampleComment({ id: ghostId, body: "ghost" }));
			const replyPromise = store.reply(ghostId, sampleReply());

			await expect(failingAdd).rejects.toThrow("forced write failure");
			expect(await replyPromise).toBeNull();
			expect(store.list()).toEqual([]);
		} finally {
			writeSpy.mockRestore();
		}
	});

	test("overlapping setResolved: failed true then successful false leaves committed false", async () => {
		const root = await tempRoot();
		const store = await PreviewCommentStore.load(root);
		const comment = await store.add(sampleComment({ resolved: false }));

		const renameSpy = spyOn(commentsModule, "renamePreviewStateFile");
		let failOnce = true;
		renameSpy.mockImplementation(async (tmpPath, finalPath) => {
			if (failOnce) {
				failOnce = false;
				throw new Error("forced rename failure");
			}
			await fs.rename(tmpPath, finalPath);
		});

		try {
			const failResolve = store.setResolved(comment.id, true);
			const succeedResolve = store.setResolved(comment.id, false);

			await expect(failResolve).rejects.toThrow("forced rename failure");
			const updated = await succeedResolve;
			expect(updated?.resolved).toBe(false);
			expect(store.list()[0]?.resolved).toBe(false);

			const reloaded = await PreviewCommentStore.load(root);
			expect(reloaded.list()[0]?.resolved).toBe(false);
		} finally {
			renameSpy.mockRestore();
		}
	});

	test("serializes same-request mutations into one durable receipt and item", async () => {
		const root = await tempRoot();
		const store = await PreviewCommentStore.load(root);
		const receipt = {
			scope: "loopback",
			requestId: "same-request",
			endpoint: "create" as const,
			fingerprint: '{"body":"first"}',
		};
		const first = sampleComment({ body: "first" });
		const second = sampleComment({ body: "second" });

		const [one, two] = await Promise.all([
			store.mutateCommentOnce(receipt, state => ({
				next: { ...state, comments: [...state.comments, first] },
				comment: first,
			})),
			store.mutateCommentOnce(receipt, state => ({
				next: { ...state, comments: [...state.comments, second] },
				comment: second,
			})),
		]);

		expect(one.kind).toBe("applied");
		expect(two).toMatchObject({ kind: "replayed", comment: { id: first.id } });
		expect(store.list()).toEqual([expect.objectContaining({ id: first.id, body: "first" })]);

		const conflict = await store.mutateCommentOnce(
			{ ...receipt, endpoint: "reply", fingerprint: '{"body":"changed"}' },
			state => ({ next: state, comment: null }),
		);
		expect(conflict).toEqual({ kind: "conflict" });
	});

	test("write/rename seams are exported for tests", () => {
		expect(typeof writePreviewStateTmp).toBe("function");
		expect(typeof renamePreviewStateFile).toBe("function");
	});
});
