/**
 * Bundled native skills embedded in the coding agent package.
 */

import { parseFrontmatter } from "@oh-my-pi/pi-utils";
import { registerProvider } from "../capability";
import { type Skill, type SkillFrontmatter, skillCapability } from "../capability/skill";
import type { LoadResult, SourceMeta } from "../capability/types";
import apiDesign from "./bundled-skills/api-design.md" with { type: "text" };
import bugHunting from "./bundled-skills/bug-hunting.md" with { type: "text" };
import codeReviewLens from "./bundled-skills/code-review-lens.md" with { type: "text" };
import codebaseRecon from "./bundled-skills/codebase-recon.md" with { type: "text" };
import competitiveRecon from "./bundled-skills/competitive-recon.md" with { type: "text" };
import concurrencyCorrectness from "./bundled-skills/concurrency-correctness.md" with { type: "text" };
import databaseCraft from "./bundled-skills/database-craft.md" with { type: "text" };
import dependencyDoctor from "./bundled-skills/dependency-doctor.md" with { type: "text" };
import featureAnatomy from "./bundled-skills/feature-anatomy.md" with { type: "text" };
import frontendAccessibility from "./bundled-skills/frontend-accessibility.md" with { type: "text" };
import frontendDesign from "./bundled-skills/frontend-design.md" with { type: "text" };
import frontendUiCopy from "./bundled-skills/frontend-ui-copy.md" with { type: "text" };
import gitCraft from "./bundled-skills/git-craft.md" with { type: "text" };
import incidentResponse from "./bundled-skills/incident-response.md" with { type: "text" };
import migrationUpgrade from "./bundled-skills/migration-upgrade.md" with { type: "text" };
import observabilityInstrumentation from "./bundled-skills/observability-instrumentation.md" with { type: "text" };
import parallelFanout from "./bundled-skills/parallel-fanout.md" with { type: "text" };
import previewTemplates from "./bundled-skills/preview-templates.md" with { type: "text" };
import productArchitecture from "./bundled-skills/product-architecture.md" with { type: "text" };
import productDesign from "./bundled-skills/product-design.md" with { type: "text" };
import productDiscovery from "./bundled-skills/product-discovery.md" with { type: "text" };
import productIdeation from "./bundled-skills/product-ideation.md" with { type: "text" };
import productSpec from "./bundled-skills/product-spec.md" with { type: "text" };
import refactoringSafely from "./bundled-skills/refactoring-safely.md" with { type: "text" };
import repoRunbook from "./bundled-skills/repo-runbook.md" with { type: "text" };
import securityReview from "./bundled-skills/security-review.md" with { type: "text" };
import subagentsDevelopment from "./bundled-skills/subagents-development.md" with { type: "text" };
import verifyBeforeDone from "./bundled-skills/verify-before-done.md" with { type: "text" };
import workPlaybooks from "./bundled-skills/work-playbooks.md" with { type: "text" };
import writingTestsThatMatter from "./bundled-skills/writing-tests-that-matter.md" with { type: "text" };

const PROVIDER_ID = "bundled";
const DISPLAY_NAME = "Bundled Skills";
const PRIORITY = 90;
const LEVEL = "native" as const;

interface BundledSkillSource {
	name: string;
	content: string;
	filePath: string;
}

const BUNDLED_SKILL_SOURCES: readonly BundledSkillSource[] = [
	{
		name: "api-design",
		content: apiDesign,
		filePath: `${import.meta.dir}/bundled-skills/api-design.md`,
	},
	{
		name: "bug-hunting",
		content: bugHunting,
		filePath: `${import.meta.dir}/bundled-skills/bug-hunting.md`,
	},
	{
		name: "code-review-lens",
		content: codeReviewLens,
		filePath: `${import.meta.dir}/bundled-skills/code-review-lens.md`,
	},
	{
		name: "codebase-recon",
		content: codebaseRecon,
		filePath: `${import.meta.dir}/bundled-skills/codebase-recon.md`,
	},
	{
		name: "competitive-recon",
		content: competitiveRecon,
		filePath: `${import.meta.dir}/bundled-skills/competitive-recon.md`,
	},
	{
		name: "concurrency-correctness",
		content: concurrencyCorrectness,
		filePath: `${import.meta.dir}/bundled-skills/concurrency-correctness.md`,
	},
	{
		name: "database-craft",
		content: databaseCraft,
		filePath: `${import.meta.dir}/bundled-skills/database-craft.md`,
	},
	{
		name: "dependency-doctor",
		content: dependencyDoctor,
		filePath: `${import.meta.dir}/bundled-skills/dependency-doctor.md`,
	},
	{
		name: "feature-anatomy",
		content: featureAnatomy,
		filePath: `${import.meta.dir}/bundled-skills/feature-anatomy.md`,
	},
	{
		name: "frontend-accessibility",
		content: frontendAccessibility,
		filePath: `${import.meta.dir}/bundled-skills/frontend-accessibility.md`,
	},
	{
		name: "frontend-design",
		content: frontendDesign,
		filePath: `${import.meta.dir}/bundled-skills/frontend-design.md`,
	},
	{
		name: "frontend-ui-copy",
		content: frontendUiCopy,
		filePath: `${import.meta.dir}/bundled-skills/frontend-ui-copy.md`,
	},
	{
		name: "git-craft",
		content: gitCraft,
		filePath: `${import.meta.dir}/bundled-skills/git-craft.md`,
	},
	{
		name: "incident-response",
		content: incidentResponse,
		filePath: `${import.meta.dir}/bundled-skills/incident-response.md`,
	},
	{
		name: "migration-upgrade",
		content: migrationUpgrade,
		filePath: `${import.meta.dir}/bundled-skills/migration-upgrade.md`,
	},
	{
		name: "observability-instrumentation",
		content: observabilityInstrumentation,
		filePath: `${import.meta.dir}/bundled-skills/observability-instrumentation.md`,
	},
	{
		name: "parallel-fanout",
		content: parallelFanout,
		filePath: `${import.meta.dir}/bundled-skills/parallel-fanout.md`,
	},
	{
		name: "preview-templates",
		content: previewTemplates,
		filePath: `${import.meta.dir}/bundled-skills/preview-templates.md`,
	},
	{
		name: "product-architecture",
		content: productArchitecture,
		filePath: `${import.meta.dir}/bundled-skills/product-architecture.md`,
	},
	{
		name: "product-design",
		content: productDesign,
		filePath: `${import.meta.dir}/bundled-skills/product-design.md`,
	},
	{
		name: "product-discovery",
		content: productDiscovery,
		filePath: `${import.meta.dir}/bundled-skills/product-discovery.md`,
	},
	{
		name: "product-ideation",
		content: productIdeation,
		filePath: `${import.meta.dir}/bundled-skills/product-ideation.md`,
	},
	{
		name: "product-spec",
		content: productSpec,
		filePath: `${import.meta.dir}/bundled-skills/product-spec.md`,
	},
	{
		name: "refactoring-safely",
		content: refactoringSafely,
		filePath: `${import.meta.dir}/bundled-skills/refactoring-safely.md`,
	},
	{
		name: "repo-runbook",
		content: repoRunbook,
		filePath: `${import.meta.dir}/bundled-skills/repo-runbook.md`,
	},
	{
		name: "security-review",
		content: securityReview,
		filePath: `${import.meta.dir}/bundled-skills/security-review.md`,
	},
	{
		name: "subagents-development",
		content: subagentsDevelopment,
		filePath: `${import.meta.dir}/bundled-skills/subagents-development.md`,
	},
	{
		name: "verify-before-done",
		content: verifyBeforeDone,
		filePath: `${import.meta.dir}/bundled-skills/verify-before-done.md`,
	},
	{
		name: "work-playbooks",
		content: workPlaybooks,
		filePath: `${import.meta.dir}/bundled-skills/work-playbooks.md`,
	},
	{
		name: "writing-tests-that-matter",
		content: writingTestsThatMatter,
		filePath: `${import.meta.dir}/bundled-skills/writing-tests-that-matter.md`,
	},
];

function buildSourceMeta(filePath: string): SourceMeta {
	return {
		provider: PROVIDER_ID,
		providerName: DISPLAY_NAME,
		path: filePath,
		level: LEVEL,
	};
}

function buildBundledSkill(source: BundledSkillSource): Skill {
	const { frontmatter, body } = parseFrontmatter(source.content, { source: source.filePath });
	const frontmatterName = typeof frontmatter.name === "string" ? frontmatter.name.trim() : "";
	return {
		name: frontmatterName || source.name,
		path: source.filePath,
		content: body,
		frontmatter: frontmatter as SkillFrontmatter,
		level: LEVEL,
		_source: buildSourceMeta(source.filePath),
	};
}

async function loadSkills(): Promise<LoadResult<Skill>> {
	return { items: BUNDLED_SKILL_SOURCES.map(buildBundledSkill), warnings: [] };
}

registerProvider<Skill>(skillCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Bundled engineering, frontend, verification, and workflow skills",
	priority: PRIORITY,
	load: loadSkills,
});
