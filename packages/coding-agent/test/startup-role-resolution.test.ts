import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { buildSessionOptions } from "@oh-my-pi/pi-coding-agent/main";
import type { CreateAgentSessionOptions } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

const unavailable = getBundledModel("openai", "gpt-4o-mini");
const authenticated = getBundledModel("anthropic", "claude-sonnet-4-5");

if (!unavailable || !authenticated) {
	throw new Error("Expected bundled startup role test models");
}

describe("startup role target resolution", () => {
	it.each([
		{
			name: "prewalk",
			args: ["--prewalk-into", "@smol"],
			selectTarget: (options: CreateAgentSessionOptions) => options.prewalk?.target,
		},
		{
			name: "plan-yolo",
			args: ["--plan-yolo", "--plan-yolo-into", "@smol"],
			selectTarget: (options: CreateAgentSessionOptions) => options.planYolo?.target,
		},
	])("uses the first authenticated @smol fallback for $name", async ({ args, selectTarget }) => {
		using tempDir = TempDir.createSync("@omp-startup-role-resolution-");
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		try {
			authStorage.setRuntimeApiKey(authenticated.provider, "test-key");
			const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
			const settings = Settings.isolated({
				modelRoles: {
					smol: [`${unavailable.provider}/${unavailable.id}`, `${authenticated.provider}/${authenticated.id}`],
				},
			});
			const parsed = parseArgs(["--cwd", tempDir.path(), ...args]);

			const options = await buildSessionOptions(parsed, [], undefined, modelRegistry, settings);

			expect(selectTarget(options)).toEqual(authenticated);
		} finally {
			authStorage.close();
		}
	});

	it("disables prewalk when no @smol candidate is authenticated", async () => {
		using tempDir = TempDir.createSync("@omp-startup-role-resolution-");
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		try {
			const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
			const settings = Settings.isolated({
				modelRoles: {
					smol: [`${unavailable.provider}/${unavailable.id}`, `${authenticated.provider}/${authenticated.id}`],
				},
			});
			const parsed = parseArgs(["--cwd", tempDir.path(), "--prewalk-into", "@smol"]);

			const options = await buildSessionOptions(parsed, [], undefined, modelRegistry, settings);

			expect(options.prewalk).toBeUndefined();
		} finally {
			authStorage.close();
		}
	});
});
