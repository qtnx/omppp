import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $which, isEnoent, logger } from "@oh-my-pi/pi-utils";
import { $ } from "bun";

export type VaultKeyBackend = "keychain" | "libsecret" | "file";

export interface VaultKey {
	key: Buffer;
	backend: VaultKeyBackend;
	/** Raw key material registered as a one-way replace-mode secret so a model-issued keychain/CLI read cannot exfiltrate it. */
	keyMaterialToRedact: string;
}

export class VaultKeyRetrievalError extends Error {
	readonly backend: Exclude<VaultKeyBackend, "file">;

	constructor(backend: Exclude<VaultKeyBackend, "file">, cause: unknown) {
		const reason = cause instanceof Error ? cause.message : String(cause);
		super(`Secret vault ${backend} key retrieval failed: ${reason}`);
		this.name = "VaultKeyRetrievalError";
		this.backend = backend;
	}
}

/** Runtime seams keep OS credential stores out of deterministic tests. */
export const vaultKeychainRuntime = {
	platform: (): NodeJS.Platform => process.platform,
	which: (command: string): string | undefined => $which(command) ?? undefined,
	loadMacosKey: (): Promise<Buffer> => loadMacosKey(),
	loadLinuxKey: (): Promise<Buffer | undefined> => loadLinuxKey(),
};

const KEY_FILE_NAME = "secret-vault.key";
const VAULT_FILE_NAME = "secrets.vault";
const KEYCHAIN_SERVICE = "ompx";
const KEYCHAIN_ACCOUNT = "secret-vault-key";
const MACOS_ITEM_NOT_FOUND_EXIT_CODE = 44;
const LIBSECRET_ITEM_NOT_FOUND_EXIT_CODE = 1;

function parseKey(encoded: string): Buffer | undefined {
	const key = Buffer.from(encoded.trim(), "base64");
	return key.length === 32 ? key : undefined;
}

async function loadFileKey(agentDir: string): Promise<VaultKey> {
	await fs.mkdir(agentDir, { recursive: true });
	const keyPath = path.join(agentDir, KEY_FILE_NAME);

	try {
		const encodedKey = await Bun.file(keyPath).text();
		const key = parseKey(encodedKey);
		if (!key) throw new Error("Secret vault key file is not a 32-byte base64 key");
		await fs.chmod(keyPath, 0o600);
		return { key, backend: "file", keyMaterialToRedact: key.toString("base64") };
	} catch (err) {
		if (!isEnoent(err)) throw err;
	}

	const key = crypto.randomBytes(32);
	const keyMaterialToRedact = key.toString("base64");
	await Bun.write(keyPath, keyMaterialToRedact);
	await fs.chmod(keyPath, 0o600);
	return { key, backend: "file", keyMaterialToRedact };
}

async function loadMacosKey(): Promise<Buffer> {
	const existing = await $`security find-generic-password -s ${KEYCHAIN_SERVICE} -a ${KEYCHAIN_ACCOUNT} -w`
		.quiet()
		.nothrow();
	if (existing.exitCode === 0) {
		const key = parseKey(existing.text());
		if (!key) throw new Error("macOS keychain returned an invalid secret vault key");
		return key;
	}
	if (existing.exitCode !== MACOS_ITEM_NOT_FOUND_EXIT_CODE) {
		const detail = existing.stderr.toString().trim() || existing.text().trim();
		throw new Error(`macOS keychain lookup failed (exit ${existing.exitCode})${detail ? `: ${detail}` : ""}`);
	}

	const key = crypto.randomBytes(32);
	const created =
		await $`security add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${KEYCHAIN_ACCOUNT} -w ${key.toString("base64")}`
			.quiet()
			.nothrow();
	if (created.exitCode !== 0) throw new Error(created.text() || "security add-generic-password failed");
	return key;
}

async function runSecretTool(
	args: string[],
	input?: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const process = Bun.spawn(["secret-tool", ...args], {
		stdin: input === undefined ? "ignore" : new Blob([input]),
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		process.exited,
		new Response(process.stdout).text(),
		new Response(process.stderr).text(),
	]);
	return { exitCode, stdout, stderr };
}

async function loadLinuxKey(): Promise<Buffer | undefined> {
	if (!vaultKeychainRuntime.which("secret-tool")) return undefined;

	const existing = await runSecretTool(["lookup", "service", KEYCHAIN_SERVICE, "key", KEYCHAIN_ACCOUNT]);
	if (existing.exitCode === 0) {
		const key = parseKey(existing.stdout);
		if (!key) throw new Error("libsecret returned an invalid secret vault key");
		return key;
	}
	if (existing.exitCode !== LIBSECRET_ITEM_NOT_FOUND_EXIT_CODE || existing.stderr.trim()) {
		const detail = existing.stderr.trim() || existing.stdout.trim();
		throw new Error(`libsecret lookup failed (exit ${existing.exitCode})${detail ? `: ${detail}` : ""}`);
	}

	const key = crypto.randomBytes(32);
	const stored = await runSecretTool(
		["store", "--label=OMPx secret vault key", "service", KEYCHAIN_SERVICE, "key", KEYCHAIN_ACCOUNT],
		key.toString("base64"),
	);
	if (stored.exitCode !== 0) throw new Error(stored.stderr || "secret-tool store failed");
	return key;
}

async function fallbackAfterCredentialStoreFailure(
	agentDir: string,
	backend: Exclude<VaultKeyBackend, "file">,
	error: unknown,
): Promise<VaultKey> {
	// An existing key file IS the key this vault was encrypted with: the OS
	// credential store already failed on an earlier run and the file backend
	// took over. Refusing it here would strand a perfectly readable vault on
	// every headless box (no D-Bus session keyring => `secret-tool store`
	// fails with "Object does not exist at path .../collection/login").
	const existingFileKey = await Bun.file(path.join(agentDir, KEY_FILE_NAME))
		.text()
		.then(parseKey)
		.catch(() => undefined);
	if (existingFileKey) {
		logger.warn("Secret vault credential store unavailable; using existing file key", {
			backend,
			error: String(error),
		});
		return { key: existingFileKey, backend: "file", keyMaterialToRedact: existingFileKey.toString("base64") };
	}
	// No local key material: a vault encrypted under the unreachable credential
	// store must NOT be re-keyed, or the next write destroys it.
	if (await Bun.file(path.join(agentDir, VAULT_FILE_NAME)).exists()) {
		throw new VaultKeyRetrievalError(backend, error);
	}
	logger.warn("Secret vault credential store unavailable; using file key", {
		backend,
		error: String(error),
	});
	return loadFileKey(agentDir);
}

export async function loadOrCreateVaultKey(agentDir: string): Promise<VaultKey> {
	const platform = vaultKeychainRuntime.platform();
	if (platform === "darwin") {
		try {
			const key = await vaultKeychainRuntime.loadMacosKey();
			return { key, backend: "keychain", keyMaterialToRedact: key.toString("base64") };
		} catch (error) {
			return fallbackAfterCredentialStoreFailure(agentDir, "keychain", error);
		}
	}
	if (platform === "linux") {
		try {
			const key = await vaultKeychainRuntime.loadLinuxKey();
			if (key) return { key, backend: "libsecret", keyMaterialToRedact: key.toString("base64") };
		} catch (error) {
			return fallbackAfterCredentialStoreFailure(agentDir, "libsecret", error);
		}
	}
	return loadFileKey(agentDir);
}
