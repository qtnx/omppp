/**
 * `ompx auth-gateway` command handlers.
 *
 * Boots a forward-proxy server that lets less-trusted clients (the macOS
 * usage widget, robomp containers, teammates on a tailnet, …) make provider
 * API calls without ever seeing upstream access tokens. By default the
 * gateway follows the same credential source as the CLI: configured broker
 * first, otherwise local SQLite/env/config credentials. `--local` bypasses a
 * configured broker and serves only this machine's local credentials.
 *
 * Sub-verbs:
 *   - `serve [--bind=…] [--local] [--verbose]` — boots the gateway.
 *   - `token` / `token --regenerate` — manages the gateway bearer token file.
 *   - `status` — prints the locally-stored gateway token and source hint.
 *   - `serve --daemon` — boots the gateway in the background and returns after readiness.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	type Api,
	AuthStorage,
	type CompletionProbe,
	type CompletionProbeInput,
	type CredentialCompletionResult,
	type CredentialHealthResult,
	completeSimple,
	type Model,
	type Provider,
} from "@oh-my-pi/pi-ai";
import {
	AuthBrokerClient,
	loadAuthBrokerAccountPool,
	RemoteAuthCredentialStore,
	type SnapshotResponse,
} from "@oh-my-pi/pi-ai/auth-broker";
import { DEFAULT_AUTH_GATEWAY_BIND, startAuthGateway } from "@oh-my-pi/pi-ai/auth-gateway";
import { type GeneratedProvider, getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { APP_NAME, getAgentDbPath, getConfigRootDir, isEnoent, VERSION } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { setTransports as setLoggerTransports } from "@oh-my-pi/pi-utils/logger";
import { ModelRegistry } from "../config/model-registry";
import { ModelsConfigFile } from "../config/models-config";
import { resolveConfigValue } from "../config/resolve-config-value";
import { type AuthBrokerClientConfig, resolveAuthBrokerConfig } from "../session/auth-broker-config";

export type AuthGatewayAction = "serve" | "token" | "status" | "check";

export interface AuthGatewayCommandArgs {
	action: AuthGatewayAction;
	flags: {
		json?: boolean;
		bind?: string;
		regenerate?: boolean;
		/**
		 * Disable bearer-token auth on inbound requests. Useful when the gateway
		 * is bound to loopback (the default `127.0.0.1:4000`) and you don't want
		 * to wire token-paste plumbing into every local client.
		 */
		noAuth?: boolean;
		/**
		 * Strict mode for `check` — additionally exercise every credential
		 * against its provider's chat-completion endpoint. The usage probe (run
		 * unconditionally) can pass while the chat endpoint still 401s the same
		 * bearer, so strict mode is the definitive "is this credential
		 * actually usable" signal. Slower and consumes a tiny amount of quota.
		 */
		strict?: boolean;
		/** Use local SQLite/env/config credentials even when an auth broker is configured. */
		local?: boolean;
		/** Run `serve` in a detached background process and return after /healthz is ready. */
		daemon?: boolean;
		/** Stream structured gateway logs to the terminal while preserving rotating file logs. */
		verbose?: boolean;
	};
}

const ACTIONS: readonly AuthGatewayAction[] = ["serve", "token", "status", "check"];

function getTokenFilePath(): string {
	return path.join(getConfigRootDir(), "auth-gateway.token");
}

function getDaemonPidFilePath(): string {
	return path.join(getConfigRootDir(), "auth-gateway.pid");
}

function getDaemonStateFilePath(): string {
	return path.join(getConfigRootDir(), "auth-gateway.daemon.json");
}

function getDaemonLogFilePath(): string {
	return path.join(getConfigRootDir(), "auth-gateway.log");
}

function cleanEnvWithDaemonLog(logFile: string): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) env[key] = value;
	}
	env.OMP_AUTH_GATEWAY_DAEMON_LOG = logFile;
	return env;
}

function selfCliCommandPrefix(): string[] {
	const entry = process.argv[1];
	if (entry && (entry.endsWith(".ts") || entry.endsWith(".js"))) return [process.execPath, entry];
	return [process.execPath];
}

function daemonChildCommand(flags: AuthGatewayCommandArgs["flags"], bind: string): string[] {
	const cmd = [...selfCliCommandPrefix(), "auth-gateway", "serve", "--bind", bind];
	if (flags.noAuth) cmd.push("--no-auth");
	if (flags.local) cmd.push("--local");
	return cmd;
}

function healthUrlForBind(bind: string): string {
	let host = "127.0.0.1";
	let portText = "";
	if (bind.startsWith("[")) {
		const close = bind.indexOf("]");
		if (close === -1 || bind[close + 1] !== ":") throw new Error(`Invalid bind address for daemon: ${bind}`);
		host = bind.slice(1, close);
		portText = bind.slice(close + 2);
	} else {
		const idx = bind.lastIndexOf(":");
		if (idx === -1) {
			portText = bind;
		} else {
			host = bind.slice(0, idx) || "127.0.0.1";
			portText = bind.slice(idx + 1);
		}
	}
	const port = Number(portText);
	if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
		throw new Error(`--daemon requires an explicit non-zero TCP port in --bind (got ${bind})`);
	}
	if (host === "0.0.0.0" || host === "::" || host === "[::]") host = "127.0.0.1";
	const urlHost = host.includes(":") ? `[${host}]` : host;
	return `http://${urlHost}:${port}`;
}

async function fetchHealthReady(url: string): Promise<boolean> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 500);
	timeout.unref?.();
	try {
		const res = await fetch(`${url}/healthz`, { signal: controller.signal });
		return res.ok;
	} catch {
		return false;
	} finally {
		clearTimeout(timeout);
	}
}

async function waitForDaemonReady(url: string, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await fetchHealthReady(url)) return;
		await Bun.sleep(100);
	}
	throw new Error(`auth-gateway daemon did not become healthy at ${url}/healthz within ${timeoutMs}ms`);
}

function writeServeOutput(text: string): Promise<void> | void {
	process.stdout.write(text);
	const logFile = process.env.OMP_AUTH_GATEWAY_DAEMON_LOG;
	if (!logFile) return;
	return fs.appendFile(logFile, text);
}

async function readToken(): Promise<string | null> {
	try {
		const raw = await Bun.file(getTokenFilePath()).text();
		const trimmed = raw.trim();
		return trimmed.length > 0 ? trimmed : null;
	} catch (err) {
		if (isEnoent(err)) return null;
		throw err;
	}
}

async function writeToken(token: string): Promise<void> {
	const file = getTokenFilePath();
	await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
	await fs.writeFile(file, token, { mode: 0o600 });
	try {
		await fs.chmod(file, 0o600);
	} catch {
		// Best-effort (e.g. Windows).
	}
}

/**
 * Atomically create the token file, refusing to clobber an existing one.
 * Returns `true` on success, `false` when the file already existed (so the
 * caller re-reads it instead of racing another concurrent `ensureToken`).
 */
async function createTokenExclusive(token: string): Promise<boolean> {
	const file = getTokenFilePath();
	await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
	try {
		// `wx` = O_CREAT | O_EXCL — fails with EEXIST if the file is already there.
		await fs.writeFile(file, token, { flag: "wx", mode: 0o600 });
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw err;
	}
	try {
		await fs.chmod(file, 0o600);
	} catch {
		// Best-effort (e.g. Windows).
	}
	return true;
}

function generateToken(): string {
	return crypto.randomBytes(32).toString("base64url");
}

async function ensureToken(): Promise<string> {
	const existing = await readToken();
	if (existing) return existing;
	const token = generateToken();
	if (await createTokenExclusive(token)) return token;
	// Another concurrent invocation won the create race; read what they wrote.
	const fromRace = await readToken();
	if (fromRace) return fromRace;
	// File existed-then-disappeared between EEXIST and read; last resort, write
	// our generated token unconditionally so callers don't see an empty string.
	await writeToken(token);
	return token;
}

function createBrokerClient(brokerConfig: AuthBrokerClientConfig): AuthBrokerClient {
	return new AuthBrokerClient({ url: brokerConfig.url, token: brokerConfig.token });
}

async function fetchBrokerSnapshot(client: AuthBrokerClient): Promise<SnapshotResponse> {
	const result = await client.fetchSnapshot();
	if (result.status !== 200) throw new Error("Auth broker returned no initial snapshot");
	return result.snapshot;
}

type AuthGatewayCredentialSource =
	| { kind: "broker"; url: string; storage: AuthStorage; credentialCount: number }
	| { kind: "local"; dbPath: string; storage: AuthStorage; credentialCount: number };

async function createBrokerCredentialSource(
	brokerConfig: AuthBrokerClientConfig,
): Promise<AuthGatewayCredentialSource> {
	// Build a broker-backed AuthStorage — same pattern as discoverAuthStorage()
	// in sdk.ts. The gateway never touches local SQLite.
	const accountPool = await loadAuthBrokerAccountPool();
	const client = createBrokerClient(brokerConfig);
	const initialSnapshot = await fetchBrokerSnapshot(client);
	const store = new RemoteAuthCredentialStore({
		client,
		initialSnapshot,
		accountPool,
	});
	// Refresh + usage both flow through the store's broker hooks automatically —
	// `RemoteAuthCredentialStore.refreshOAuthCredential` and `.fetchUsageReports`.
	// AuthStorage discovers them when no explicit option overrides them, so the
	// gateway only needs to construct the store and pass it in.
	const storage = new AuthStorage(store, {
		sourceLabel: `broker ${brokerConfig.url}`,
	});
	await storage.reload();
	return {
		kind: "broker",
		url: brokerConfig.url,
		storage,
		credentialCount: initialSnapshot.credentials.length,
	};
}

async function createLocalCredentialSource(): Promise<AuthGatewayCredentialSource> {
	const dbPath = getAgentDbPath();
	const storage = await AuthStorage.create(dbPath, {
		configValueResolver: resolveConfigValue,
		sourceLabel: `local ${dbPath}`,
	});
	await storage.reload();
	return {
		kind: "local",
		dbPath,
		storage,
		credentialCount: storage.exportSnapshot().credentials.length,
	};
}

async function resolveGatewayCredentialSource(
	flags: AuthGatewayCommandArgs["flags"],
): Promise<AuthGatewayCredentialSource> {
	if (!flags.local) {
		const brokerConfig = await resolveAuthBrokerConfig();
		if (brokerConfig) return createBrokerCredentialSource(brokerConfig);
	}
	return createLocalCredentialSource();
}

interface GatewayModelIndex {
	listModels: Model<Api>[];
	resolveById: Map<string, Model<Api>>;
}
interface BuildGatewayModelIndexOptions {
	includeAliases?: boolean;
}

function qualifiedModelId(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

function modelIdEntries(model: Model<Api>): string[] {
	return [qualifiedModelId(model), model.id];
}

/**
 * Index resolvable models by the request ids clients may send: the
 * provider-qualified `provider/id` (always) and the bare `id` (first-write-wins
 * fallback for legacy clients). Scoped to providers the gateway holds broker
 * credentials for, since only those are routable.
 */
export function indexModelsByRequestId(
	models: readonly Model<Api>[],
	providersWithCreds: ReadonlySet<string>,
): Map<string, Model<Api>> {
	const modelById = new Map<string, Model<Api>>();
	for (const model of models) {
		if (!providersWithCreds.has(model.provider)) continue;
		for (const entry of modelIdEntries(model)) {
			if (!modelById.has(entry)) modelById.set(entry, model);
		}
	}
	return modelById;
}

function cloneAliasModel(alias: string, target: Model<Api>): Model<Api> {
	return { ...target, id: alias };
}
function aliasShortId(alias: string): string | undefined {
	const slashIndex = alias.indexOf("/");
	if (slashIndex <= 0 || slashIndex === alias.length - 1) return undefined;
	return alias.slice(slashIndex + 1);
}

function setAliasResolution(
	resolveById: Map<string, Model<Api>>,
	alias: string,
	entry: string,
	target: Model<Api>,
): void {
	const existing = resolveById.get(entry);
	if (existing && existing !== target) {
		throw new Error(
			`auth-gateway model alias "${alias}" short id "${entry}" collides with existing model ${qualifiedModelId(existing)}`,
		);
	}
	resolveById.set(entry, target);
}

function assertAliasCapabilities(
	alias: string,
	targetName: string,
	aliasModel: Model<Api> | undefined,
	target: Model<Api>,
): void {
	if (!aliasModel?.input) return;
	const targetInputs = new Set(target.input ?? []);
	const missingInputs = aliasModel.input.filter(input => !targetInputs.has(input));
	if (missingInputs.length === 0) return;
	throw new Error(
		`auth-gateway model alias "${alias}" target "${targetName}" is missing input capabilities: ${missingInputs.join(", ")}`,
	);
}

function loadAuthGatewayModelAliases(): Record<string, string> {
	const result = ModelsConfigFile.relocate().tryLoad();
	if (result.status === "error") throw result.error;
	return result.value?.authGateway?.modelAliases ?? {};
}

function buildGatewayModelIndex(
	source: AuthGatewayCredentialSource,
	options: BuildGatewayModelIndexOptions = {},
): GatewayModelIndex {
	const storage = source.storage;
	const registry =
		source.kind === "broker"
			? new ModelRegistry(storage, undefined, { ignoreUserConfig: true })
			: new ModelRegistry(storage);
	const allModelById = new Map<string, Model<Api>>();
	for (const model of registry.getAll()) {
		for (const entry of modelIdEntries(model)) {
			if (!allModelById.has(entry)) allModelById.set(entry, model);
		}
	}
	const models = source.kind === "broker" ? registry.getAll() : registry.getAvailable();
	const resolveById = new Map<string, Model<Api>>();
	const listModels: Model<Api>[] = [];
	for (const model of models) {
		if (source.kind === "broker" ? !storage.has(model.provider) : !storage.hasAuth(model.provider)) continue;
		listModels.push(model);
		for (const entry of modelIdEntries(model)) {
			if (!resolveById.has(entry)) resolveById.set(entry, model);
		}
	}
	if (options.includeAliases === false) return { listModels, resolveById };
	for (const [alias, targetName] of Object.entries(loadAuthGatewayModelAliases())) {
		const target = resolveById.get(targetName);
		if (!target) {
			throw new Error(`auth-gateway model alias "${alias}" target "${targetName}" is not available`);
		}
		assertAliasCapabilities(alias, targetName, allModelById.get(alias), target);
		for (const entry of modelIdEntries(cloneAliasModel(alias, target))) {
			setAliasResolution(resolveById, alias, entry, target);
		}
		const shortId = aliasShortId(alias);
		if (shortId) setAliasResolution(resolveById, alias, shortId, target);
		listModels.push(cloneAliasModel(alias, target));
	}
	return { listModels, resolveById };
}

function describeSource(source: AuthGatewayCredentialSource): string {
	return source.kind === "broker" ? `broker ${source.url}` : `local ${source.dbPath}`;
}

async function runServeDaemon(flags: AuthGatewayCommandArgs["flags"], bind: string): Promise<void> {
	const url = healthUrlForBind(bind);
	const pidFile = getDaemonPidFilePath();
	const stateFile = getDaemonStateFilePath();
	const logFile = getDaemonLogFilePath();
	await fs.mkdir(path.dirname(stateFile), { recursive: true, mode: 0o700 });
	await fs.appendFile(logFile, `[${new Date().toISOString()}] starting auth-gateway daemon at ${url}\n`);
	const cmd = daemonChildCommand(flags, bind);
	const child = Bun.spawn(cmd, {
		cwd: process.cwd(),
		env: cleanEnvWithDaemonLog(logFile),
		stdin: "ignore",
		stdout: "ignore",
		stderr: "ignore",
		detached: true,
	});
	if (child.pid === undefined) throw new Error("auth-gateway daemon did not expose a process id");
	child.unref();
	await fs.writeFile(pidFile, `${child.pid}\n`, { mode: 0o600 });
	try {
		await fs.chmod(pidFile, 0o600);
	} catch {
		// Best-effort (e.g. Windows).
	}
	const state = {
		pid: child.pid,
		url,
		bind,
		logFile,
		pidFile,
		startedAt: new Date().toISOString(),
	};
	await fs.writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
	try {
		await fs.chmod(stateFile, 0o600);
	} catch {
		// Best-effort (e.g. Windows).
	}
	await waitForDaemonReady(url);
	process.stdout.write(`auth-gateway daemon started\n`);
	process.stdout.write(`url: ${url}\n`);
	process.stdout.write(`pid: ${child.pid}\n`);
	process.stdout.write(`pid file: ${pidFile}\n`);
	process.stdout.write(`log file: ${logFile}\n`);
}

async function runServe(flags: AuthGatewayCommandArgs["flags"]): Promise<void> {
	const bind = flags.bind ?? DEFAULT_AUTH_GATEWAY_BIND;
	if (flags.daemon) {
		await runServeDaemon(flags, bind);
		return;
	}
	if (flags.verbose) setLoggerTransports({ console: true, file: true });
	const gatewayToken = flags.noAuth ? null : await ensureToken();
	const source = await resolveGatewayCredentialSource(flags);
	const storage = source.storage;
	const modelIndex = buildGatewayModelIndex(source);
	if (modelIndex.resolveById.size === 0) {
		storage.close();
		throw new Error(
			`No auth-gateway models available from ${describeSource(source)}. Add a provider API key or OAuth credential first.`,
		);
	}

	const handle = startAuthGateway({
		storage,
		bind,
		bearerTokens: gatewayToken ? [gatewayToken] : [],
		version: VERSION,
		resolveModel: (id: string) => modelIndex.resolveById.get(id),
		listModels: () => modelIndex.listModels,
	});
	writeServeOutput(`auth-gateway listening on ${handle.url}\n`);
	if (gatewayToken) {
		writeServeOutput(`bearer token: ${getTokenFilePath()} (chmod 0600)\n`);
	} else {
		writeServeOutput(`auth: disabled (--no-auth) — any client can call this gateway\n`);
	}
	writeServeOutput(`credential source: ${describeSource(source)}\n`);

	const stopped = Promise.withResolvers<void>();
	let shutdownStarted = false;
	const stop = async (signal: NodeJS.Signals): Promise<void> => {
		if (shutdownStarted) return;
		shutdownStarted = true;
		await writeServeOutput(`\nReceived ${signal}, shutting down...\n`);
		let closeError: unknown;
		try {
			await handle.close();
		} catch (error) {
			closeError = error;
		} finally {
			storage.close();
		}
		if (closeError) {
			stopped.reject(closeError);
		} else {
			stopped.resolve();
		}
	};
	const onSigint = (): void => {
		void stop("SIGINT");
	};
	const onSigterm = (): void => {
		void stop("SIGTERM");
	};
	process.once("SIGINT", onSigint);
	process.once("SIGTERM", onSigterm);

	try {
		await stopped.promise;
	} finally {
		process.off("SIGINT", onSigint);
		process.off("SIGTERM", onSigterm);
	}
}

async function runToken(flags: AuthGatewayCommandArgs["flags"]): Promise<void> {
	if (flags.regenerate) {
		const next = generateToken();
		await writeToken(next);
		if (flags.json) {
			process.stdout.write(`${JSON.stringify({ token: next, path: getTokenFilePath() })}\n`);
		} else {
			process.stdout.write(`${next}\n`);
		}
		return;
	}
	const token = await ensureToken();
	if (flags.json) {
		process.stdout.write(`${JSON.stringify({ token, path: getTokenFilePath() })}\n`);
	} else {
		process.stdout.write(`${token}\n`);
	}
}

async function runStatus(flags: AuthGatewayCommandArgs["flags"]): Promise<void> {
	const token = await readToken();
	const tokenFile = getTokenFilePath();
	let source: AuthGatewayCredentialSource;
	try {
		source = await resolveGatewayCredentialSource(flags);
	} catch (error) {
		const brokerConfig = flags.local ? null : await resolveAuthBrokerConfig().catch(() => null);
		const message = error instanceof Error ? error.message : String(error);
		const status = {
			ready: false,
			reason: "credential_source_unavailable",
			tokenFile,
			tokenPresent: token !== null,
			broker: brokerConfig?.url ?? null,
			brokerConfigured: brokerConfig !== null,
			brokerAuthenticated: false,
			source: flags.local ? "local" : brokerConfig ? "broker" : "unknown",
			error: message,
		};
		if (flags.json) {
			process.stdout.write(`${JSON.stringify(status)}\n`);
		} else {
			process.stdout.write(`${chalk.red("FAILED")} credential source unavailable: ${message}\n`);
			process.stdout.write(
				`token: ${status.tokenPresent ? chalk.green("present") : chalk.red("missing")} at ${status.tokenFile}\n`,
			);
		}
		process.exitCode = 1;
		return;
	}

	try {
		const tokenPresent = token !== null;
		const status = {
			ready: tokenPresent,
			reason: tokenPresent ? null : "token_missing",
			tokenFile,
			tokenPresent,
			broker: source.kind === "broker" ? source.url : null,
			brokerConfigured: source.kind === "broker",
			brokerAuthenticated: source.kind === "broker",
			source: source.kind,
			credentialSource: describeSource(source),
			credentialCount: source.credentialCount,
		};
		if (flags.json) {
			process.stdout.write(`${JSON.stringify(status)}\n`);
		} else {
			const sourceLine = `${describeSource(source)} (${source.credentialCount} credential${
				source.credentialCount === 1 ? "" : "s"
			})`;
			process.stdout.write(`${tokenPresent ? chalk.green("ready") : chalk.yellow("not ready")} ${sourceLine}\n`);
			process.stdout.write(
				`token: ${tokenPresent ? chalk.green("present") : chalk.red("missing")} at ${status.tokenFile}\n`,
			);
			if (!tokenPresent) {
				process.stdout.write(
					`Run \`${APP_NAME} auth-gateway token\` or \`${APP_NAME} auth-gateway serve\` to create a bearer token.\n`,
				);
			}
		}
		if (!tokenPresent) process.exitCode = 1;
	} finally {
		source.storage.close();
	}
}

export async function runAuthGatewayCommand(cmd: AuthGatewayCommandArgs): Promise<void> {
	if (cmd.flags.daemon && cmd.action !== "serve") {
		throw new Error("`--daemon` is only supported with `auth-gateway serve`");
	}
	if (cmd.flags.verbose && cmd.action !== "serve") {
		throw new Error("`--verbose` is only supported with `auth-gateway serve`");
	}
	if (cmd.flags.verbose && cmd.flags.daemon) {
		throw new Error("`--verbose` cannot be combined with `--daemon`; tail the daemon log instead");
	}
	switch (cmd.action) {
		case "serve":
			await runServe(cmd.flags);
			return;
		case "token":
			await runToken(cmd.flags);
			return;
		case "status":
			await runStatus(cmd.flags);
			return;
		case "check":
			await runCheck(cmd.flags);
			return;
		default: {
			const _exhaustive: never = cmd.action;
			throw new Error(`Unknown auth-gateway action: ${String(_exhaustive)}`);
		}
	}
}

/**
 * Providers whose chat endpoint expects a JSON-serialized credential blob
 * (`{ token, projectId, refreshToken, expiresAt, … }`) rather than the raw
 * access token. Mirrors `getOAuthApiKey` in `packages/ai/src/registry/oauth`.
 */
const STRUCTURED_API_KEY_PROVIDERS: ReadonlySet<string> = new Set([
	"github-copilot",
	"google-gemini-cli",
	"google-antigravity",
]);

/**
 * Provider API types that strict-mode chat probes intentionally skip:
 * - `bedrock-converse-stream` resolves credentials from the AWS env/profile, not the broker bearer.
 * - `google-vertex` uses Application Default Credentials; the broker bearer is not the right key.
 * - `cursor-agent` and `pi-native` (gateway forwarding) have transport quirks
 *   that make a bearer-only "ping" a poor signal.
 */
const STRICT_PROBE_SKIPPED_APIS: ReadonlySet<Api> = new Set<Api>([
	"bedrock-converse-stream",
	"google-vertex",
	"cursor-agent",
]);

/** Max chat models to try per credential before reporting failure. */
const STRICT_PROBE_MAX_CANDIDATES = 4;

/** Per-attempt deadline. Each candidate gets its own slice instead of sharing one budget. */
const STRICT_PROBE_PER_ATTEMPT_TIMEOUT_MS = 15_000;

/**
 * Overall per-credential budget passed to {@link AuthStorage.checkCredentials}.
 * Big enough to walk every candidate at the per-attempt cap with a small
 * margin for refresh/network overhead.
 */
const STRICT_PROBE_OVERALL_TIMEOUT_MS = STRICT_PROBE_PER_ATTEMPT_TIMEOUT_MS * (STRICT_PROBE_MAX_CANDIDATES + 1);

/** Match upstream errors that mean "this model is gone, try a different one" so we walk the catalog instead of declaring the credential bad. */
const RETRYABLE_MODEL_ERROR_RE =
	/not[_ -]found|invalid[_ -]model|model[_ -]is[_ -]not[_ -]valid|no longer supported|deprecated|404|decommissioned/i;

/**
 * Rank bundled models for a provider in probe order: cheapest first, then by
 * id for determinism. Filters out non-bearer-auth APIs (Vertex/Bedrock),
 * pi-native transport (would loop through the gateway), and placeholder /
 * router entries with negative/missing cost.
 */
function pickProbeCandidates(provider: string): Model<Api>[] {
	const bundled = getBundledModels(provider as GeneratedProvider);
	if (bundled.length === 0) return [];
	const candidates = bundled.filter(model => {
		if (model.transport === "pi-native") return false;
		if (STRICT_PROBE_SKIPPED_APIS.has(model.api)) return false;
		if (!model.input.includes("text")) return false;
		const totalCost = (model.cost?.input ?? 0) + (model.cost?.output ?? 0);
		if (!Number.isFinite(totalCost) || totalCost < 0) return false;
		if (model.maxTokens !== null && model.maxTokens <= 0) return false;
		return true;
	});
	candidates.sort((a, b) => a.cost.input + a.cost.output - (b.cost.input + b.cost.output) || a.id.localeCompare(b.id));
	return candidates;
}

/**
 * Compose the apiKey bytes a provider's chat endpoint expects, given a
 * post-refresh probe credential. Mirrors `getOAuthApiKey` for the providers
 * that require a structured blob; otherwise returns the raw access token /
 * API key.
 */
function composeProbeApiKey(provider: string, credential: CompletionProbeInput["credential"]): string {
	if (credential.type === "api_key") return credential.apiKey;
	if (!STRUCTURED_API_KEY_PROVIDERS.has(provider)) return credential.accessToken;
	return JSON.stringify({
		token: credential.accessToken,
		enterpriseUrl: credential.enterpriseUrl,
		projectId: credential.projectId,
		refreshToken: credential.refreshToken,
		expiresAt: credential.expiresAt,
		email: credential.email,
		accountId: credential.accountId,
	});
}

async function probeOneModel(
	model: Model<Api>,
	apiKey: string,
	outerSignal: AbortSignal,
): Promise<CredentialCompletionResult> {
	const start = Date.now();
	const attemptTimeoutSignal = AbortSignal.timeout(STRICT_PROBE_PER_ATTEMPT_TIMEOUT_MS);
	const attemptSignal = AbortSignal.any([outerSignal, attemptTimeoutSignal]);
	// `systemPrompt` is mandatory for some providers (Codex 400s "Instructions
	// are required" without it). `disableReasoning` is intentionally NOT set:
	// providers like Fireworks reject the "none" effort it maps to, and we'd
	// rather burn 16 reasoning tokens than misdiagnose a healthy credential.
	const response = await completeSimple(
		model,
		{
			systemPrompt: ["Connectivity check. Reply with the single word 'pong'."],
			messages: [{ role: "user", content: "ping", timestamp: start }],
		},
		{
			apiKey,
			maxTokens: 32,
			signal: attemptSignal,
		},
	);
	const latencyMs = Date.now() - start;
	if (response.stopReason === "error" || response.stopReason === "aborted") {
		return {
			ok: false,
			reason: response.errorMessage ?? `chat probe ended with stopReason=${response.stopReason}`,
			modelId: model.id,
			latencyMs,
		};
	}
	return { ok: true, modelId: model.id, latencyMs };
}

/**
 * Build the {@link CompletionProbe} consumed by
 * {@link AuthStorage.checkCredentials} in `--strict` mode. Walks the cheapest
 * candidates per provider, retrying on "model not found / invalid model"
 * errors so a stale catalog entry doesn't masquerade as a bad credential.
 * Stops as soon as one model returns a successful response (the credential
 * authenticated against at least one model in the catalog).
 */
function createStrictCompletionProbe(): CompletionProbe {
	return async (input: CompletionProbeInput): Promise<CredentialCompletionResult> => {
		const candidates = pickProbeCandidates(input.provider).slice(0, STRICT_PROBE_MAX_CANDIDATES);
		if (candidates.length === 0) {
			return { ok: null, reason: `no bearer-compatible probe model bundled for provider ${input.provider}` };
		}
		const apiKey = composeProbeApiKey(input.provider, input.credential);
		let lastFailure: CredentialCompletionResult | undefined;
		for (const model of candidates) {
			if (input.signal.aborted) {
				return {
					ok: false,
					reason: "aborted",
					modelId: model.id,
				};
			}
			const result = await probeOneModel(model, apiKey, input.signal);
			if (result.ok === true) return result;
			lastFailure = result;
			if (!RETRYABLE_MODEL_ERROR_RE.test(result.reason ?? "")) {
				// Non-model error (401, 403, 5xx, network) — the credential is the
				// issue, not the catalog. Stop walking.
				return result;
			}
		}
		return (
			lastFailure ?? {
				ok: false,
				reason: `all ${candidates.length} probe models failed for provider ${input.provider}`,
			}
		);
	};
}

function formatCompletionStatus(completion: CredentialCompletionResult | undefined): string {
	if (!completion) return "";
	if (completion.ok === true) return chalk.green(" [chat: ok]");
	if (completion.ok === false) return chalk.red(" [chat: FAIL]");
	return chalk.yellow(" [chat: skip]");
}

const SYNTHETIC_LOCAL_CREDENTIAL_ID = 0;

async function appendResolvedLocalCredentialResults(
	source: AuthGatewayCredentialSource,
	results: CredentialHealthResult[],
	completionProbe: CompletionProbe | undefined,
): Promise<CredentialHealthResult[]> {
	if (source.kind !== "local") return results;
	const storage = source.storage;
	const providerNames = new Set(
		buildGatewayModelIndex(source, { includeAliases: false }).listModels.map(model => model.provider),
	);
	const extraResults: CredentialHealthResult[] = [];
	for (const provider of [...providerNames].sort()) {
		const origin = storage.getCredentialOrigin(provider);
		if (
			origin?.kind !== "runtime" &&
			origin?.kind !== "config" &&
			origin?.kind !== "env" &&
			origin?.kind !== "fallback"
		) {
			continue;
		}
		const apiKey = await storage.getApiKey(provider);
		const result: CredentialHealthResult = {
			id: SYNTHETIC_LOCAL_CREDENTIAL_ID,
			provider,
			type: "api_key",
			ok: null,
			reason: `${origin.kind} credential is not stored; usage health is unavailable`,
		};
		if (completionProbe && apiKey) {
			result.completion = await completionProbe({
				provider: provider as Provider,
				credentialId: SYNTHETIC_LOCAL_CREDENTIAL_ID,
				credential: { type: "api_key", apiKey },
				signal: AbortSignal.timeout(STRICT_PROBE_OVERALL_TIMEOUT_MS),
			});
		}
		extraResults.push(result);
	}
	return [...extraResults, ...results];
}

/**
 * `ompx auth-gateway check` — probe each selected-source credential and print
 * per-credential auth health. Use this when the gateway is returning 401s and
 * you need to find which local or broker row is bad. The aggregate `/v1/usage`
 * endpoint silently drops failed credentials, so a dedicated diagnostic is the
 * only way to see which credentials failed.
 *
 * Strict mode (`--strict`) additionally exercises each credential against a
 * cheap chat model from its provider's bundled catalog. This catches the case
 * where the usage endpoint reports 200 but the chat endpoint 401s the same
 * bearer (revoked OAuth scope, mislabeled provider row, etc).
 */
async function runCheck(flags: AuthGatewayCommandArgs["flags"]): Promise<void> {
	const source = await resolveGatewayCredentialSource(flags);
	const storage = source.storage;
	try {
		const completionProbe = flags.strict ? createStrictCompletionProbe() : undefined;
		const storedResults = await storage.checkCredentials(
			completionProbe ? { completionProbe, completionTimeoutMs: STRICT_PROBE_OVERALL_TIMEOUT_MS } : undefined,
		);
		const results = await appendResolvedLocalCredentialResults(source, storedResults, completionProbe);

		if (flags.json) {
			process.stdout.write(
				`${JSON.stringify(
					{
						broker: source.kind === "broker" ? source.url : null,
						source: source.kind,
						credentialSource: describeSource(source),
						strict: flags.strict === true,
						credentials: results,
					},
					null,
					2,
				)}\n`,
			);
		} else {
			const grouped = new Map<string, typeof results>();
			for (const row of results) {
				const list = grouped.get(row.provider) ?? [];
				list.push(row);
				grouped.set(row.provider, list);
			}
			const providers = [...grouped.keys()].sort();
			process.stdout.write(`${describeSource(source)}${flags.strict ? chalk.dim(" [strict]") : ""}\n`);
			for (const provider of providers) {
				const rows = grouped.get(provider) ?? [];
				process.stdout.write(`\n${chalk.bold(provider)} (${rows.length})\n`);
				for (const row of rows) {
					const status =
						row.ok === true
							? chalk.green("ok      ")
							: row.ok === false
								? chalk.red("FAIL    ")
								: chalk.yellow("unknown ");
					const base =
						row.email ?? row.accountId ?? (row.type === "api_key" ? "(api key)" : "(no identity on credential)");
					// Two subscriptions (orgs) can share one email — without the org a
					// failed row can't say which subscription needs re-login.
					const org = row.orgName ?? row.orgId;
					const identity = org && org !== base ? `${base} (${org})` : base;
					const remote = row.remoteRefresh ? chalk.dim(" [remote-refresh]") : "";
					const reasonParts: string[] = [];
					if (row.reason) reasonParts.push(row.reason);
					if (row.completion?.reason) reasonParts.push(`chat: ${row.completion.reason}`);
					const reason = reasonParts.length > 0 ? chalk.dim(` — ${reasonParts.join("; ")}`) : "";
					const chat = formatCompletionStatus(row.completion);
					process.stdout.write(
						`  ${status}${chat} id=${row.id.toString().padStart(3)} ${row.type.padEnd(7)} ${identity}${remote}${reason}\n`,
					);
				}
			}
			const failed = results.filter(row => row.ok === false).length;
			const unverifiable = results.filter(row => row.ok === null).length;
			const passing = results.filter(row => row.ok === true).length;
			const chatFailed = flags.strict ? results.filter(row => row.completion?.ok === false).length : 0;
			const summaryParts = [
				chalk.green(`${passing} ok`),
				chalk.red(`${failed} failed`),
				chalk.yellow(`${unverifiable} unverifiable`),
			];
			if (flags.strict) summaryParts.push(chalk.red(`${chatFailed} chat-failed`));
			summaryParts.push(`${results.length} total`);
			process.stdout.write(`\n${summaryParts.join(", ")}\n`);
			if (failed > 0 || chatFailed > 0) process.exitCode = 1;
		}
	} finally {
		storage.close();
	}
}

export { ACTIONS as AUTH_GATEWAY_ACTIONS };
