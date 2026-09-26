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

	it("accepts the short <sec> alias but not <s> or JSX fragments", () => {
		const named = '<sec name="DB_PASS">abcdefghijklmnop</sec>';
		const text = `${named} <s>qrstuvwxyzabcdef</s> <>rstuvwxyzabcdefg</>`;

		expect(detectSecretsInText(text)).toEqual([
			{ start: 0, end: named.length, value: "abcdefghijklmnop", name: "DB_PASS", kind: "tag" },
		]);
	});

	it("accepts an explicitly tagged secret of any non-empty length", () => {
		expect(detectSecretsInText("pw <sec>test</sec> <sec>  </sec>")).toEqual([
			{ start: 3, end: 18, value: "test", kind: "tag" },
		]);
	});

	it("takes the env var name from a bare tag attribute or the preceding assignment", () => {
		const bare = "<sec DB_PASS>hunter2</sec>";
		const assigned = "API_TOKEN=<sec>abc</sec>";

		expect(detectSecretsInText(bare)).toEqual([
			{ start: 0, end: bare.length, value: "hunter2", name: "DB_PASS", kind: "tag" },
		]);
		expect(detectSecretsInText(assigned)).toEqual([
			{ start: 10, end: assigned.length, value: "abc", name: "API_TOKEN", kind: "tag" },
		]);
	});

	it("accepts the ||value|| shorthand but not shell or JS logical-or", () => {
		const text = "login with ||hunter2|| and DB_PASS: ||s3cr3t||";
		const detected = detectSecretsInText(text);

		expect(detected).toEqual([
			{ start: 11, end: 22, value: "hunter2", kind: "tag" },
			{ start: 36, end: 46, value: "s3cr3t", name: "DB_PASS", kind: "tag" },
		]);
		for (const code of ["a || b || c", "x||y||z", "cmd || true", "a |||| b"]) {
			expect(detectSecretsInText(code)).toEqual([]);
		}
	});

	it("detects short keyword-assigned passwords and names them after the variable", () => {
		const cases: Array<[string, string, string]> = [
			["password: hunter2", "hunter2", "password"],
			["export DB_PASSWORD=s3cr3t!", "s3cr3t!", "DB_PASSWORD"],
			['{"userPassword": "my pass word"}', "my pass word", "userPassword"],
			["PGPASSWORD := 'abcd'", "abcd", "PGPASSWORD"],
		];
		for (const [text, value, name] of cases) {
			const detected = detectSecretsInText(text);
			expect(detected).toEqual([expect.objectContaining({ value, name, kind: "generic" })]);
			expect(text.slice(detected[0].start, detected[0].end)).toBe(value);
		}
	});

	it("ignores keyword assignments that hold references, types, code, or unrelated identifiers", () => {
		for (const text of [
			"password: $DB_PASS",
			"password = ${env.PW}",
			"password: string",
			"password: required",
			"password = getPassword()",
			"password = req.body.password",
			"password: ********",
			"if password == other",
			"bypass=hunter2",
			"max_tokens: 4096",
			"token: abc123",
		]) {
			expect(detectSecretsInText(text)).toEqual([]);
		}
	});

	it("detects the password inside a connection URL", () => {
		const text = "postgres://app:pa55@db.internal:5432/app";
		const [detected] = detectSecretsInText(text);

		expect(detected).toMatchObject({ value: "pa55", kind: "url-password" });
		expect(text.slice(detected.start, detected.end)).toBe("pa55");
		expect(kindToName("url-password")).toBe("PASSWORD");
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
