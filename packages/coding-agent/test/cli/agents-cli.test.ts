import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseFrontmatter } from "@oh-my-pi/pi-utils";
import { runAgentsCommand } from "../../src/cli/agents-cli";
import { parseAgentFields } from "../../src/discovery/helpers";

afterEach(() => {
	vi.restoreAllMocks();
});

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-agents-cli-"));
	try {
		return await run(dir);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

describe("agents unpack", () => {
	test("round-trips the heavy_task review-gate policy through unpack + reparse", async () => {
		await withTempDir(async dir => {
			vi.spyOn(process.stdout, "write").mockImplementation(() => true);

			await runAgentsCommand({ action: "unpack", flags: { dir, force: true, json: true } });

			const written = await fs.readFile(path.join(dir, "heavy_task.md"), "utf8");
			const { frontmatter } = parseFrontmatter(written, { source: "heavy_task.md" });
			const fields = parseAgentFields(frontmatter);

			expect(fields?.reviewGate).toEqual({
				enabled: true,
				reviewerAgent: "reviewer",
				reviewerModel: ["openai-codex/gpt-5.5:xhigh"],
				fixerAgent: "task",
				maxFixIterations: 2,
				failOnPriorities: [0, 1],
				requireCorrectVerdict: true,
			});
		});
	});

	test("preserves quick_task's disabled review gate on unpack", async () => {
		await withTempDir(async dir => {
			vi.spyOn(process.stdout, "write").mockImplementation(() => true);

			await runAgentsCommand({ action: "unpack", flags: { dir, force: true, json: true } });

			const written = await fs.readFile(path.join(dir, "quick_task.md"), "utf8");
			const { frontmatter } = parseFrontmatter(written, { source: "quick_task.md" });
			const fields = parseAgentFields(frontmatter);

			expect(fields?.reviewGate).toEqual({ enabled: false });
		});
	});
});
