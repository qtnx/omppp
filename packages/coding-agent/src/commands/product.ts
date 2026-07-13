import "@oh-my-pi/pi-utils/env";
import { logger } from "@oh-my-pi/pi-utils";
import { Args, Command, type CommandCtor, Flags } from "@oh-my-pi/pi-utils/cli";
import { makeShareController, startPreviewServer } from "../product-preview";
import {
	type PreviewFeedback,
	type PreviewServerHandle,
	type PreviewServerOptions,
	type ShareController,
	ShareUnavailableError,
	type StartPreviewServer,
} from "../product-preview/types";
import { PREVIEW_FEEDBACK_MESSAGE_TYPE } from "../session/messages";
import { parseSubcommand, usage } from "../slash-commands/helpers/parse";
import type { SlashCommandRuntime, SlashCommandSpec } from "../slash-commands/types";
import { openPath } from "../utils/open";

interface ProductPreviewCommandDeps {
	startServer: StartPreviewServer;
	makeShareController?: () => ShareController;
	/**
	 * Session-attached delivery hook. Slash-command invocations resolve this
	 * from the live AgentSession; the standalone CLI leaves it unset so
	 * side-ask/comments/answers stay 503 (no agent to receive them).
	 */
	deliverFeedback?: (feedback: PreviewFeedback) => void;
}

interface ProductPreviewCommandFactory {
	command: CommandCtor;
	slashCommand: SlashCommandSpec;
}

interface StartOptions {
	port?: number;
	root?: string;
	/** Per-start delivery override (slash path resolves this from the live session). */
	deliverFeedback?: (feedback: PreviewFeedback) => void;
}

/**
 * Builds the CLI and slash-command entry points around one preview-server
 * lifecycle so `/product-preview share on` can enable sharing after a local
 * preview has already started.
 */
export function createProductPreviewCommand(deps: ProductPreviewCommandDeps): ProductPreviewCommandFactory {
	let server: PreviewServerHandle | undefined;
	/**
	 * Retained start options object. The preview server stores this by
	 * reference, so slash re-invocations can refresh `deliverFeedback` on a
	 * reused server without restarting it (otherwise session A keeps receiving
	 * feedback after session B re-runs `/product-preview`).
	 */
	let serverOptions: PreviewServerOptions | undefined;

	const start = async (options: StartOptions = {}): Promise<PreviewServerHandle> => {
		// Prefer the per-start override (slash resolves from runtime.session) over
		// the static factory dep (CLI usually leaves both unset → 503 side-ask).
		const deliverFeedback = options.deliverFeedback ?? deps.deliverFeedback;

		if (server && serverOptions) {
			// Always refresh the live delivery hook on reuse — same process may
			// re-invoke from a different AgentSession, or first start had none.
			if (deliverFeedback) {
				serverOptions.deliverFeedback = deliverFeedback;
			} else {
				delete serverOptions.deliverFeedback;
			}
			await server.refresh();
			return server;
		}

		serverOptions = {
			port: options.port,
			root: options.root,
			share: deps.makeShareController?.(),
			...(deliverFeedback ? { deliverFeedback } : {}),
		};
		server = await deps.startServer(serverOptions);
		return server;
	};

	const enableShare = async (handle: PreviewServerHandle): Promise<string> => {
		try {
			const info = await handle.enableShare();
			return `Product preview sharing enabled. Keep this URL private: ${info.shareUrl}`;
		} catch (error) {
			if (error instanceof ShareUnavailableError) {
				return `Unable to enable product preview sharing: ${error.message || "No Tailscale IP is available."}`;
			}
			logger.error("Product preview share enable failed", { error });
			return "Unable to enable product preview sharing.";
		}
	};

	class ProductPreviewCommand extends Command {
		static description = "Open a local Product Preview WebUI";
		static args = {
			action: Args.string({ description: "preview", required: true, options: ["preview"] }),
		};
		static flags = {
			port: Flags.integer({ description: "Port for the preview server" }),
			share: Flags.boolean({ description: "Enable Tailscale sharing" }),
			"no-open": Flags.boolean({ description: "Do not open the preview in a browser" }),
			root: Flags.string({ description: "Artifact root directory" }),
		};

		async run(): Promise<void> {
			const { flags } = await this.parse(ProductPreviewCommand);
			// CLI has no live agent session: start without deliverFeedback.
			const handle = await start({ port: flags.port, root: flags.root });
			process.stdout.write(`Product preview: ${handle.localUrl}\n`);

			if (flags.share) process.stdout.write(`${await enableShare(handle)}\n`);
			if (!flags["no-open"]) openPath(handle.localUrl);
		}
	}

	const slashCommand: SlashCommandSpec = {
		name: "product-preview",
		description: "Open Product Preview or manage sharing",
		allowArgs: true,
		subcommands: [{ name: "share", description: "Manage sharing", usage: "[on|off|status]" }],
		handle: async (command, runtime) => {
			// Per-invocation: bind deliverFeedback to this slash command's live
			// AgentSession so side-ask/comment/answer events enqueue as steering.
			// Seam: runtime.session.yieldQueue.enqueue(PREVIEW_FEEDBACK_MESSAGE_TYPE, …)
			const yieldQueue = (runtime as SlashCommandRuntime).session?.yieldQueue;
			const deliverFeedback = yieldQueue
				? (feedback: PreviewFeedback) => {
						yieldQueue.enqueue(PREVIEW_FEEDBACK_MESSAGE_TYPE, feedback);
					}
				: undefined;
			const { verb, rest } = parseSubcommand(command.args);
			if (!verb) {
				const handle = await start({ deliverFeedback });
				await runtime.output(`Product preview: ${handle.localUrl}`);
				return;
			}

			if (verb !== "share") return usage("Usage: /product-preview [share on|off|status]", runtime);

			const action = parseSubcommand(rest);
			if (action.rest || !["on", "off", "status"].includes(action.verb)) {
				return usage("Usage: /product-preview share [on|off|status]", runtime);
			}

			if (action.verb === "on") {
				const handle = await start({ deliverFeedback });
				await runtime.output(await enableShare(handle));
				return;
			}

			if (action.verb === "off") {
				if (!server) {
					await runtime.output("Product preview is not running.");
					return;
				}
				server.disableShare();
				await runtime.output("Product preview sharing disabled.");
				return;
			}

			if (!server) {
				await runtime.output("Product preview is not running.");
				return;
			}
			await runtime.output(
				server.shareInfo() ? "Product preview sharing is enabled." : "Product preview sharing is disabled.",
			);
		},
	};

	return { command: ProductPreviewCommand, slashCommand };
}

/**
 * Standalone CLI command, initialized only after profile bootstrap via the
 * lazy command loader in cli-commands.ts.
 */
export const standaloneProductPreviewCommand = createProductPreviewCommand({
	startServer: startPreviewServer,
	makeShareController,
});
