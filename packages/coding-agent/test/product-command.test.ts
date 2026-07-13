import { describe, expect, test, vi } from "bun:test";
import { createProductPreviewCommand } from "@oh-my-pi/pi-coding-agent/commands/product";
import {
	type PreviewServerHandle,
	type PreviewServerOptions,
	type ShareController,
	type ShareInfo,
	ShareUnavailableError,
	type StartPreviewServer,
} from "@oh-my-pi/pi-coding-agent/product-preview/types";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";
import type { CliConfig } from "@oh-my-pi/pi-utils/cli";

const shareInfo: ShareInfo = {
	shareUrl: "http://100.101.102.103:4100/?t=secret-token",
	token: "secret-token",
	host: "100.101.102.103",
	port: 4100,
};

const config: CliConfig = { bin: "ompx", version: "test", commands: new Map() };

function createShareController(): ShareController {
	return {
		enabled: () => false,
		enable: async () => shareInfo,
		disable: () => {},
		verifyToken: () => false,
		mintExportToken: () => "export-token",
		consumeExportToken: () => false,
		handoffPrompt: () => "handoff",
	};
}

function createServer(options?: { enableShare?: () => Promise<ShareInfo> }): PreviewServerHandle {
	let sharing = false;
	return {
		port: 4100,
		localUrl: "http://127.0.0.1:4100/",
		refresh: async () => ({
			bundle: { title: "Product Preview", root: "/tmp/product", generatedAt: 0 },
			capabilities: { feedback: false },
			items: [],
		}),
		shareInfo: () => (sharing ? shareInfo : null),
		enableShare: async () => {
			const info = await (options?.enableShare?.() ?? Promise.resolve(shareInfo));
			sharing = true;
			return info;
		},
		disableShare: () => {
			sharing = false;
		},
		stop: async () => {},
	};
}

function createRuntime(outputs: string[]): SlashCommandRuntime {
	return {
		session: {} as SlashCommandRuntime["session"],
		sessionManager: {} as SlashCommandRuntime["sessionManager"],
		settings: {} as SlashCommandRuntime["settings"],
		cwd: "/tmp/product",
		output: text => {
			outputs.push(text);
		},
		refreshCommands: () => {},
		reloadPlugins: async () => {},
	};
}

describe("product preview command", () => {
	test("parses preview port/share/no-open/root and starts the injected server", async () => {
		const starts: Array<PreviewServerOptions | undefined> = [];
		const server = createServer();
		const startServer: StartPreviewServer = async options => {
			starts.push(options);
			return server;
		};
		const shareController = createShareController();
		const { command } = createProductPreviewCommand({
			startServer,
			makeShareController: () => shareController,
		});
		const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		const spawn = vi.spyOn(Bun, "spawn");

		try {
			await new command(
				["preview", "--port", "4100", "--share", "--no-open", "--root", "docs/review"],
				config,
			).run();
			expect(spawn).not.toHaveBeenCalled();
		} finally {
			spawn.mockRestore();
			write.mockRestore();
		}

		expect(starts).toEqual([{ port: 4100, root: "docs/review", share: shareController }]);
		expect(server.shareInfo()).toEqual(shareInfo);
	});

	test("writes share on, off, and status results only to the runtime output", async () => {
		const server = createServer();
		const startServer: StartPreviewServer = async () => server;
		const { slashCommand } = createProductPreviewCommand({
			startServer,
			makeShareController: createShareController,
		});
		const outputs: string[] = [];
		const runtime = createRuntime(outputs);
		const handle = slashCommand.handle;
		if (!handle) throw new Error("Expected product preview slash handler");

		expect(
			await handle({ name: "product-preview", args: "share on", text: "/product-preview share on" }, runtime),
		).toBeUndefined();
		await handle({ name: "product-preview", args: "share status", text: "/product-preview share status" }, runtime);
		await handle({ name: "product-preview", args: "share off", text: "/product-preview share off" }, runtime);

		expect(outputs).toEqual([
			"Product preview sharing enabled. Keep this URL private: http://100.101.102.103:4100/?t=secret-token",
			"Product preview sharing is enabled.",
			"Product preview sharing disabled.",
		]);
	});

	test("refuses share enablement without a Tailscale address", async () => {
		const server = createServer({
			enableShare: async () => {
				throw new ShareUnavailableError("No Tailscale IP is available.");
			},
		});
		const startServer: StartPreviewServer = async () => server;
		const { slashCommand } = createProductPreviewCommand({
			startServer,
			makeShareController: createShareController,
		});
		const outputs: string[] = [];
		const handle = slashCommand.handle;
		if (!handle) throw new Error("Expected product preview slash handler");

		await handle(
			{ name: "product-preview", args: "share on", text: "/product-preview share on" },
			createRuntime(outputs),
		);

		expect(outputs).toEqual(["Unable to enable product preview sharing: No Tailscale IP is available."]);
	});
});
