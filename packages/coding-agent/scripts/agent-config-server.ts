#!/usr/bin/env bun
/**
 * Central agent-config host (runs on codemc).
 *
 * Serves `GET /v1/agent-config` as the bundle `RemoteConfigSync` pulls:
 *   { "settings": <root>/config.yml, "agents": { <name>: <root>/agents/<name>.md } }
 * Files are re-read per request, so editing the directory (or `git pull` in it)
 * is the whole deploy. The ETag lets clients skip unchanged bundles.
 *
 * Dependency-free on purpose: deployed as a single file (codemc runs it from
 * /data/code/agent-config-server via the `agent-config` systemd user unit).
 *
 * Usage: bun scripts/agent-config-server.ts <root-dir>
 * Env:   AGENT_CONFIG_HOST (default 0.0.0.0 so tailnet peers can connect)
 *        AGENT_CONFIG_PORT (default 8792)
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { YAML } from "bun";

const root = process.argv[2];
if (!root) {
	console.error("usage: bun scripts/agent-config-server.ts <root-dir>");
	process.exit(1);
}
const rootDir = path.resolve(root);

async function buildBundle(): Promise<string> {
	let settings: unknown = {};
	try {
		settings = YAML.parse(await Bun.file(path.join(rootDir, "config.yml")).text()) ?? {};
	} catch (error) {
		if ((error as { code?: unknown }).code !== "ENOENT") throw error;
	}
	const agents: Record<string, string> = {};
	const agentsDir = path.join(rootDir, "agents");
	const entries = await fs.readdir(agentsDir).catch((error: unknown) => {
		if ((error as { code?: unknown }).code === "ENOENT") return [];
		throw error;
	});
	for (const name of entries.filter(entry => entry.endsWith(".md")).sort()) {
		agents[name.slice(0, -3)] = await Bun.file(path.join(agentsDir, name)).text();
	}
	return JSON.stringify({ settings, agents });
}

const server = Bun.serve({
	hostname: process.env.AGENT_CONFIG_HOST ?? "0.0.0.0",
	port: Number(process.env.AGENT_CONFIG_PORT ?? 8792),
	async fetch(request) {
		const { pathname } = new URL(request.url);
		if (pathname === "/healthz") return new Response("ok");
		if (pathname !== "/v1/agent-config" || request.method !== "GET")
			return new Response("not found", { status: 404 });
		let body: string;
		try {
			body = await buildBundle();
		} catch (error) {
			console.error("agent-config: failed to build bundle", error);
			return new Response("bundle unavailable", { status: 500 });
		}
		const etag = `"${Bun.hash(body).toString(16)}"`;
		if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: { etag } });
		return new Response(body, { headers: { "content-type": "application/json", etag } });
	},
});
console.log(`agent-config serving ${rootDir} on ${server.url}v1/agent-config`);
