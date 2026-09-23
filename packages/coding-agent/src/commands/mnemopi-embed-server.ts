/**
 * `ompx mnemopi-embed-server` — serve mnemopi embeddings to every ompx session on the network.
 */
import { APP_NAME } from "@oh-my-pi/pi-utils";
import { Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { mnemopiEmbedServerHelp as commandHelp } from "../cli/command-help";
import { MnemopiEmbedClient } from "../mnemopi/embed-client";
import { MNEMOPI_EMBED_SERVER_PORT, startMnemopiEmbedServer } from "../mnemopi/embed-server";

const DEFAULT_HOST = "0.0.0.0";

export default class MnemopiEmbedServer extends Command {
	static description = commandHelp.description;

	static flags = {
		host: Flags.string({ description: "Bind address", default: DEFAULT_HOST }),
		port: Flags.integer({ description: "Listen port", default: MNEMOPI_EMBED_SERVER_PORT }),
	};

	static examples = [
		`# Serve on all interfaces, port ${MNEMOPI_EMBED_SERVER_PORT}\n  ${APP_NAME} mnemopi-embed-server`,
		`# Loopback only\n  ${APP_NAME} mnemopi-embed-server --host 127.0.0.1`,
	];

	async run(): Promise<void> {
		const { flags } = await this.parse(MnemopiEmbedServer);
		const client = new MnemopiEmbedClient();
		const server = startMnemopiEmbedServer({ hostname: flags.host ?? DEFAULT_HOST, port: flags.port, client });
		process.stdout.write(`mnemopi embed server listening on ${server.url}\n`);
		const { promise: stopped, resolve: stop } = Promise.withResolvers<void>();
		process.once("SIGTERM", stop);
		process.once("SIGINT", stop);
		await stopped;
		await server.stop(true);
		await client.terminate();
	}
}
