import { afterEach, describe, expect, it, vi } from "bun:test";
import * as os from "node:os";
import { OAuthCallbackFlow } from "@oh-my-pi/pi-ai/registry/oauth/callback-server";
import type { OAuthAuthInfo, OAuthCredentials } from "@oh-my-pi/pi-ai/registry/oauth/types";

/**
 * A user logging in from another tailnet device needs the callback server to
 * answer on this host's Tailscale address too. CI hosts have no tailnet, so the
 * interface table reports a fake tailnet address and the bind for it is
 * redirected to a spare loopback address that is reachable locally.
 */
const TAILNET_ADDRESS = "100.100.100.100";
const STAND_IN_ADDRESS = "127.0.0.2";

class ProbeFlow extends OAuthCallbackFlow {
	async generateAuthUrl(state: string, redirectUri: string): Promise<{ url: string }> {
		return {
			url: `https://auth.example.com/authorize?${new URLSearchParams({ redirect_uri: redirectUri, state })}`,
		};
	}

	async exchangeToken(code: string): Promise<OAuthCredentials> {
		return { access: code, refresh: "unused", expires: Date.now() + 60_000 };
	}
}

function interfaceTable(withTailnet: boolean): NodeJS.Dict<os.NetworkInterfaceInfo[]> {
	const table: NodeJS.Dict<os.NetworkInterfaceInfo[]> = {
		lo: [
			{
				address: "127.0.0.1",
				netmask: "255.0.0.0",
				family: "IPv4",
				mac: "00:00:00:00:00:00",
				internal: true,
				cidr: "127.0.0.1/8",
			},
		],
	};
	if (withTailnet) {
		table.tailscale0 = [
			{
				address: TAILNET_ADDRESS,
				netmask: "255.255.255.255",
				family: "IPv4",
				mac: "00:00:00:00:00:00",
				internal: false,
				cidr: `${TAILNET_ADDRESS}/32`,
			},
		];
	}
	return table;
}

/** Bind the tailnet listener on {@link STAND_IN_ADDRESS}; `fail` simulates a bind error. */
function redirectTailnetBind(fail = false): (string | undefined)[] {
	const serve = Bun.serve.bind(Bun) as typeof Bun.serve;
	const hostnames: (string | undefined)[] = [];
	vi.spyOn(Bun, "serve").mockImplementation(((options: Parameters<typeof Bun.serve>[0]) => {
		hostnames.push(options.hostname);
		if (options.hostname !== TAILNET_ADDRESS) return serve(options);
		if (fail) throw Object.assign(new Error("cannot assign requested address"), { code: "EADDRNOTAVAIL" });
		return serve({ ...options, hostname: STAND_IN_ADDRESS });
	}) as typeof Bun.serve);
	return hostnames;
}

async function startFlow(): Promise<{ info: OAuthAuthInfo; abort: AbortController; login: Promise<OAuthCredentials> }> {
	const abort = new AbortController();
	const authFired = Promise.withResolvers<OAuthAuthInfo>();
	const flow = new ProbeFlow({ onAuth: info => authFired.resolve(info), signal: abort.signal }, { preferredPort: 0 });
	const login = flow.login();
	void login.catch(() => undefined);
	return { info: await authFired.promise, abort, login };
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("OAuthCallbackFlow Tailscale shortcut", () => {
	it("serves /launch and the callback on the tailnet address when Tailscale is up", async () => {
		vi.spyOn(os, "networkInterfaces").mockReturnValue(interfaceTable(true));
		redirectTailnetBind();
		const { info, abort, login } = await startFlow();
		try {
			const launch = new URL(info.launchUrl ?? "");
			expect(info.tailnetLaunchUrl).toBe(`http://${TAILNET_ADDRESS}:${launch.port}/launch`);
			// Provider redirect stays loopback: providers validate it against the registered callback.
			const authUrl = new URL(info.url);
			expect(new URL(authUrl.searchParams.get("redirect_uri") ?? "").hostname).toBe("localhost");

			const remoteBase = `http://${STAND_IN_ADDRESS}:${launch.port}`;
			const launched = await fetch(`${remoteBase}/launch`, { redirect: "manual" });
			expect(launched.status).toBe(302);
			expect(launched.headers.get("location")).toBe(info.url);

			const state = authUrl.searchParams.get("state") ?? "";
			const forged = await fetch(`${remoteBase}/callback?code=attacker&state=wrong`);
			expect(forged.status).toBe(500);
			const callback = await fetch(`${remoteBase}/callback?code=remote-code&state=${encodeURIComponent(state)}`);
			expect(callback.status).toBe(200);
			expect((await login).access).toBe("remote-code");

			// The tailnet listener shuts down with the flow.
			await expect(fetch(`${remoteBase}/launch`)).rejects.toThrow();
		} finally {
			abort.abort("test cleanup");
			await login.catch(() => undefined);
		}
	});

	it("advertises no tailnet shortcut and binds only loopback without Tailscale", async () => {
		vi.spyOn(os, "networkInterfaces").mockReturnValue(interfaceTable(false));
		const hostnames = redirectTailnetBind();
		const { info, abort, login } = await startFlow();
		try {
			expect(info.tailnetLaunchUrl).toBeUndefined();
			expect(hostnames).toEqual(["127.0.0.1"]);
		} finally {
			abort.abort("test cleanup");
			await login.catch(() => undefined);
		}
	});

	it("keeps the loopback login working when the tailnet bind fails", async () => {
		vi.spyOn(os, "networkInterfaces").mockReturnValue(interfaceTable(true));
		redirectTailnetBind(true);
		const { info, abort, login } = await startFlow();
		try {
			expect(info.tailnetLaunchUrl).toBeUndefined();
			const authUrl = new URL(info.url);
			const redirectUri = authUrl.searchParams.get("redirect_uri") ?? "";
			const state = authUrl.searchParams.get("state") ?? "";
			const callback = await fetch(`${redirectUri}?code=local-code&state=${encodeURIComponent(state)}`);
			expect(callback.status).toBe(200);
			expect((await login).access).toBe("local-code");
		} finally {
			abort.abort("test cleanup");
			await login.catch(() => undefined);
		}
	});
});
