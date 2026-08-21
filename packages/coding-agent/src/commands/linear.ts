import { Args, Command } from "@oh-my-pi/pi-utils/cli";
import { linearHelp as commandHelp } from "../cli/command-help";
import { ensureLinearMcpConfig } from "../linear/config";
import { initTheme } from "../modes/theme/theme";

export default class Linear extends Command {
	static description = commandHelp.description;
	static args = {
		action: Args.string({
			description: "Linear action",
			required: false,
			options: ["add"],
		}),
	};

	async run(): Promise<void> {
		const { args } = await this.parse(Linear);
		if (args.action !== "add") {
			console.error("Usage: ompx linear add");
			process.exitCode = 1;
			return;
		}
		await initTheme();
		try {
			const added = await ensureLinearMcpConfig(process.cwd());
			console.log(
				added
					? "Linear MCP server added. OAuth will occur when you connect with /linear on."
					: "Linear MCP server is already configured. OAuth will occur when you connect with /linear on.",
			);
		} catch (error) {
			console.error(error instanceof Error ? error.message : String(error));
			process.exitCode = 1;
		}
	}
}
