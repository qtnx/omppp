/**
 * Centralized agent configuration.
 *
 * A trusted host (default: the codemc tailnet box) serves one JSON bundle with
 * model/agent routing settings and task-agent definitions. Each interactive
 * process polls it and mirrors the bundle into `<agentDir>/remote/`:
 *
 *   - `remote/config.yml`  — allowlisted settings, merged ABOVE the local
 *                             `config.yml` (the fallback) and below project
 *                             config, `--config` overlays, and runtime choices.
 *   - `remote/agents/*.md` — agent definitions, discovered below the user
 *                             agents dir and above extension/bundled agents.
 *
 * When the host is unreachable the last good mirror keeps applying; with no
 * mirror (or `remoteConfig.enabled` off) the local config applies unchanged.
 *
 * Bundle wire shape (`GET <remoteConfig.url>`, honors `If-None-Match`):
 *   { "settings": { ...nested config.yml keys }, "agents": { "<name>": "<markdown>" } }
 * The bundle is the full remote state: agents missing from it are removed.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";
import { replaceFileAtomically } from "../utils/atomic-file";
import { stringifyYamlConfig } from "./config-file";
import type { Settings } from "./settings";

export const REMOTE_CONFIG_DIRNAME = "remote";
export const REMOTE_CONFIG_FILENAME = "config.yml";
export const REMOTE_AGENTS_DIRNAME = "agents";

const FETCH_TIMEOUT_MS = 5_000;
const MIN_INTERVAL_SEC = 10;
const AGENT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const MAX_AGENT_BYTES = 256 * 1024;

/**
 * Setting subtrees a remote bundle may set. Everything else (extensions, shell,
 * sandbox, bash interceptors, the remoteConfig.* trust anchor itself) is
 * dropped: the remote host routes models and agents, it never executes code.
 */
const REMOTE_SETTING_PATHS: readonly (readonly string[])[] = [
	["modelRoles"],
	["advisor"],
	["duo"],
	["task", "agentModelOverrides"],
	["task", "agentServiceTierOverrides"],
	["task", "agentPrewalk"],
	["task", "agentAdvisor"],
	["task", "disabledAgents"],
	["task", "maxEffort"],
	["retry", "fallbackChains"],
];

export interface RemoteConfigBundle {
	settings: Record<string, unknown>;
	agents: Map<string, string>;
}

export type RemoteConfigSyncResult = "updated" | "unchanged" | "failed" | "disabled";

export interface RemoteConfigSyncOptions {
	/** Called after a bundle landed, so cached agent discovery can rescan. */
	onAgentsChanged?: () => Promise<void> | void;
	fetch?: typeof fetch;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Keep only the allowlisted setting subtrees of a raw nested settings object. */
export function filterRemoteSettings(raw: unknown): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	if (!isPlainRecord(raw)) return out;
	for (const segments of REMOTE_SETTING_PATHS) {
		let value: unknown = raw;
		for (const segment of segments) {
			if (!isPlainRecord(value) || !Object.hasOwn(value, segment)) {
				value = undefined;
				break;
			}
			value = value[segment];
		}
		if (value === undefined) continue;
		let target = out;
		for (const segment of segments.slice(0, -1)) {
			if (!isPlainRecord(target[segment])) target[segment] = {};
			target = target[segment] as Record<string, unknown>;
		}
		target[segments[segments.length - 1]] = structuredClone(value);
	}
	return out;
}

/** Validate a fetched bundle; throws with a reason on any malformed part. */
export function parseRemoteConfigBundle(body: unknown): RemoteConfigBundle {
	if (!isPlainRecord(body)) throw new Error("bundle must be a JSON object");
	if (body.settings !== undefined && !isPlainRecord(body.settings)) throw new Error("settings must be an object");
	if (body.agents !== undefined && !isPlainRecord(body.agents)) throw new Error("agents must be an object");
	const agents = new Map<string, string>();
	for (const [name, content] of Object.entries(body.agents ?? {})) {
		if (!AGENT_NAME_PATTERN.test(name)) throw new Error(`invalid agent name: ${name}`);
		if (typeof content !== "string") throw new Error(`agent ${name} must be markdown text`);
		if (Buffer.byteLength(content) > MAX_AGENT_BYTES)
			throw new Error(`agent ${name} exceeds ${MAX_AGENT_BYTES} bytes`);
		agents.set(name, content);
	}
	return { settings: filterRemoteSettings(body.settings), agents };
}

/**
 * Mirror a bundle into `dir`. Each file is swapped in by rename so readers in
 * this or sibling processes see either the old or the new state, never a torn
 * write.
 */
export async function writeRemoteConfigCache(dir: string, bundle: RemoteConfigBundle): Promise<void> {
	await fs.mkdir(dir, { recursive: true });
	const stamp = `${process.pid}-${Date.now()}`;

	const staged = path.join(dir, `.agents-${stamp}`);
	await fs.mkdir(staged);
	await Promise.all(
		Array.from(bundle.agents, ([name, content]) => Bun.write(path.join(staged, `${name}.md`), content)),
	);
	const live = path.join(dir, REMOTE_AGENTS_DIRNAME);
	const retired = path.join(dir, `.agents-old-${stamp}`);
	try {
		await fs.rename(live, retired);
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
	try {
		await fs.rename(staged, live);
	} catch (error) {
		// A sibling process swapped its copy of the same bundle in first.
		logger.debug("Remote config: agents dir already replaced", { error: String(error) });
		await fs.rm(staged, { recursive: true, force: true });
	}
	await fs.rm(retired, { recursive: true, force: true });

	const tmpConfig = path.join(dir, `.config-${stamp}.yml`);
	await Bun.write(tmpConfig, stringifyYamlConfig(bundle.settings));
	await replaceFileAtomically(tmpConfig, path.join(dir, REMOTE_CONFIG_FILENAME));
}

/** Polls the configured host and applies new bundles to the live settings. */
export class RemoteConfigSync {
	#settings: Settings;
	#options: RemoteConfigSyncOptions;
	#timer?: NodeJS.Timeout;
	#inFlight?: Promise<RemoteConfigSyncResult>;
	/** ETag of the bundle this process last applied; in memory so a sibling's cache write never masks a reload. */
	#etag?: string;

	constructor(settings: Settings, options: RemoteConfigSyncOptions = {}) {
		this.#settings = settings;
		this.#options = options;
	}

	start(): void {
		if (this.#timer || this.#settings.getTrusted("remoteConfig.enabled") !== true) return;
		void this.syncOnce();
		const intervalSec = Math.max(MIN_INTERVAL_SEC, this.#settings.getTrusted("remoteConfig.intervalSec"));
		this.#timer = setInterval(() => void this.syncOnce(), intervalSec * 1000);
		this.#timer.unref();
	}

	stop(): void {
		clearInterval(this.#timer);
		this.#timer = undefined;
	}

	syncOnce(): Promise<RemoteConfigSyncResult> {
		this.#inFlight ??= this.#sync().finally(() => {
			this.#inFlight = undefined;
		});
		return this.#inFlight;
	}

	async #sync(): Promise<RemoteConfigSyncResult> {
		// Trusted layers only: a project config must not redirect this host.
		const url = this.#settings.getTrusted("remoteConfig.url")?.trim();
		if (this.#settings.getTrusted("remoteConfig.enabled") !== true || !url) return "disabled";

		let response: Response;
		try {
			response = await (this.#options.fetch ?? fetch)(url, {
				headers: this.#etag ? { "If-None-Match": this.#etag } : {},
				signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
			});
		} catch (error) {
			logger.debug("Remote config: host unreachable, keeping cached config", { url, error: String(error) });
			return "failed";
		}
		if (response.status === 304) return "unchanged";
		if (!response.ok) {
			logger.warn("Remote config: fetch failed, keeping cached config", { url, status: response.status });
			return "failed";
		}

		let bundle: RemoteConfigBundle;
		try {
			bundle = parseRemoteConfigBundle(await response.json());
		} catch (error) {
			logger.warn("Remote config: rejected malformed bundle, keeping cached config", { url, error: String(error) });
			return "failed";
		}

		await writeRemoteConfigCache(path.join(this.#settings.getAgentDir(), REMOTE_CONFIG_DIRNAME), bundle);
		this.#etag = response.headers.get("etag") ?? undefined;
		await this.#settings.reloadFromDisk();
		await this.#options.onAgentsChanged?.();
		logger.info("Remote config: applied bundle", { url, agents: bundle.agents.size });
		return "updated";
	}
}
