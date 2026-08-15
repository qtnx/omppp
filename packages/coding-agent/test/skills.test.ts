import { beforeAll, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type Skill as CapabilitySkill, skillCapability } from "@oh-my-pi/pi-coding-agent/capability/skill";
import { getCapability } from "@oh-my-pi/pi-coding-agent/discovery";
import { getWslWindowsHomeCandidate, runHostProbe } from "@oh-my-pi/pi-coding-agent/discovery/agents";
import {
	buildSkillPromptMessage,
	type LoadSkillsResult,
	loadSkills,
	loadSkillsFromDir,
	parseSkillInvocation,
	type Skill,
} from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { parseCanvasDocument } from "@oh-my-pi/pi-coding-agent/product-preview/canvas-schema";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils/dirs";

const fixturesDir = path.resolve(import.meta.dirname, "fixtures/skills");
const collisionFixturesDir = path.resolve(import.meta.dirname, "fixtures/skills-collision");

const longSkillName = "this-is-a-very-long-skill-name-that-exceeds-the-sixty-four-character-limit-set-by-the-standard";
const expectedFixtureSkillOrder: string[] = [
	"bad--name",
	"different-name",
	"Invalid_Name",
	longSkillName,
	"unknown-field",
	"valid-skill",
];

const ARCHIVE_ENGINEERING_SKILL_NAMES = [
	"api-design",
	"bug-hunting",
	"code-review-lens",
	"codebase-recon",
	"competitive-recon",
	"concurrency-correctness",
	"database-craft",
	"dependency-doctor",
	"feature-anatomy",
	"git-craft",
	"incident-response",
	"migration-upgrade",
	"observability-instrumentation",
	"parallel-fanout",
	"preview-templates",
	"product-architecture",
	"product-design",
	"product-discovery",
	"product-ideation",
	"product-spec",
	"refactoring-safely",
	"repo-runbook",
	"security-review",
	"subagents-development",
	"verify-before-done",
	"work-playbooks",
	"writing-tests-that-matter",
] as const;

/**
 * Disable every named built-in skill source. Used by `loadSkills` option tests
 * that need to isolate a custom directory or assert "no built-in leakage". Tests
 * MUST spread this in: the discovery surface only ignores `~/.<dir>/skills/*` if
 * every provider toggle resolves to false, otherwise stray skills from the
 * developer's real `$HOME` (e.g. `~/.agents/skills/<name>/SKILL.md`) leak into
 * the assertion.
 */
const DISABLE_ALL_BUILTIN_SKILLS = {
	enableCodexUser: false,
	enableClaudeUser: false,
	enableClaudeProject: false,
	enablePiUser: false,
	enablePiProject: false,
	enableAgentsUser: false,
	enableAgentsProject: false,
} as const;

describe("skills", () => {
	describe("loadSkillsFromDir", () => {
		let fixtureRoot: LoadSkillsResult;

		beforeAll(async () => {
			fixtureRoot = await loadSkillsFromDir({ dir: fixturesDir, source: "test" });
		});

		const loadFixtureRoot = async () => fixtureRoot;
		it("should load a valid skill from a skills root", async () => {
			const { skills, warnings } = await loadFixtureRoot();
			const validSkill = skills.find(skill => skill.name === "valid-skill");

			expect(validSkill).toBeDefined();
			expect(validSkill?.description).toBe("A valid skill for testing purposes.");
			expect(validSkill?.source).toBe("test");
			expect(warnings).toHaveLength(0);
		});

		it("should load skill when name doesn't match parent directory", async () => {
			const { skills } = await loadFixtureRoot();

			expect(skills.some(skill => skill.name === "different-name")).toBe(true);
		});

		it("should load skill with invalid name characters", async () => {
			const { skills } = await loadFixtureRoot();

			expect(skills.some(skill => skill.name === "Invalid_Name")).toBe(true);
		});

		it("should load skill when name exceeds 64 characters", async () => {
			const { skills } = await loadFixtureRoot();

			expect(
				skills.some(
					skill =>
						skill.name ===
						"this-is-a-very-long-skill-name-that-exceeds-the-sixty-four-character-limit-set-by-the-standard",
				),
			).toBe(true);
		});

		it("should skip skill when description is missing", async () => {
			const { skills } = await loadFixtureRoot();

			expect(skills.some(skill => skill.name === "missing-description")).toBe(false);
		});

		it("should load skill with unknown frontmatter fields", async () => {
			const { skills } = await loadFixtureRoot();

			expect(skills.some(skill => skill.name === "unknown-field")).toBe(true);
		});

		it("should not load nested skills recursively", async () => {
			const { skills } = await loadFixtureRoot();

			expect(skills.some(skill => skill.name === "child-skill")).toBe(false);
		});

		it("should skip files without frontmatter description", async () => {
			const { skills } = await loadFixtureRoot();

			expect(skills.some(skill => skill.name === "no-frontmatter")).toBe(false);
		});

		it("should load skill with consecutive hyphens in name", async () => {
			const { skills } = await loadFixtureRoot();

			expect(skills.some(skill => skill.name === "bad--name")).toBe(true);
		});

		it("should load all directly nested skills from fixture directory", async () => {
			const { skills } = await loadFixtureRoot();
			const names = skills.map(skill => skill.name);

			expect(names).toEqual(
				expect.arrayContaining([
					"valid-skill",
					"different-name",
					"Invalid_Name",
					"this-is-a-very-long-skill-name-that-exceeds-the-sixty-four-character-limit-set-by-the-standard",
					"unknown-field",
					"bad--name",
				]),
			);
			expect(names).not.toContain("child-skill");
			expect(skills).toHaveLength(6);
		});

		it("should return skills sorted by name (case-insensitive)", async () => {
			const { skills } = await loadFixtureRoot();
			const names = skills.map(skill => skill.name);

			expect(names).toEqual(expectedFixtureSkillOrder);
		});

		it("should return empty for non-existent directory", async () => {
			const { skills, warnings } = await loadSkillsFromDir({
				dir: "/non/existent/path",
				source: "test",
			});
			expect(skills).toHaveLength(0);
			expect(warnings).toHaveLength(0);
		});

		it("should return empty when scanning a single skill directory directly", async () => {
			const { skills } = await loadSkillsFromDir({
				dir: path.join(fixturesDir, "valid-skill"),
				source: "test",
			});

			expect(skills).toHaveLength(0);
		});
	});

	describe("loadSkills with options", () => {
		let customDirectorySkills: LoadSkillsResult;

		beforeAll(async () => {
			customDirectorySkills = await loadSkills({
				...DISABLE_ALL_BUILTIN_SKILLS,
				customDirectories: [fixturesDir],
			});
		});
		it("should load from customDirectories only when built-ins disabled", async () => {
			const { skills } = customDirectorySkills;
			expect(skills.length).toBeGreaterThan(0);
			// Custom directory skills have source "custom:user"
			expect(skills.every(s => s.source.startsWith("custom"))).toBe(true);
		});

		it("should return customDirectory skills sorted by name (case-insensitive)", async () => {
			const { skills } = customDirectorySkills;

			expect(skills.map(s => s.name)).toEqual(expectedFixtureSkillOrder);
		});

		it("should keep user Claude skills when project .claude/skills is missing", async () => {
			const tempHomeDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-claude-home-"));
			const tempProjectDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-claude-project-"));

			try {
				const userSkillDir = path.join(tempHomeDir, ".claude", "skills", "user-only-skill");
				await fs.mkdir(userSkillDir, { recursive: true });
				await fs.writeFile(
					path.join(userSkillDir, "SKILL.md"),
					[
						"---",
						"name: user-only-skill",
						"description: User-only Claude skill",
						"---",
						"",
						"# User-only skill",
					].join("\n"),
				);

				const capability = getCapability<CapabilitySkill>(skillCapability.id);
				expect(capability).toBeDefined();
				const claudeProvider = capability?.providers.find(provider => provider.id === "claude");
				expect(claudeProvider).toBeDefined();

				const result = await claudeProvider!.load({ cwd: tempProjectDir, home: tempHomeDir, repoRoot: null });
				expect(result.items.some(skill => skill.name === "user-only-skill" && skill.level === "user")).toBe(true);
			} finally {
				await removeWithRetries(tempProjectDir);
				await removeWithRetries(tempHomeDir);
			}
		});

		// Regression for issue #2401: a user who disables the named third-party
		// CLI toggles (codex/claude/native) MUST still see skills from the
		// canonical OMP-native `~/.agent[s]/skills` (the `agents` provider).
		// Pre-fix `loadSkills` gated `agents` on `anyBuiltInSkillSourceEnabled`,
		// so flipping the five third-party toggles off silently disabled it.
		it("should still load ~/.agents/skills when codex/claude/native toggles are off (#2401)", async () => {
			const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "pi-agents-home-"));
			const tempCwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-agents-cwd-"));
			const skillDir = path.join(tempHome, ".agents", "skills", "user-agents-skill");
			await fs.mkdir(skillDir, { recursive: true });
			await fs.writeFile(
				path.join(skillDir, "SKILL.md"),
				["---", "description: Loaded from ~/.agents/skills", "---", "", "# user-agents-skill"].join("\n"),
			);
			const homedirSpy = spyOn(os, "homedir").mockReturnValue(tempHome);
			try {
				const { skills } = await loadSkills({
					enableCodexUser: false,
					enableClaudeUser: false,
					enableClaudeProject: false,
					enablePiUser: false,
					enablePiProject: false,
					// enableAgentsUser/enableAgentsProject left at their default-true value
					cwd: tempCwd,
				});
				expect(skills.some(s => s.name === "user-agents-skill" && s.source === "agents:user")).toBe(true);
			} finally {
				homedirSpy.mockRestore();
				await removeWithRetries(tempHome);
				await removeWithRetries(tempCwd);
			}
		});

		it("should load Windows host ~/.agents/skills when running under WSL (#3779)", async () => {
			const tempHostHome = await fs.mkdtemp(path.join(os.tmpdir(), "pi-agents-wsl-host-"));
			const tempCwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-agents-wsl-cwd-"));
			const skillDir = path.join(tempHostHome, ".agents", "skills", "wsl-host-skill");
			await fs.mkdir(skillDir, { recursive: true });
			await fs.writeFile(
				path.join(skillDir, "SKILL.md"),
				["---", "description: Loaded from WSL host USERPROFILE", "---", "", "# wsl-host-skill"].join("\n"),
			);
			const previousWslDistroName = process.env.WSL_DISTRO_NAME;
			const previousWslInterop = process.env.WSL_INTEROP;
			const previousUserProfile = process.env.USERPROFILE;
			const previousPlatform = process.platform;
			Object.defineProperty(process, "platform", { value: "linux" });
			process.env.WSL_DISTRO_NAME = "Ubuntu";
			delete process.env.WSL_INTEROP;
			process.env.USERPROFILE = tempHostHome;
			try {
				const { skills } = await loadSkills({
					enableCodexUser: false,
					enableClaudeUser: false,
					enableClaudeProject: false,
					enablePiUser: false,
					enablePiProject: false,
					cwd: tempCwd,
				});
				const skill = skills.find(s => s.name === "wsl-host-skill");
				expect(skill?.source).toBe("agents:user");
				expect(skill?.filePath).toBe(path.join(skillDir, "SKILL.md"));
			} finally {
				if (previousWslDistroName === undefined) delete process.env.WSL_DISTRO_NAME;
				else process.env.WSL_DISTRO_NAME = previousWslDistroName;
				if (previousWslInterop === undefined) delete process.env.WSL_INTEROP;
				else process.env.WSL_INTEROP = previousWslInterop;
				if (previousUserProfile === undefined) delete process.env.USERPROFILE;
				else process.env.USERPROFILE = previousUserProfile;
				Object.defineProperty(process, "platform", { value: previousPlatform });
				await removeWithRetries(tempHostHome);
				await removeWithRetries(tempCwd);
			}
		});

		it("converts Windows USERPROFILE paths to the default WSL mount (#3779)", () => {
			const resolved = getWslWindowsHomeCandidate({
				platform: "linux",
				env: { WSL_DISTRO_NAME: "Ubuntu", USERPROFILE: "C:\\Users\\alice" },
				wslPath: () => undefined,
			});

			expect(resolved).toBe("/mnt/c/Users/alice");
		});

		it("resolves the Windows profile through interop when USERPROFILE is not exported (#3779)", () => {
			const resolved = getWslWindowsHomeCandidate({
				platform: "linux",
				env: { WSL_DISTRO_NAME: "Ubuntu" },
				windowsUserProfile: () => "C:\\Users\\alice",
				wslPath: () => "/mnt/c/Users/alice",
			});

			expect(resolved).toBe("/mnt/c/Users/alice");
		});

		it("kills a host probe that never exits instead of blocking startup (#8402)", () => {
			// Integration test against real OS timer behavior: the contract is that
			// runHostProbe's spawnSync `timeout` actually kills a genuinely blocked
			// child. Injecting a short deadline preserves that native lifecycle
			// coverage without paying the production discovery budget.
			const start = performance.now();
			const result = runHostProbe([process.execPath, "-e", "await Bun.sleep(60_000)"], 25);
			const elapsed = performance.now() - start;
			expect(result).toBeUndefined();
			// Loose bound proves the probe returned via its timeout, not the child.
			expect(elapsed).toBeLessThan(1_000);
		});

		it("returns trimmed stdout for a host probe that succeeds (#8402)", () => {
			const result = runHostProbe([process.execPath, "-e", "process.stdout.write('  host-home  ')"]);
			expect(result).toBe("host-home");
		});

		it("respects an explicit enableAgentsUser: false (#2401)", async () => {
			const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "pi-agents-home-off-"));
			const tempCwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-agents-cwd-off-"));
			const skillDir = path.join(tempHome, ".agents", "skills", "opted-out");
			await fs.mkdir(skillDir, { recursive: true });
			await fs.writeFile(
				path.join(skillDir, "SKILL.md"),
				["---", "description: Should be filtered out", "---", "", "# opted-out"].join("\n"),
			);
			const homedirSpy = spyOn(os, "homedir").mockReturnValue(tempHome);
			try {
				const { skills } = await loadSkills({
					...DISABLE_ALL_BUILTIN_SKILLS,
					enableAgentsUser: false,
					cwd: tempCwd,
				});
				expect(skills.some(s => s.name === "opted-out")).toBe(false);
			} finally {
				homedirSpy.mockRestore();
				await removeWithRetries(tempHome);
				await removeWithRetries(tempCwd);
			}
		});

		// Regression for PR #2405 review: the fall-through gate used by
		// unknown third-party providers (opencode/github/claude-plugins/...)
		// MUST NOT consider the OMP-native `enableAgentsUser`/`...Project`
		// toggles. Otherwise a user who disables Codex/Claude/Pi to silence
		// third-party CLI noise but keeps the default agents toggles on still
		// sees opencode skills resurface via the fallback branch.
		it("does not re-enable third-party providers via the agents toggles (PR #2405)", async () => {
			const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "pi-opencode-home-"));
			const tempCwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-opencode-cwd-"));
			const opencodeSkillDir = path.join(tempHome, ".config", "opencode", "skills", "leaked-opencode");
			await fs.mkdir(opencodeSkillDir, { recursive: true });
			await fs.writeFile(
				path.join(opencodeSkillDir, "SKILL.md"),
				["---", "description: Should be filtered by third-party gate", "---", "", "# leaked-opencode"].join("\n"),
			);
			const homedirSpy = spyOn(os, "homedir").mockReturnValue(tempHome);
			try {
				const { skills } = await loadSkills({
					enableCodexUser: false,
					enableClaudeUser: false,
					enableClaudeProject: false,
					enablePiUser: false,
					enablePiProject: false,
					// enableAgentsUser / enableAgentsProject default true
					cwd: tempCwd,
				});
				expect(skills.some(s => s.name === "leaked-opencode")).toBe(false);
			} finally {
				homedirSpy.mockRestore();
				await removeWithRetries(tempHome);
				await removeWithRetries(tempCwd);
			}
		});

		it("should filter out ignoredSkills", async () => {
			const { skills } = await loadSkills({
				...DISABLE_ALL_BUILTIN_SKILLS,
				customDirectories: [fixturesDir],
				ignoredSkills: ["valid-skill"],
			});
			expect(skills.some(s => s.name === "valid-skill")).toBe(false);
		});

		it("should support glob patterns in ignoredSkills", async () => {
			const { skills } = await loadSkills({
				...DISABLE_ALL_BUILTIN_SKILLS,
				customDirectories: [fixturesDir],
				ignoredSkills: ["valid-*"],
			});
			expect(skills.every(s => !s.name.startsWith("valid-"))).toBe(true);
		});

		it("should skip skills disabled via frontmatter", async () => {
			const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-disabled-skill-"));
			const skillDir = path.join(tempDir, "disabled-skill");
			await fs.mkdir(skillDir, { recursive: true });
			await fs.writeFile(
				path.join(skillDir, "SKILL.md"),
				`---
name: disabled-skill
description: Should not be discovered.
enabled: false
---

# Disabled Skill
`,
			);

			try {
				const { skills } = await loadSkills({ ...DISABLE_ALL_BUILTIN_SKILLS, customDirectories: [tempDir] });
				expect(skills.some(s => s.name === "disabled-skill")).toBe(false);
			} finally {
				await removeWithRetries(tempDir);
			}
		});

		it("should hide skills with disable-model-invocation frontmatter (Agent Skills spec)", async () => {
			const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-dmi-skill-"));
			const skillDir = path.join(tempDir, "hidden-by-spec");
			await fs.mkdir(skillDir, { recursive: true });
			await fs.writeFile(
				path.join(skillDir, "SKILL.md"),
				`---\nname: hidden-by-spec\ndescription: Should be hidden via Agent Skills standard field.\ndisable-model-invocation: true\n---\n\n# Hidden Skill\n`,
			);

			try {
				const { skills } = await loadSkills({ ...DISABLE_ALL_BUILTIN_SKILLS, customDirectories: [tempDir] });
				const skill = skills.find(s => s.name === "hidden-by-spec");
				expect(skill).toBeDefined();
				expect(skill!.hide).toBe(true);
			} finally {
				await removeWithRetries(tempDir);
			}
		});

		it("should let ignoredSkills override includeSkills", async () => {
			const { skills } = await loadSkills({
				...DISABLE_ALL_BUILTIN_SKILLS,
				customDirectories: [fixturesDir],
				includeSkills: ["valid-*"],
				ignoredSkills: ["valid-skill"],
			});
			expect(skills.every(s => s.name !== "valid-skill")).toBe(true);
		});
	});

	it("should expand ~ in customDirectories", async () => {
		const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), "pi-skills-home-"));
		const homedirSpy = spyOn(os, "homedir").mockReturnValue(fakeHome);
		const tempHomeSkillsDir = await fs.mkdtemp(path.join(fakeHome, ".pi-skills-test-"));
		const relativeToHome = path.relative(fakeHome, tempHomeSkillsDir);
		const tildeDir = `~/${relativeToHome.split(path.sep).join("/")}`;
		const skillDir = path.join(tempHomeSkillsDir, "tilde-skill");
		const skillPath = path.join(skillDir, "SKILL.md");
		await fs.mkdir(skillDir, { recursive: true });
		await fs.writeFile(
			skillPath,
			`---
name: tilde-skill
description: Skill loaded from a tilde-expanded custom directory.
---

# Tilde Skill
`,
		);

		try {
			const { skills: withTilde } = await loadSkills({
				...DISABLE_ALL_BUILTIN_SKILLS,
				customDirectories: [tildeDir],
			});
			const { skills: withoutTilde } = await loadSkills({
				...DISABLE_ALL_BUILTIN_SKILLS,
				customDirectories: [tempHomeSkillsDir],
			});
			expect(withTilde.length).toBe(withoutTilde.length);
			expect(withTilde.some(skill => skill.name === "tilde-skill")).toBe(true);
		} finally {
			homedirSpy.mockRestore();
			await removeWithRetries(fakeHome);
		}
	});

	describe("bundled frontend skills", () => {
		const setupIsolatedFrontendSkillHome = async (prefix: string) => {
			const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
			const tempCwd = path.join(tempHome, "work");
			const originalAgentDir = getAgentDir();
			await fs.mkdir(tempCwd, { recursive: true });
			const homedirSpy = spyOn(os, "homedir").mockReturnValue(tempHome);
			setAgentDir(path.join(tempHome, ".omp", "agent"));

			return {
				tempHome,
				tempCwd,
				async cleanup() {
					homedirSpy.mockRestore();
					setAgentDir(originalAgentDir);
					await removeWithRetries(tempHome);
				},
			};
		};

		const expectOnlyBundledFrontendSkills = (skills: Skill[]) => {
			const frontendSkills = skills
				.filter(skill => skill.name.startsWith("frontend-"))
				.map(skill => [skill.name, skill.source] as const)
				.toSorted(([leftName], [rightName]) => leftName.localeCompare(rightName));

			expect(frontendSkills).toEqual([
				["frontend-accessibility", "bundled:native"],
				["frontend-design", "bundled:native"],
				["frontend-ui-copy", "bundled:native"],
			]);
		};

		const expectNoReviewerComments = (message: string) => {
			expect(message).not.toContain("[REVIEW");
			expect(message).not.toContain("# REVIEW");
		};

		it("loads archive engineering skills as bundled native skills with renderable guidance", async () => {
			const fixture = await setupIsolatedFrontendSkillHome("omp-bundled-engineering-skills-home-");

			try {
				const { skills, warnings } = await loadSkills({ cwd: fixture.tempCwd });
				const byName = new Map(skills.map(skill => [skill.name, skill]));
				const missingSkills = ARCHIVE_ENGINEERING_SKILL_NAMES.filter(name => !byName.has(name));
				const wrongSources = ARCHIVE_ENGINEERING_SKILL_NAMES.flatMap(name => {
					const skill = byName.get(name);
					return skill && skill.source !== "bundled:native" ? [`${name}: ${skill.source}`] : [];
				});
				const emptyDescriptions = ARCHIVE_ENGINEERING_SKILL_NAMES.filter(name => {
					const description = byName.get(name)?.description;
					return description !== undefined && description.trim() === "";
				});

				expect(warnings).toEqual([]);
				expect({ missingSkills, wrongSources, emptyDescriptions }).toEqual({
					missingSkills: [],
					wrongSources: [],
					emptyDescriptions: [],
				});

				for (const name of ARCHIVE_ENGINEERING_SKILL_NAMES) {
					const skill = byName.get(name);
					if (!skill) throw new Error(`Missing bundled skill ${name}`);

					const { message, details } = await buildSkillPromptMessage(skill, "", "autoload");
					expect(details.name).toBe(name);
					expect(message.trim()).not.toBe("");
					expectNoReviewerComments(message);
					// HTML comments always open with `<!--`; a bare `-->` is legitimate content (mermaid arrows).
					expect(message).not.toContain("<!--");
				}
			} finally {
				await fixture.cleanup();
			}
		});

		it("discovers exactly the three bundled frontend skills without filesystem skill directories", async () => {
			const fixture = await setupIsolatedFrontendSkillHome("omp-bundled-frontend-skills-home-");

			try {
				const { skills, warnings } = await loadSkills({ cwd: fixture.tempCwd });

				expect(warnings).toEqual([]);
				expectOnlyBundledFrontendSkills(skills);
			} finally {
				await fixture.cleanup();
			}
		});

		it("keeps exactly the three bundled frontend skills when third-party sources are disabled but native agents are enabled", async () => {
			const fixture = await setupIsolatedFrontendSkillHome("omp-bundled-native-skills-home-");

			try {
				const { skills, warnings } = await loadSkills({
					enableCodexUser: false,
					enableClaudeUser: false,
					enableClaudeProject: false,
					enablePiUser: false,
					enablePiProject: false,
					cwd: fixture.tempCwd,
				});

				expect(warnings).toEqual([]);
				expectOnlyBundledFrontendSkills(skills);
			} finally {
				await fixture.cleanup();
			}
		});

		it("restores bundled frontend-design when a higher-priority native duplicate is disabled", async () => {
			const fixture = await setupIsolatedFrontendSkillHome("omp-bundled-shadowed-skills-home-");
			const nativeSkillDir = path.join(fixture.tempHome, ".omp", "agent", "skills", "frontend-design");
			await fs.mkdir(nativeSkillDir, { recursive: true });
			await fs.writeFile(
				path.join(nativeSkillDir, "SKILL.md"),
				["---", "description: Disabled native duplicate", "---", "", "# frontend-design"].join("\n"),
			);

			try {
				const { skills } = await loadSkills({
					enableCodexUser: false,
					enableClaudeUser: false,
					enableClaudeProject: false,
					enablePiUser: false,
					enablePiProject: false,
					cwd: fixture.tempCwd,
				});
				const frontendDesign = skills.find(skill => skill.name === "frontend-design");

				expect(frontendDesign).toBeDefined();
				expect(frontendDesign?.source).toBe("bundled:native");
				expect(frontendDesign?.description).toContain("Foundation for all production frontend/UI/UX work");
			} finally {
				await fixture.cleanup();
			}
		});

		it("autoloads frontend-design guidance for production UI work", async () => {
			const fixture = await setupIsolatedFrontendSkillHome("omp-bundled-design-skill-home-");

			try {
				const { skills } = await loadSkills({ cwd: fixture.tempCwd });
				const frontendDesign = skills.find(skill => skill.name === "frontend-design");
				expect(frontendDesign).toBeDefined();

				const { message, details } = await buildSkillPromptMessage(frontendDesign!, "", "autoload");
				const guidance = message.toLowerCase();

				expect(details.name).toBe("frontend-design");
				expect(guidance).toContain("design-system");
				expect(guidance).toContain("mockup");
				expect(guidance).toContain("responsive");
				expect(guidance).toContain("motion");
				expect(guidance).toMatch(/definition[- ]of[- ]done/);
				expectNoReviewerComments(message);
			} finally {
				await fixture.cleanup();
			}
		});

		it("autoloads frontend-accessibility guidance for concrete regression checks", async () => {
			const fixture = await setupIsolatedFrontendSkillHome("omp-bundled-accessibility-skill-home-");

			try {
				const { skills } = await loadSkills({ cwd: fixture.tempCwd });
				const accessibility = skills.find(skill => skill.name === "frontend-accessibility");
				expect(accessibility).toBeDefined();

				const { message, details } = await buildSkillPromptMessage(accessibility!, "", "autoload");
				const guidance = message.toLowerCase();

				expect(details.name).toBe("frontend-accessibility");
				expect(guidance).toContain("keyboard");
				expect(guidance).toContain("focus");
				expect(guidance).toContain("form");
				expect(guidance).toContain("contrast");
				expect(guidance).toMatch(/live[- ]region/);
				expect(guidance).toMatch(/red[- ]flag/);
				expectNoReviewerComments(message);
			} finally {
				await fixture.cleanup();
			}
		});

		it("autoloads frontend-ui-copy guidance that prevents internal-note leakage", async () => {
			const fixture = await setupIsolatedFrontendSkillHome("omp-bundled-ui-copy-skill-home-");

			try {
				const { skills } = await loadSkills({ cwd: fixture.tempCwd });
				const uiCopySkill = skills.find(skill => skill.name === "frontend-ui-copy");
				expect(uiCopySkill).toBeDefined();

				const { message, details } = await buildSkillPromptMessage(uiCopySkill!, "", "autoload");
				const guidance = message.toLowerCase();

				expect(details.name).toBe("frontend-ui-copy");
				expect(guidance).toContain("internal note");
				expect(guidance).toContain("hard rule");
				expect(guidance).toContain("i18n");
				expect(guidance).toContain("grep");
				expect(guidance).toContain("did not");
				expectNoReviewerComments(message);
			} finally {
				await fixture.cleanup();
			}
		});

		it("loads bundled verify-before-done native skill with autoload verification contract", async () => {
			const fixture = await setupIsolatedFrontendSkillHome("omp-bundled-verify-before-done-skill-home-");

			try {
				const { skills } = await loadSkills({ cwd: fixture.tempCwd });
				const verifySkill = skills.find(skill => skill.name === "verify-before-done");
				if (!verifySkill) throw new Error("verify-before-done bundled skill did not load");

				expect(verifySkill.source).toBe("bundled:native");

				const { message, details } = await buildSkillPromptMessage(verifySkill, "", "autoload");
				const runtimeVerificationContracts: Array<[contract: string, pattern: RegExp]> = [
					["real runtime entry point", /real entry point/i],
					[
						"built binary or distributable artifact",
						/built (?:artifact|binary|distributable)|distributable artifact/i,
					],
					[
						"outside repository or source-path install",
						/(?:outside|not from|away from)[\s\S]{0,120}(?:repo|repository|source path)|(?:clean temp|temporary)[\s\S]{0,120}(?:install|unpack)/i,
					],
					[
						"interactive TUI runtime exercise",
						/interactive[\s\S]{0,120}(?:TUI|terminal UI)|(?:TUI|terminal UI)[\s\S]{0,120}interactive/i,
					],
					["long-running TUI supervision", /tmux|nohup|equivalent/i],
					[
						"tests and smoke alone are insufficient",
						/(?:smoke tests?|tests?\/typecheck|typecheck)[\s\S]{0,160}(?:not enough|insufficient)|(?:not enough|insufficient)[\s\S]{0,160}(?:smoke tests?|tests?\/typecheck|typecheck)/i,
					],
					["failure path is exercised", /failure path|failing path|negative path|error path/i],
					[
						"cleanup removes VERIFY-TEMP while harness handoff is allowed",
						/(?:always )?remove VERIFY-TEMP[\s\S]{0,200}(?:prove|markers remain|before completion)|leave[\s\S]{0,160}(?:harness|dev (?:server|harness))[\s\S]{0,120}manual testing[\s\S]{0,120}cleanup command/i,
					],
					[
						"existing dev server or harness reuse",
						/reuse an existing (?:dev server|compose|preview)|reuse[\s\S]{0,80}existing (?:dev server|session|compose)/i,
					],
					[
						"hot reload or live reload freshness proof",
						/hot\/live[- ]reload|without proven hot\/live reload|hot\/live-reload proof/i,
					],
					[
						"avoid duplicate harness or server startup",
						/do not start a duplicate (?:server|harness)|duplicate harnesses behind/i,
					],
					[
						"restart or boot when stale or wrong env/store",
						/when fresh and on the correct env\/store|restart before re-testing|otherwise boot/i,
					],
					["manual testing handoff", /manual testing|manual script|close with:/i],
					[
						"VERIFY-TEMP cleanup is required",
						/VERIFY-TEMP[\s\S]{0,120}(?:remove|cleanup|searching for VERIFY-TEMP)|prove no VERIFY-TEMP markers remain/i,
					],
					["runtime side effects or state are checked", /side effects?|state/i],
				];

				const missingContracts = runtimeVerificationContracts
					.filter(([, pattern]) => !pattern.test(message))
					.map(([contract]) => contract);

				expect(details.name).toBe("verify-before-done");
				expect(missingContracts).toEqual([]);
				expect(message).toMatch(/SELF-RESCUE/);
				expect(message).toMatch(/VERIFY-TEMP/);
				expect(message).toMatch(/browser/i);
				expect(message).toMatch(/mobile/i);
				expect(message).toMatch(/desktop/i);
				expect(message).toMatch(/installed artifact/i);
				expect(message).toMatch(/microservices/i);
				expect(message).toMatch(/Evidence block/i);
				expectNoReviewerComments(message);
			} finally {
				await fixture.cleanup();
			}
		});

		it("loads preview-templates with canvas schema and five artifact recipes", async () => {
			const fixture = await setupIsolatedFrontendSkillHome("omp-bundled-preview-templates-home-");

			try {
				const { skills } = await loadSkills({ cwd: fixture.tempCwd });
				const skill = skills.find(entry => entry.name === "preview-templates");
				if (!skill) throw new Error("preview-templates bundled skill did not load");

				expect(skill.source).toBe("bundled:native");
				expect(skill.description).toMatch(/canvas\.json|canvas/i);

				const { message, details } = await buildSkillPromptMessage(skill, "", "autoload");
				const contracts: Array<[string, RegExp]> = [
					["version-1 root", /version:\s*1/i],
					["canvas path", /docs\/product\/canvases\/.*\.canvas\.json/i],
					["story-map recipe", /artifactType[\s\S]{0,40}story-map|story-map/i],
					["journey-map recipe", /journey-map/],
					["plan recipe", /artifactType[\s\S]{0,80}plan|"plan"/],
					["spec recipe", /artifactType[\s\S]{0,80}spec|\bspec\b/],
					["architecture recipe", /architecture/],
					["all-or-none positions", /all-or-none/i],
					["safe relative refs", /no scheme|relative[\s\S]{0,40}path|no `?\.\.`?/i],
					["no HTML/styles/URLs/React props", /NEVER[\s\S]{0,120}(HTML|style|URL|React Flow)/i],
					["review-only canvas", /review-only/i],
					["HTML remains mockup-only", /kind=mockup|custom UI|HTML mockups/i],
					["node type enum", /card[\s\S]{0,40}lane[\s\S]{0,40}group|milestone[\s\S]{0,40}decision/i],
					["edge type enum", /sequence[\s\S]{0,40}dependency[\s\S]{0,40}association/i],
				];
				const missing = contracts.filter(([, pattern]) => !pattern.test(message)).map(([name]) => name);

				expect(details.name).toBe("preview-templates");
				expect(missing).toEqual([]);
				expectNoReviewerComments(message);
			} finally {
				await fixture.cleanup();
			}
		});

		it("keeps product skills optional about canvas companions for spatial review", async () => {
			const fixture = await setupIsolatedFrontendSkillHome("omp-bundled-product-canvas-home-");

			try {
				const { skills } = await loadSkills({ cwd: fixture.tempCwd });
				const names = ["product-spec", "product-design", "product-architecture"] as const;

				for (const name of names) {
					const skill = skills.find(entry => entry.name === name);
					if (!skill) throw new Error(`${name} bundled skill did not load`);

					const { message, details } = await buildSkillPromptMessage(skill, "", "autoload");
					expect(details.name).toBe(name);
					expect(message).toMatch(/canvas companion|Canvas companion/i);
					expect(message).toMatch(/docs\/product\/canvases\/.*\.canvas\.json/i);
					expect(message).toMatch(/SKIP|optional|NEVER[\s\S]{0,80}mandatory|NEVER invent a mandatory/i);
					expect(message).toMatch(/preview-templates|presenter/i);
					expectNoReviewerComments(message);
				}
			} finally {
				await fixture.cleanup();
			}
		});

		it("validates the preview-templates story-map recipe through the real canvas parser", async () => {
			const fixture = await setupIsolatedFrontendSkillHome("omp-bundled-story-map-recipe-home-");

			try {
				const { skills } = await loadSkills({ cwd: fixture.tempCwd });
				const skill = skills.find(entry => entry.name === "preview-templates");
				if (!skill) throw new Error("preview-templates bundled skill did not load");

				const { message } = await buildSkillPromptMessage(skill, "", "autoload");
				expect(message).toContain('"artifactType": "story-map"');

				// Recipe the presenter is taught — must parse under the live schema.
				const storyMap = {
					version: 1 as const,
					title: "Checkout — story map",
					artifactType: "story-map" as const,
					description: "Activities across the top; stories beneath.",
					nodes: [
						{ id: "act-browse", type: "step" as const, title: "Browse", role: "primary" as const },
						{ id: "act-pay", type: "step" as const, title: "Pay", role: "primary" as const },
						{
							id: "s-search",
							type: "card" as const,
							parentId: "act-browse",
							title: "Search catalog",
							status: "ready" as const,
							refs: [
								{
									label: "Spec S1",
									path: "docs/product/specs/2026-07-13-checkout.md",
									anchor: "s1",
								},
							],
						},
						{
							id: "s-checkout",
							type: "card" as const,
							parentId: "act-pay",
							title: "One-click pay",
							status: "draft" as const,
							role: "risk" as const,
						},
					],
					edges: [{ id: "e1", source: "act-browse", target: "act-pay", type: "sequence" as const }],
				};

				const parsed = parseCanvasDocument(JSON.stringify(storyMap));
				expect(parsed.ok).toBe(true);
				if (!parsed.ok) throw new Error(parsed.error.message);
				expect(parsed.layout).toBe("deterministic");
				expect(parsed.canvas.artifactType).toBe("story-map");
				expect(parsed.canvas.nodes).toHaveLength(4);
				expect(parsed.canvas.edges).toHaveLength(1);
				expect(parsed.canvas.nodes[2]?.refs?.[0]?.path).toBe("docs/product/specs/2026-07-13-checkout.md");

				const unsafe = parseCanvasDocument(
					JSON.stringify({
						...storyMap,
						nodes: [
							...storyMap.nodes,
							{
								id: "bad-ref",
								type: "card",
								title: "Bad",
								refs: [{ label: "x", path: "../etc/passwd" }],
							},
						],
					}),
				);
				expect(unsafe.ok).toBe(false);
				if (unsafe.ok) throw new Error("expected invalid ref path");
				expect(unsafe.error.code).toBe("invalid_canvas");
			} finally {
				await fixture.cleanup();
			}
		});
	});

	it("should return empty when all sources disabled and no custom dirs", async () => {
		const { skills } = await loadSkills({ ...DISABLE_ALL_BUILTIN_SKILLS });
		expect(skills).toHaveLength(0);
	});

	it("should filter skills with includeSkills glob patterns", async () => {
		// Load all skills from fixtures
		const { skills: allSkills } = await loadSkills({
			...DISABLE_ALL_BUILTIN_SKILLS,
			customDirectories: [fixturesDir],
		});
		expect(allSkills.length).toBeGreaterThan(0);

		// Filter to only include "valid-skill"
		const { skills: filtered } = await loadSkills({
			...DISABLE_ALL_BUILTIN_SKILLS,
			customDirectories: [fixturesDir],
			includeSkills: ["valid-skill"],
		});
		expect(filtered).toHaveLength(1);
		expect(filtered[0].name).toBe("valid-skill");
	});

	it("should support glob patterns in includeSkills", async () => {
		const { skills } = await loadSkills({
			...DISABLE_ALL_BUILTIN_SKILLS,
			customDirectories: [fixturesDir],
			includeSkills: ["valid-*"],
		});
		expect(skills.length).toBeGreaterThan(0);
		expect(skills.every(s => s.name.startsWith("valid-"))).toBe(true);
	});

	it("should return all skills when includeSkills is empty", async () => {
		const { skills: withEmpty } = await loadSkills({
			...DISABLE_ALL_BUILTIN_SKILLS,
			customDirectories: [fixturesDir],
			includeSkills: [],
		});
		const { skills: withoutOption } = await loadSkills({
			...DISABLE_ALL_BUILTIN_SKILLS,
			customDirectories: [fixturesDir],
		});
		expect(withEmpty.length).toBe(withoutOption.length);
	});
});

describe("collision handling", () => {
	it("should detect name collisions and keep first skill", async () => {
		// Load from first directory
		const first = await loadSkillsFromDir({
			dir: path.join(collisionFixturesDir, "first"),
			source: "first",
		});

		const second = await loadSkillsFromDir({
			dir: path.join(collisionFixturesDir, "second"),
			source: "second",
		});

		// Both directories should have loaded one skill each
		expect(first.skills).toHaveLength(1);
		expect(second.skills).toHaveLength(1);

		// Both have the same name "calendar"
		expect(first.skills[0].name).toBe("calendar");
		expect(second.skills[0].name).toBe("calendar");

		// Simulate the collision behavior from loadSkills()
		const skillMap = new Map<string, Skill>();
		const collisionWarnings: Array<{ skillPath: string; message: string }> = [];

		for (const skill of first.skills) {
			skillMap.set(skill.name, skill);
		}

		for (const skill of second.skills) {
			const existing = skillMap.get(skill.name);
			if (existing) {
				collisionWarnings.push({
					skillPath: skill.filePath,
					message: `name collision: "${skill.name}" already loaded from ${existing.filePath}`,
				});
			} else {
				skillMap.set(skill.name, skill);
			}
		}

		expect(skillMap.size).toBe(1);
		expect(skillMap.get("calendar")?.source).toBe("first");
		expect(collisionWarnings).toHaveLength(1);
		expect(collisionWarnings[0].message).toContain("name collision");
	});
});

describe("parseSkillInvocation", () => {
	describe("leading `/skill:<name>` form", () => {
		it("parses a bare leading command", () => {
			expect(parseSkillInvocation("/skill:foo")).toEqual({ name: "foo", args: "" });
		});

		it("captures everything after the first space as args", () => {
			expect(parseSkillInvocation("/skill:foo focus on auth")).toEqual({
				name: "foo",
				args: "focus on auth",
			});
		});

		it("allows leading whitespace before the `/skill:<name>` command", () => {
			expect(parseSkillInvocation("  /skill:foo focus on auth")).toEqual({
				name: "foo",
				args: "focus on auth",
			});
		});

		it("returns undefined for the bare `/skill:` prefix", () => {
			expect(parseSkillInvocation("/skill:")).toBeUndefined();
		});
	});

	describe("mid-prompt `/skill:<name>` form (issue #3913)", () => {
		it("threads surrounding prose through as args when the skill token appears after typed text", () => {
			expect(parseSkillInvocation("fix the auth bug /skill:security-scan ")).toEqual({
				name: "security-scan",
				args: "fix the auth bug",
			});
		});

		it("collapses prose on both sides of the skill token into a single args string", () => {
			expect(parseSkillInvocation("leading /skill:foo trailing")).toEqual({
				name: "foo",
				args: "leading trailing",
			});
		});

		it("preserves embedded newlines in args when the skill token spans a line break", () => {
			expect(parseSkillInvocation("explain this\nthen use /skill:security-scan ")).toEqual({
				name: "security-scan",
				args: "explain this\nthen use",
			});
		});

		it("does not hijack another slash command whose args mention a skill", () => {
			expect(parseSkillInvocation("/compact /skill:security-scan")).toBeUndefined();
			expect(parseSkillInvocation("/goal set /skill:foo focus on auth")).toBeUndefined();
		});

		it("does not hijack the bash tool (`!cmd`) when the body mentions a skill", () => {
			expect(parseSkillInvocation("!echo /skill:reviewer")).toBeUndefined();
			expect(parseSkillInvocation("!!echo /skill:reviewer")).toBeUndefined();
			expect(parseSkillInvocation("   !echo /skill:reviewer")).toBeUndefined();
		});

		it("does not hijack the python tool (`$ code`) when the body mentions a skill", () => {
			expect(parseSkillInvocation("$ run.py /skill:foo")).toBeUndefined();
			expect(parseSkillInvocation("$$ run.py /skill:foo")).toBeUndefined();
			expect(parseSkillInvocation("$\trun /skill:foo")).toBeUndefined();
		});

		it("still matches when `$` is followed by prose, not a python whitespace sigil", () => {
			// `$echo`, `${HOME}`, and `$200` are not python commands — `pythonCommandPrefixLength`
			// returns 0 for them — so the mid-prompt parser must still see the embedded skill.
			expect(parseSkillInvocation("$echo /skill:reviewer")).toEqual({
				name: "reviewer",
				args: "$echo",
			});
			// biome-ignore lint/suspicious/noTemplateCurlyInString: testing literal string containing shell variable
			expect(parseSkillInvocation("${HOME}/bin /skill:foo")).toEqual({
				name: "foo",
				// biome-ignore lint/suspicious/noTemplateCurlyInString: testing literal string containing shell variable
				args: "${HOME}/bin",
			});
		});

		it("returns undefined when no `/skill:<name>` token is present", () => {
			expect(parseSkillInvocation("no skill token here")).toBeUndefined();
		});

		it("does not match when the slash is glued to a preceding non-whitespace character", () => {
			expect(parseSkillInvocation("https://example.com/skill:foo")).toBeUndefined();
		});

		it("excludes embedded slashes from the mid-prompt skill name", () => {
			// `/skill:foo/bar` mid-prompt is ambiguous with a path — the mid-prompt
			// regex requires `[^\s/]+`, so this falls through with no match.
			expect(parseSkillInvocation("see /skill:foo/bar")).toBeUndefined();
		});
	});
});
