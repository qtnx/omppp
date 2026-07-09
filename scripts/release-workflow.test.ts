import { describe, expect, it } from "bun:test";
import { YAML } from "bun";

const workflow = await Bun.file(".github/workflows/ci.yml").text();
const parsed = YAML.parse(workflow);

function asRecord(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${label} is not a mapping`);
	}
	return value as Record<string, unknown>;
}

function asArray(value: unknown, label: string): unknown[] {
	if (!Array.isArray(value)) throw new Error(`${label} is not a sequence`);
	return value;
}

function asString(value: unknown, label: string): string {
	if (typeof value !== "string") throw new Error(`${label} is not a string`);
	return value;
}

const root = asRecord(parsed, "workflow");
const workflowOn = asRecord(root.on, "on");
const jobs = asRecord(root.jobs, "jobs");

describe("release workflow triggers", () => {
	it("runs release jobs from version tag pushes only", () => {
		const push = asRecord(workflowOn.push, "on.push");
		expect(asArray(push.tags, "on.push.tags")).toEqual(["v*"]);

		const releaseMetadata = asRecord(jobs.release_metadata, "jobs.release_metadata");
		const releaseMetadataSteps = asArray(releaseMetadata.steps, "jobs.release_metadata.steps").map((step, index) =>
			asRecord(step, `jobs.release_metadata.steps[${index}]`),
		);
		const detectStep = releaseMetadataSteps.find(step => step.name === "Detect release tag");
		expect(detectStep).toBeDefined();
		const run = asString(detectStep?.run, "Detect release tag run script");

		expect(run).toContain("refs/tags/v*)");
		expect(run).toContain("^v[0-9]+\\.[0-9]+\\.[0-9]+$");
		expect(run).not.toContain("refs/heads/main");
		expect(run).not.toContain("git tag --points-at HEAD");
	});

	it("publishes the public GitHub release only after npm publish succeeds", () => {
		const releaseNpm = asRecord(jobs.release_npm, "jobs.release_npm");
		expect(asString(releaseNpm.if, "release_npm if")).toContain(
			"needs['release-native-leaf-npm'].result == 'success'",
		);

		const nativeLeafNpm = asRecord(jobs["release-native-leaf-npm"], "jobs.release-native-leaf-npm");
		expect(asArray(nativeLeafNpm.needs, "release-native-leaf-npm needs")).toContain("release_github_verify");
		expect(asString(nativeLeafNpm.if, "release-native-leaf-npm if")).toContain(
			"needs.release_github_verify.result == 'success'",
		);

		const releaseGithub = asRecord(jobs.release_github, "jobs.release_github");
		const releaseGithubSteps = asArray(releaseGithub.steps, "release_github steps").map((step, index) =>
			asRecord(step, `release-github.steps[${index}]`),
		);
		const createReleaseStep = releaseGithubSteps.find(
			step => typeof step.uses === "string" && step.uses.startsWith("softprops/action-gh-release@"),
		);
		expect(createReleaseStep).toBeDefined();
		const createReleaseWith = asRecord(createReleaseStep?.with, "Create GitHub Release with");
		expect(createReleaseWith.draft).toBe(true);

		const publish = asRecord(jobs["release-github-publish"], "jobs.release-github-publish");
		const publishNeeds = asArray(publish.needs, "release-github-publish needs");
		expect(publishNeeds).toContain("release_npm");
		const publishCondition = asString(publish.if, "release-github-publish if");
		expect(publishCondition).toContain("needs.release_npm.result == 'success'");
		expect(publishCondition).not.toContain("inputs.skip_npm");
	});
});
