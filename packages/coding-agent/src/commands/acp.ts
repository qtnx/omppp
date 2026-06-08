/**
 * Run OMPx as an ACP (Agent Client Protocol) server over stdio.
 *
 * Thin wrapper around the launch flow that forces `mode: "acp"` unless the
 * ACP terminal-auth flag asks the same command to open the interactive TUI.
 */

import { APP_DISPLAY_NAME } from "@oh-my-pi/pi-utils";
import { Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { parseArgs } from "../cli/args";
import { runRootCommand } from "../main";
import { prepareAcpTerminalAuthArgs } from "../modes/acp/terminal-auth";

export default class Acp extends Command {
	static description = `Run ${APP_DISPLAY_NAME} as an ACP (Agent Client Protocol) server over stdio`;
	static strict = false;
	static flags = {
		"no-sandbox": Flags.boolean({
			description: "Disable macOS sandboxing for nested OMPx spawns in this session",
		}),
	};

	async run(): Promise<void> {
		const { args, terminalAuth } = prepareAcpTerminalAuthArgs(this.argv);
		const parsed = parseArgs(args);
		if (!terminalAuth) {
			parsed.mode = "acp";
		}
		await runRootCommand(parsed, args);
	}
}
