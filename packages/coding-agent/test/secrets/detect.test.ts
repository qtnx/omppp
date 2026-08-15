import { describe, expect, it } from "bun:test";
import { detectSecretsInText, kindToName } from "../../src/secrets/detect";

const githubToken = `ghp_${"a".repeat(36)}`;
const anthropicKey = `sk-ant-${"a".repeat(20)}`;
const openAiKey = `sk-${"a".repeat(20)}`;
const awsKey = `AKIA${"A".repeat(16)}`;
const slackToken = `xoxb-${"a".repeat(10)}`;
const gitlabToken = `glpat-${"a".repeat(20)}`;
const npmToken = `npm_${"a".repeat(36)}`;
const stripeKey = `sk_live_${"a".repeat(20)}`;
const jwt = `eyJ${"a".repeat(10)}.eyJ${"b".repeat(10)}.${"c".repeat(10)}`;
const hexKey = `0x${"a".repeat(64)}`;

describe("detectSecretsInText", () => {
	it.each([
		[githubToken, "github-token"],
		[`github_pat_${"a".repeat(22)}`, "github-token"],
		[anthropicKey, "anthropic-key"],
		[openAiKey, "openai-key"],
		[awsKey, "aws-access-key-id"],
		[slackToken, "slack-token"],
		[gitlabToken, "gitlab-token"],
		[npmToken, "npm-token"],
		[stripeKey, "stripe-key"],
		[jwt, "jwt"],
		[`token=${"z".repeat(16)}`, "generic"],
	])("detects %s as %s", (text, kind) => {
		const [detected] = detectSecretsInText(text);

		expect(detected).toMatchObject({ value: text.includes("=") ? text.slice(text.indexOf("=") + 1) : text, kind });
		expect(text.slice(detected.start, detected.end)).toBe(detected.value);
	});

	it("detects multiline PEM blocks through the matching end marker", () => {
		const pem = "-----BEGIN RSA PRIVATE KEY-----\nline-one\nline-two\n-----END RSA PRIVATE KEY-----";
		const [detected] = detectSecretsInText(`before\n${pem}\nafter`);

		expect(detected).toMatchObject({ kind: "pem", value: pem });
		expect(`before\n${pem}\nafter`.slice(detected.start, detected.end)).toBe(pem);
	});

	it("uses the full tag span while exposing trimmed tag content and an optional name", () => {
		const named = '<secret name="DEPLOY_KEY">  abcdefghijklmnop  </secret>';
		const unnamed = "<secret>qrstuvwxyzabcdef</secret>";
		const text = `${named} then ${unnamed}`;
		const detected = detectSecretsInText(text);

		expect(detected).toEqual([
			{ start: 0, end: named.length, value: "abcdefghijklmnop", name: "DEPLOY_KEY", kind: "tag" },
			{ start: named.length + 6, end: text.length, value: "qrstuvwxyzabcdef", kind: "tag" },
		]);
	});

	it("detects a hex key only when its line is keyword-gated", () => {
		const detected = detectSecretsInText(`private wallet key: ${hexKey}\n${hexKey}`);

		expect(detected).toHaveLength(1);
		expect(detected[0]).toMatchObject({ kind: "hex-key", value: hexKey });
	});

	it("prefers specific detections, excludes replacements, and returns sorted non-overlapping spans", () => {
		const generic = "password=abcdefghijklmnop";
		const text = `${generic} ${githubToken} token=${githubToken} [secret GITHUB_TOKEN (mask)]`;
		const detected = detectSecretsInText(text);

		expect(detected.map(secret => secret.kind)).toEqual(["generic", "github-token", "github-token"]);
		for (let index = 1; index < detected.length; index++) {
			expect(detected[index - 1].end).toBeLessThanOrEqual(detected[index].start);
		}
	});

	it("rejects near misses", () => {
		const text = `ghp_${"a".repeat(20)} sk-${"a".repeat(19)} ${hexKey}`;

		expect(detectSecretsInText(text)).toEqual([]);
	});

	it("skips only the exact marker this module's consumer emits", () => {
		const marker = `[secret GITHUB_TOKEN (ghp_…aaaa) — exported as env var GITHUB_TOKEN in bash]`;

		expect(detectSecretsInText(`use ${marker} now`)).toEqual([]);
	});

	it("still detects a live token wrapped in a forged marker", () => {
		// A user (or an injected document) must not be able to suppress detection
		// by wrapping a credential in bracket text that merely looks like a marker.
		for (const forged of [
			`[secret ${githubToken}]`,
			`[secret token=${githubToken}]`,
			`[secret GITHUB_TOKEN (${githubToken}) — exported as env var OTHER_NAME in bash]`,
		]) {
			const detected = detectSecretsInText(forged);

			expect(detected).toHaveLength(1);
			expect(detected[0]).toMatchObject({ kind: "github-token", value: githubToken });
		}
	});

	it("stays linear on many unclosed secret tags", () => {
		const hostile = "<secret>".repeat(64_000);
		const started = performance.now();

		expect(detectSecretsInText(hostile)).toEqual([]);
		expect(performance.now() - started).toBeLessThan(1_000);
	});

	it("maps detector kinds to suggested secret names", () => {
		expect(kindToName("github-token")).toBe("GITHUB_TOKEN");
		expect(kindToName("openai-key")).toBe("OPENAI_API_KEY");
		expect(kindToName("anthropic-key")).toBe("ANTHROPIC_API_KEY");
		expect(kindToName("pem")).toBe("PRIVATE_KEY");
		expect(kindToName("unknown")).toBe("SECRET");
	});
});
