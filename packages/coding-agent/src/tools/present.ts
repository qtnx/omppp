import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { prompt } from "@oh-my-pi/pi-utils";
import { type } from "arktype";
import type {
	PreviewFeedback,
	PreviewServerHandle,
	PreviewServerOptions,
	StartPreviewServer,
} from "../product-preview/types";
import presentDescription from "../prompts/tools/present.md" with { type: "text" };
import * as openUtils from "../utils/open";
import { toolResult } from "./tool-result";

const presentSchema = type({
	"root?": type("string").describe("artifact root; defaults to docs/product"),
	"paths?": type("string[]").describe("extra files or directories to include"),
	"title?": type("string").describe("preview title"),
	"open?": type("boolean").describe("open the local preview in the default browser (default true)"),
	"share?": type("boolean").describe("request sharing; agents must use the slash command instead"),
});

type PresentParams = typeof presentSchema.infer;

export interface PresentToolDeps {
	startServer: StartPreviewServer;
	/** When set, side-ask/comment/answer events are delivered into the owner session. */
	deliverFeedback?: (feedback: PreviewFeedback) => void;
}

function serverOptions(params: PresentParams, deps: PresentToolDeps): PreviewServerOptions {
	const options: PreviewServerOptions = {};
	if (params.root !== undefined) options.root = params.root;
	if (params.paths !== undefined) options.extraPaths = params.paths;
	if (params.title !== undefined) options.title = params.title;
	// Thread the session delivery callback so the preview server can enqueue
	// feedback instead of returning 503 for side-ask/comments/answers.
	if (deps.deliverFeedback !== undefined) options.deliverFeedback = deps.deliverFeedback;
	return options;
}

/** Create the agent-facing local product-preview entry point. */
export function createPresentTool(deps: PresentToolDeps): AgentTool<typeof presentSchema> {
	let server: PreviewServerHandle | undefined;
	let pendingStart: Promise<PreviewServerHandle> | undefined;

	async function startOrReuse(params: PresentParams): Promise<{ handle: PreviewServerHandle; started: boolean }> {
		if (server) return { handle: server, started: false };
		if (pendingStart) return { handle: await pendingStart, started: false };

		const start = Promise.resolve().then(() => deps.startServer(serverOptions(params, deps)));
		pendingStart = start;
		try {
			server = await start;
			return { handle: server, started: true };
		} finally {
			if (pendingStart === start) pendingStart = undefined;
		}
	}

	return {
		name: "present",
		label: "Present product preview",
		loadMode: "discoverable",
		summary: "Open or refresh a local Product Preview for artifact review",
		approval: "exec",
		description: prompt.render(presentDescription),
		parameters: presentSchema,
		strict: true,
		async execute(_toolCallId, params) {
			if (params.share) {
				return toolResult()
					.text("Sharing cannot be enabled by the agent. Run `/product-preview share on` in the TUI instead.")
					.error()
					.done();
			}

			const preview = await startOrReuse(params);
			const manifest = await preview.handle.refresh();
			if (params.open !== false) openUtils.openPath(preview.handle.localUrl);

			const share = preview.handle.shareInfo();
			const shareStatus = share ? "\nShare: active (URL and token redacted)" : "";
			return toolResult()
				.text(
					`${preview.started ? "Started" : "Refreshed"} product preview: ${preview.handle.localUrl}\nItems: ${manifest.items.length}${shareStatus}`,
				)
				.done();
		},
	};
}
