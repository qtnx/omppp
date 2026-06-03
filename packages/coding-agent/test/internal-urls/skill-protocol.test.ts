import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { resetActiveSkillsForTests, type Skill, setActiveSkills } from "../../src/extensibility/skills";
import { InternalUrlRouter } from "../../src/internal-urls";

function createSkill(baseDir: string, name: string): Skill {
	const filePath = path.join(baseDir, name, "SKILL.md");
	return {
		name,
		description: `${name} skill`,
		filePath,
		baseDir: path.dirname(filePath),
		source: "test",
	};
}

describe("SkillProtocolHandler", () => {
	afterEach(() => {
		resetActiveSkillsForTests();
		InternalUrlRouter.resetForTests();
	});

	it("resolves skill:// URLs against caller-scoped skills before the process-global catalog", async () => {
		using tempDir = TempDir.createSync("@omp-skill-scope-");
		const scopedAllowed = createSkill(path.join(tempDir.path(), "scoped"), "allowed");
		const globalAllowed = createSkill(path.join(tempDir.path(), "global"), "allowed");
		const globalOnly = createSkill(tempDir.path(), "global-only");
		await Bun.write(scopedAllowed.filePath, "scoped allowed skill");
		await Bun.write(globalAllowed.filePath, "global allowed skill");
		await Bun.write(globalOnly.filePath, "global skill");
		setActiveSkills([globalAllowed, globalOnly]);

		const router = InternalUrlRouter.instance();
		const allowedResource = await router.resolve("skill://allowed", { skills: [scopedAllowed] });
		expect(allowedResource.content).toBe("scoped allowed skill");
		await expect(router.resolve("skill://global-only", { skills: [scopedAllowed] })).rejects.toThrow(
			"Unknown skill: global-only\nAvailable: allowed",
		);
	});
});
