import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { replaceBinaryForUpdate } from "@oh-my-pi/pi-coding-agent/cli/update-cli";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

// Issue #845's Bun-managed update classifier no longer exists: current updates
// use the install script on POSIX and direct binary replacement on Windows.
// Keep a symlinked-bin regression on the remaining production path so replacing
// an installed binary reached through a symlink still updates the real target.

describe("issue-845: binary replacement through symlinked bin dirs", () => {
	let tmpRoot: string;
	let realBinDir: string;
	let linkedBinDir: string;

	beforeAll(() => {
		tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omp-issue-845-"));
		realBinDir = path.join(tmpRoot, "real", "bin");
		fs.mkdirSync(realBinDir, { recursive: true });
		fs.writeFileSync(path.join(realBinDir, "omp"), "old", { mode: 0o755 });

		linkedBinDir = path.join(tmpRoot, "link-bin");
		fs.symlinkSync(realBinDir, linkedBinDir, "dir");
	});

	afterAll(() => {
		removeSyncWithRetries(tmpRoot);
	});

	it("replaces the real binary when targetPath is reached through a symlinked bin dir", async () => {
		const tempPath = path.join(tmpRoot, "omp-new");
		const targetPath = path.join(linkedBinDir, "omp");
		const backupPath = `${targetPath}.bak`;
		fs.writeFileSync(tempPath, "new", { mode: 0o755 });

		const verification = await replaceBinaryForUpdate({
			targetPath,
			tempPath,
			backupPath,
			expectedVersion: "1.2.3",
			verifyInstalledVersion: async expectedVersion => ({ ok: true, actual: expectedVersion }),
		});

		expect(verification).toEqual({ ok: true, actual: "1.2.3" });
		expect(fs.readFileSync(path.join(realBinDir, "omp"), "utf8")).toBe("new");
		expect(fs.existsSync(tempPath)).toBe(false);
	});
});
