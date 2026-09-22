import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { NATIVE_ABI_VERSION, versionSentinelFor } from "../native/version-sentinel.js";
import { embedNativeAddon } from "../scripts/embed-native";

describe("native addon embedding", () => {
	it("rejects a longer release sentinel that starts with the expected version", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-natives-embed-"));
		const nativeDir = path.join(root, "native");
		const outputPath = path.join(nativeDir, "embedded-addon.js");
		const expected = versionSentinelFor(NATIVE_ABI_VERSION);
		try {
			await fs.mkdir(nativeDir);
			await Bun.write(path.join(nativeDir, "pi_natives.win32-arm64.node"), `binary${expected}0`);

			await expect(
				embedNativeAddon({
					targetPlatform: "win32",
					targetArch: "arm64",
					nativeDir,
					outputPath,
					version: "18.1.1",
				}),
			).rejects.toThrow(
				`does not contain the @oh-my-pi/pi-natives@${NATIVE_ABI_VERSION} native ABI sentinel \`${expected}\``,
			);
			expect(await Bun.file(outputPath).exists()).toBe(false);
			expect(await Bun.file(path.join(nativeDir, "embedded-addons.win32-arm64.tar.gz")).exists()).toBe(false);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
