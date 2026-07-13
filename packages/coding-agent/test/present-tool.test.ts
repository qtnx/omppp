import { afterEach, describe, expect, it, vi } from "bun:test";
import type {
	BundleManifest,
	PreviewServerHandle,
	PreviewServerOptions,
	ShareInfo,
	StartPreviewServer,
} from "../src/product-preview/types";
import { createPresentTool } from "../src/tools/present";
import * as openUtils from "../src/utils/open";

const manifest: BundleManifest = {
	bundle: { title: "Product", root: "/workspace/docs/product", generatedAt: 1 },
	capabilities: { feedback: false },
	items: [
		{ id: "brief", kind: "brief", relPath: "brief.md", title: "Brief", mtimeMs: 1, size: 10 },
		{ id: "spec", kind: "spec", relPath: "spec.md", title: "Spec", mtimeMs: 1, size: 20 },
	],
};

function textFrom(result: { content: readonly { type: string; text?: string }[] }): string {
	return result.content
		.filter(
			(content): content is { type: string; text: string } =>
				content.type === "text" && typeof content.text === "string",
		)
		.map(content => content.text)
		.join("\n");
}

function makeHandle(shareInfo: ShareInfo | null = null): { handle: PreviewServerHandle; refreshes: () => number } {
	let refreshCount = 0;
	return {
		handle: {
			port: 3877,
			localUrl: "http://127.0.0.1:3877/",
			refresh: async () => {
				refreshCount += 1;
				return manifest;
			},
			shareInfo: () => shareInfo,
			enableShare: async () => {
				throw new Error("not used by present");
			},
			disableShare: () => {},
			stop: async () => {},
		},
		refreshes: () => refreshCount,
	};
}

function fakeStartServer(handle: PreviewServerHandle): {
	startServer: StartPreviewServer;
	calls: PreviewServerOptions[];
} {
	const calls: PreviewServerOptions[] = [];
	return {
		startServer: async options => {
			calls.push(options ?? {});
			return handle;
		},
		calls,
	};
}

afterEach(() => vi.restoreAllMocks());

describe("present tool", () => {
	it("starts once, refreshes on every call, and reports the local bundle", async () => {
		const preview = makeHandle();
		const fake = fakeStartServer(preview.handle);
		const tool = createPresentTool({ startServer: fake.startServer });

		const first = await tool.execute("first", {
			root: "docs/product/demo",
			paths: ["README.md"],
			title: "Demo",
			open: false,
		});
		const second = await tool.execute("second", { open: false });

		expect(fake.calls).toEqual([{ root: "docs/product/demo", extraPaths: ["README.md"], title: "Demo" }]);
		expect(preview.refreshes()).toBe(2);
		expect(textFrom(first)).toContain("Started product preview: http://127.0.0.1:3877/");
		expect(textFrom(first)).toContain("Items: 2");
		expect(textFrom(second)).toContain("Refreshed product preview");
	});

	it("rejects agent-initiated sharing without starting a server", async () => {
		const preview = makeHandle();
		const fake = fakeStartServer(preview.handle);
		const tool = createPresentTool({ startServer: fake.startServer });

		const result = await tool.execute("share", { share: true });

		expect(result.isError).toBe(true);
		expect(textFrom(result)).toContain("/product-preview share on");
		expect(fake.calls).toEqual([]);
	});

	it("redacts active share credentials from the model-visible result", async () => {
		const secret = "share-token-which-must-not-leak";
		const preview = makeHandle({
			shareUrl: `http://100.100.100.100:3877/?t=${secret}`,
			token: secret,
			host: "100.100.100.100",
			port: 3877,
		});
		const fake = fakeStartServer(preview.handle);
		const tool = createPresentTool({ startServer: fake.startServer });

		const result = await tool.execute("active-share", { open: false });
		const text = textFrom(result);

		expect(text).toContain("Share: active (URL and token redacted)");
		expect(text).not.toContain(secret);
		expect(text).not.toContain("100.100.100.100");
	});

	it("opens the local preview by default", async () => {
		const openPath = vi.spyOn(openUtils, "openPath").mockImplementation(() => {});
		const preview = makeHandle();
		const fake = fakeStartServer(preview.handle);
		const tool = createPresentTool({ startServer: fake.startServer });

		await tool.execute("open", {});

		expect(openPath).toHaveBeenCalledWith("http://127.0.0.1:3877/");
	});

	it("honors open false while starting the injected server", async () => {
		const openPath = vi.spyOn(openUtils, "openPath").mockImplementation(() => {});
		const preview = makeHandle();
		const fake = fakeStartServer(preview.handle);
		const tool = createPresentTool({ startServer: fake.startServer });

		await tool.execute("no-open", { open: false });

		expect(fake.calls).toEqual([{}]);
		expect(openPath).not.toHaveBeenCalled();
	});
});
