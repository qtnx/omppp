/**
 * `ompx annotate` — install the OMPx Annotate Chrome extension.
 */
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { ANNOTATE_ACTIONS, type AnnotateAction, runAnnotateCommand } from "../cli/annotate-cli";

export default class Annotate extends Command {
	static description = "Write the OMPx Annotate Chrome extension to disk with load-unpacked steps";

	static args = {
		action: Args.string({
			description: `Action: ${ANNOTATE_ACTIONS.join(" | ")} (default install)`,
			options: [...ANNOTATE_ACTIONS],
			required: false,
		}),
	};

	static flags = {
		dir: Flags.string({
			description: "Extension install directory (default ~/.omp/annotate/extension)",
		}),
	};

	static examples = [
		"ompx annotate install            # write the Chrome extension to disk + setup steps",
		"ompx annotate install --dir ./ext",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Annotate);
		await runAnnotateCommand({
			action: (args.action as AnnotateAction | undefined) ?? "install",
			dir: flags.dir,
		});
	}
}
