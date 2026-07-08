/**
 * `ompx auth-gateway` — run a forward proxy that injects local or broker auth.
 */

import { APP_NAME } from "@oh-my-pi/pi-utils";
import { Args, Command, Flags, renderCommandHelp } from "@oh-my-pi/pi-utils/cli";
import {
	AUTH_GATEWAY_ACTIONS,
	type AuthGatewayAction,
	type AuthGatewayCommandArgs,
	runAuthGatewayCommand,
} from "../cli/auth-gateway-cli";
import { initTheme } from "../modes/theme/theme";

export default class AuthGateway extends Command {
	static description = "Run an auth-gateway forward proxy backed by local or broker credentials";

	static args = {
		action: Args.string({
			description: "Sub-command",
			required: false,
			options: [...AUTH_GATEWAY_ACTIONS],
		}),
	};

	static flags = {
		json: Flags.boolean({ description: "Output JSON (token/status/check)" }),
		bind: Flags.string({ description: "Bind address for `serve` (host:port)", char: "b" }),
		regenerate: Flags.boolean({ description: "Regenerate the gateway bearer token (token)" }),
		daemon: Flags.boolean({ description: "Run `serve` in the background and exit after the gateway is healthy" }),
		"no-auth": Flags.boolean({
			description:
				"Disable inbound bearer-token auth (serve). Useful when bound to loopback — any caller is allowed.",
		}),
		local: Flags.boolean({
			description:
				"Use local SQLite/env/config credentials even when an auth broker is configured (serve/status/check).",
		}),
		strict: Flags.boolean({
			description:
				"For `check`: additionally probe each credential against its provider's chat-completion endpoint. Slower; consumes a tiny amount of quota per credential.",
		}),
	};

	static examples = [
		`# Boot the gateway from broker credentials when configured, otherwise local credentials\n  ${APP_NAME} auth-gateway serve`,
		`# Boot the gateway in the background and return after /healthz is ready\n  ${APP_NAME} auth-gateway serve --daemon`,
		`# Force this machine's local credentials even when a broker is configured\n  ${APP_NAME} auth-gateway serve --local`,
		`# Print the gateway bearer token (creates one on first run)\n  ${APP_NAME} auth-gateway token`,
		`# Rotate the gateway bearer token\n  ${APP_NAME} auth-gateway token --regenerate`,
		`# Run on loopback without any bearer (anyone on this host can call)\n  ${APP_NAME} auth-gateway serve --no-auth`,
		`# Show gateway token + selected credential source\n  ${APP_NAME} auth-gateway status`,
		`# Probe each selected-source credential to see which one is producing 401s\n  ${APP_NAME} auth-gateway check`,
		`# Same, machine-readable for scripts\n  ${APP_NAME} auth-gateway check --json`,
		`# Strict check — also exercises each credential with a real chat-completion ping\n  ${APP_NAME} auth-gateway check --strict`,
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(AuthGateway);
		if (!args.action) {
			renderCommandHelp(APP_NAME, "auth-gateway", AuthGateway);
			return;
		}
		const cmd: AuthGatewayCommandArgs = {
			action: args.action as AuthGatewayAction,
			flags: {
				json: flags.json,
				bind: flags.bind,
				regenerate: flags.regenerate,
				noAuth: flags["no-auth"],
				strict: flags.strict,
				local: flags.local,
				daemon: flags.daemon,
			},
		};
		await initTheme();
		await runAuthGatewayCommand(cmd);
	}
}
