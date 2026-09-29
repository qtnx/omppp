/**
 * Contract: classifier-flagged lines add secrets regex detection misses, only
 * lines with an extractable literal reach the server, and an unreachable
 * server degrades to regex detection without retrying inside the down window.
 * The HTTP hop is real; a fake server stands in for the model.
 */
import { afterEach, describe, expect, it } from "bun:test";
import type { Server } from "bun";
import { detectSecrets, SentinelClient } from "../../src/secrets/sentinel";

const githubToken = `ghp_${"a".repeat(36)}`;
const text = [
	"drwxr-xr-x  5 work work 4096 Sep 28 packages",
	"command: redis-server --requirepass s3cr3tXy9Qz",
	"MYSQL_ROOT_PASSWORD: s3cr3tP@ssw0rd#2024",
	`token ${githubToken}`,
	"build: node2 compiled in 12ms",
].join("\n");

describe("detectSecrets with Secrets Sentinel", () => {
	let server: Server<undefined> | undefined;
	const received: string[][] = [];

	afterEach(async () => {
		await server?.stop(true);
		server = undefined;
		received.length = 0;
	});

	function startClassifier(): string {
		server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			async fetch(request) {
				const { lines } = (await request.json()) as { lines: string[] };
				received.push(lines);
				return Response.json({ scores: lines.map(line => (line.includes("requirepass") ? 0.99 : 0.01)) });
			},
		});
		return server.url.href;
	}

	it("adds classifier-flagged values to regex detections at their exact offsets", async () => {
		const client = new SentinelClient();
		client.setServerUrl(startClassifier());

		const detected = await detectSecrets(text, client);

		expect(detected.map(secret => [secret.kind, secret.value, text.slice(secret.start, secret.end)])).toEqual([
			["sentinel", "s3cr3tXy9Qz", "s3cr3tXy9Qz"],
			["generic", "s3cr3tP@ssw0rd#2024", "s3cr3tP@ssw0rd#2024"],
			["github-token", githubToken, githubToken],
		]);
		// Lines without a literal token and lines already covered by regex detections never reach the server.
		expect(received).toEqual([["command: redis-server --requirepass s3cr3tXy9Qz", "build: node2 compiled in 12ms"]]);
	});

	it("falls back to regex detection and stops calling a failed server", async () => {
		const client = new SentinelClient();
		client.setServerUrl("http://127.0.0.1:1");

		const first = await detectSecrets(text, client);
		const second = await detectSecrets(text, client);

		expect(first.map(secret => secret.kind)).toEqual(["generic", "github-token"]);
		expect(second).toEqual(first);
		expect(client.enabled).toBe(false);
	});
});
