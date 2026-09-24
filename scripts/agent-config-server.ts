#!/usr/bin/env bun
/**
 * Central agent-config host (runs on codemc).
 *
 * Serves `GET /v1/agent-config` as the bundle `RemoteConfigSync` pulls:
 *   { "settings": <dir>/config.yml, "agents": { <name>: <dir>/agents/<name>.md } }
 *
 * The bundle is read from a git ref, not the working tree: merging a change to
 * `agent-config/` on `main` is the whole deploy. The server fetches the ref on an
 * interval and rebuilds the bundle only when the commit moves. A failed fetch or
 * a malformed commit keeps the last good bundle; with none yet it answers 503,
 * and clients keep their cached mirror.
 *
 * Usage: bun scripts/agent-config-server.ts <git-repo-dir>
 * Env:   AGENT_CONFIG_HOST     (default 0.0.0.0 so tailnet peers can connect)
 *        AGENT_CONFIG_PORT     (default 8792)
 *        AGENT_CONFIG_REMOTE   (default origin)
 *        AGENT_CONFIG_BRANCH   (default main)
 *        AGENT_CONFIG_DIR      (default agent-config, path inside the repo)
 *        AGENT_CONFIG_FETCH_SEC (default 30)
 */
import * as path from "node:path";
import { $, YAML } from "bun";

const repoArg = process.argv[2];
if (!repoArg) {
	console.error("usage: bun scripts/agent-config-server.ts <git-repo-dir>");
	process.exit(1);
}
const repoDir = path.resolve(repoArg);
const remote = process.env.AGENT_CONFIG_REMOTE || "origin";
const branch = process.env.AGENT_CONFIG_BRANCH || "main";
const configDir = (process.env.AGENT_CONFIG_DIR || "agent-config").replace(/\/+$/, "");
const fetchIntervalMs = Math.max(5, Number(process.env.AGENT_CONFIG_FETCH_SEC ?? 30)) * 1000;
const ref = `refs/remotes/${remote}/${branch}`;

let current: { commit: string; body: string; etag: string } | undefined;

async function git(...args: string[]): Promise<string> {
	return (await $`git -C ${repoDir} ${args}`.quiet()).text();
}

async function buildBundle(commit: string): Promise<string> {
	let settings: unknown = {};
	const tree = await git("ls-tree", "--name-only", commit, `${configDir}/`, `${configDir}/agents/`);
	const files = new Set(tree.split("\n").filter(Boolean));
	if (files.has(`${configDir}/config.yml`)) {
		settings = YAML.parse(await git("show", `${commit}:${configDir}/config.yml`)) ?? {};
	}
	if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
		throw new Error("config.yml must be a mapping");
	}
	const agents: Record<string, string> = {};
	const agentFiles = [...files].filter(file => file.startsWith(`${configDir}/agents/`) && file.endsWith(".md")).sort();
	for (const file of agentFiles) {
		agents[path.basename(file, ".md")] = await git("show", `${commit}:${file}`);
	}
	return JSON.stringify({ settings, agents });
}

async function refresh(): Promise<void> {
	try {
		await git("fetch", "--quiet", remote, `+refs/heads/${branch}:${ref}`);
	} catch (error) {
		console.error(`agent-config: fetch ${remote}/${branch} failed, serving last good bundle`, String(error));
	}
	let commit: string;
	try {
		commit = (await git("rev-parse", "--verify", `${ref}^{commit}`)).trim();
	} catch (error) {
		console.error(`agent-config: ${ref} not found`, String(error));
		return;
	}
	if (commit === current?.commit) return;
	try {
		const body = await buildBundle(commit);
		current = { commit, body, etag: `"${commit.slice(0, 12)}-${Bun.hash(body).toString(16)}"` };
		console.log(`agent-config: serving ${remote}/${branch}@${commit.slice(0, 12)}`);
	} catch (error) {
		console.error(`agent-config: bundle at ${commit.slice(0, 12)} rejected, keeping last good`, String(error));
	}
}

await refresh();
setInterval(() => void refresh(), fetchIntervalMs);

const server = Bun.serve({
	hostname: process.env.AGENT_CONFIG_HOST ?? "0.0.0.0",
	port: Number(process.env.AGENT_CONFIG_PORT ?? 8792),
	fetch(request) {
		const { pathname } = new URL(request.url);
		if (pathname === "/healthz")
			return new Response(current ? `ok ${current.commit}` : "no bundle", { status: current ? 200 : 503 });
		if (pathname !== "/v1/agent-config" || request.method !== "GET")
			return new Response("not found", { status: 404 });
		if (!current) return new Response("bundle unavailable", { status: 503 });
		const { body, etag } = current;
		if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: { etag } });
		return new Response(body, { headers: { "content-type": "application/json", etag } });
	},
});
console.log(`agent-config: listening on ${server.url}v1/agent-config`);
