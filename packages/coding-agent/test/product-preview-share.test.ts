import { afterEach, describe, expect, test, vi } from "bun:test";
import * as os from "node:os";
import {
	ProductPreviewShareController,
	type TailscaleCommand,
	type TailscaleCommandResult,
} from "../src/product-preview/share";
import { EXPORT_TOKEN_TTL_MS, ShareUnavailableError } from "../src/product-preview/types";

const TAILNET_IP = "100.101.102.103";

interface FakeTailscale {
	commands: TailscaleCommand[];
	run: (command: TailscaleCommand) => Promise<TailscaleCommandResult>;
}

function tailscale(responses: Partial<Record<TailscaleCommand, TailscaleCommandResult>> = {}): FakeTailscale {
	const commands: TailscaleCommand[] = [];
	return {
		commands,
		run: async command => {
			commands.push(command);
			return responses[command] ?? { exitCode: 0, stdout: "", stderr: "" };
		},
	};
}

function mockTailnetInterface(address = TAILNET_IP): void {
	vi.spyOn(os, "networkInterfaces").mockReturnValue({
		tailscale0: [
			{
				address,
				family: "IPv4",
				internal: false,
				mac: "00:00:00:00:00:00",
				netmask: "255.192.0.0",
				cidr: "100.64.0.0/10",
			},
		],
	});
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("ProductPreviewShareController", () => {
	test("mints a 128-bit token and rotates all share credentials", async () => {
		mockTailnetInterface();
		const controller = new ProductPreviewShareController();

		const first = await controller.enable(3877);
		const exportToken = controller.mintExportToken();
		const second = await controller.enable(3877);

		expect(Buffer.from(first.token, "base64url")).toHaveLength(16);
		expect(first.shareUrl).toBe(`http://${TAILNET_IP}:3877/?t=${first.token}`);
		expect(controller.verifyToken(first.token)).toBe(false);
		expect(controller.consumeExportToken(exportToken)).toBe(false);
		expect(controller.verifyToken(second.token)).toBe(true);

		controller.disable();
		controller.disable();
		expect(controller.enabled()).toBe(false);
		expect(controller.verifyToken(second.token)).toBe(false);
	});

	test("rejects a wrong or malformed token without accepting it", async () => {
		mockTailnetInterface();
		const controller = new ProductPreviewShareController();
		const info = await controller.enable(3877);
		const wrong = `${info.token.slice(0, -1)}${info.token.endsWith("A") ? "B" : "A"}`;

		expect(controller.verifyToken(wrong)).toBe(false);
		expect(controller.verifyToken(`${info.token}!`)).toBe(false);
		expect(controller.verifyToken(info.token)).toBe(true);
	});

	test("consumes export tokens once and expires them at the TTL boundary", async () => {
		mockTailnetInterface();
		let now = 1_000;
		const controller = new ProductPreviewShareController({ now: () => now });
		await controller.enable(3877);

		const singleUse = controller.mintExportToken();
		expect(controller.consumeExportToken(singleUse)).toBe(true);
		expect(controller.consumeExportToken(singleUse)).toBe(false);

		const expired = controller.mintExportToken();
		now += EXPORT_TOKEN_TTL_MS;
		expect(controller.consumeExportToken(expired)).toBe(false);
	});

	test("uses a Tailscale interface before invoking the CLI fallback", async () => {
		mockTailnetInterface();
		const fake = tailscale();
		const controller = new ProductPreviewShareController({ runTailscale: fake.run });

		const info = await controller.enable(3210);

		expect(info.host).toBe(TAILNET_IP);
		expect(fake.commands).toEqual(["funnel status"]);
	});

	test("falls back to tailscale ip -4 when no interface is listed", async () => {
		vi.spyOn(os, "networkInterfaces").mockReturnValue({});
		const fake = tailscale({ "ip -4": { exitCode: 0, stdout: `${TAILNET_IP}\n`, stderr: "" } });
		const controller = new ProductPreviewShareController({ runTailscale: fake.run });

		const info = await controller.enable(3877);

		expect(info.host).toBe(TAILNET_IP);
		expect(fake.commands).toEqual(["ip -4", "funnel status"]);
	});

	test("refuses sharing when Tailscale cannot provide an IPv4 address", async () => {
		vi.spyOn(os, "networkInterfaces").mockReturnValue({});
		const fake = tailscale({ "ip -4": { exitCode: 127, stdout: "", stderr: "tailscale: not found" } });
		const controller = new ProductPreviewShareController({ runTailscale: fake.run });

		await expect(controller.enable(3877)).rejects.toBeInstanceOf(ShareUnavailableError);
		expect(controller.enabled()).toBe(false);
		expect(fake.commands).toEqual(["ip -4"]);
	});

	test("refuses an active Funnel for the preview port but tolerates a missing funnel CLI", async () => {
		mockTailnetInterface();
		const funnel = tailscale({
			"funnel status": { exitCode: 0, stdout: "https://host.ts.net/ proxy http://127.0.0.1:3877", stderr: "" },
		});
		const blocked = new ProductPreviewShareController({ runTailscale: funnel.run });

		await expect(blocked.enable(3877)).rejects.toThrow("Funnel");
		expect(blocked.enabled()).toBe(false);

		const missing = tailscale({
			"funnel status": { exitCode: 127, stdout: "", stderr: "tailscale: command not found" },
		});
		const allowed = new ProductPreviewShareController({ runTailscale: missing.run });
		await expect(allowed.enable(3877)).resolves.toMatchObject({ host: TAILNET_IP });
	});

	test("creates an env-var export handoff for a fresh destination and warns about untrusted content", async () => {
		mockTailnetInterface();
		const controller = new ProductPreviewShareController();
		const info = await controller.enable(3877);

		const prompt = controller.handoffPrompt(info, "bundle-a1");
		const token = prompt.match(/OMPX_ET='([^']+)'/)?.[1];

		expect(prompt).toContain("Authorization: Bearer $OMPX_ET");
		expect(prompt).toContain(`http://${TAILNET_IP}:3877/api/export`);
		expect(prompt).not.toContain(`?t=${info.token}`);
		expect(prompt).toContain("docs/product-shared/bundle-a1/");
		expect(prompt).toContain("tar -xz --no-same-owner");
		expect(prompt).toContain("untrusted content");
		expect(prompt).toContain("confirm the intended implementation before acting");
		expect(token).toBeDefined();
		expect(controller.consumeExportToken(token ?? "")).toBe(true);
	});

	test("advertises the validated machine hostname as a Host alias", async () => {
		mockTailnetInterface();
		vi.spyOn(os, "hostname").mockReturnValue("CodeMC");
		const controller = new ProductPreviewShareController({ runTailscale: tailscale().run });

		const info = await controller.enable(3877);

		expect(info.hostAliases).toEqual(["codemc"]); // lowercased, validated
	});

	test("omits a non-DNS hostname from the Host aliases", async () => {
		mockTailnetInterface();
		vi.spyOn(os, "hostname").mockReturnValue("bad_host name!");
		const controller = new ProductPreviewShareController({ runTailscale: tailscale().run });

		const info = await controller.enable(3877);

		expect(info.hostAliases).toEqual([]);
	});
});
