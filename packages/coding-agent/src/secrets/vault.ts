import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent, logger } from "@oh-my-pi/pi-utils";
import { loadOrCreateVaultKey, type VaultKey, type VaultKeyBackend, VaultKeyRetrievalError } from "./keychain";
import type { SecretEntry } from "./obfuscator";
import { MIN_OBFUSCATE_SECRET_LEN } from "./placeholder";

export type { VaultKeyBackend } from "./keychain";

export type VaultSecretSource = "user" | "detected" | "tag";

export interface VaultSecretMeta {
	name: string;
	mask: string;
	length: number;
	source: VaultSecretSource;
	createdAt: string;
}

export interface SecretVaultLike {
	list(): VaultSecretMeta[];
	get(name: string): string | undefined;
	set(name: string, value: string, source: VaultSecretSource): Promise<string>;
	remove(name: string): Promise<boolean>;
	env(): Record<string, string>;
	toSecretEntries(): SecretEntry[];
	readonly keyBackend: VaultKeyBackend;
	/** Raw key material registered as a one-way replace-mode secret so a model-issued keychain/CLI read cannot exfiltrate it. */
	readonly keyMaterialToRedact: string;
}

interface StoredSecret {
	value: string;
	source: VaultSecretSource;
	createdAt: string;
}

interface VaultPayload {
	secrets: Record<string, StoredSecret>;
}

interface VaultFile {
	version: 1;
	alg: "aes-256-gcm";
	iv: string;
	tag: string;
	data: string;
}

const VAULT_FILE_NAME = "secrets.vault";
// A degraded vault has no readable real key. This inert value only prevents an empty replace-mode entry.
const DEGRADED_VAULT_INERT_KEY_MATERIAL = Buffer.alloc(32).toString("base64");

export function normalizeSecretName(raw: string): string {
	let normalized = raw
		.toUpperCase()
		.replace(/[^A-Z0-9]+/g, "_")
		.replace(/_+/g, "_");
	if (!normalized) return "SECRET";
	if (!/^[A-Z_]/.test(normalized)) normalized = `_${normalized}`;
	return normalized.slice(0, 64) || "SECRET";
}

export function maskSecretValue(value: string): string {
	if (value.length >= 16) return `${value.slice(0, 4)}…${value.slice(-4)}`;
	if (value.length >= 12) return `${value.slice(0, 2)}…${value.slice(-2)}`;
	return "••••";
}

export function vaultSecretEntry(name: string, value: string): SecretEntry {
	return {
		type: "plain",
		content: value,
		mode: value.length >= MIN_OBFUSCATE_SECRET_LEN ? "obfuscate" : "replace",
		friendlyName: name,
	};
}

function parseVaultPayload(value: unknown): VaultPayload {
	if (!value || typeof value !== "object" || Array.isArray(value) || !("secrets" in value)) {
		throw new Error("Vault payload is not an object");
	}
	const { secrets } = value;
	if (!secrets || typeof secrets !== "object" || Array.isArray(secrets))
		throw new Error("Vault payload has no secrets object");

	const parsed: Record<string, StoredSecret> = {};
	for (const [name, secret] of Object.entries(secrets)) {
		if (
			!secret ||
			typeof secret !== "object" ||
			Array.isArray(secret) ||
			!("value" in secret) ||
			!("source" in secret) ||
			!("createdAt" in secret)
		) {
			throw new Error("Vault secret is invalid");
		}
		const { value: secretValue, source, createdAt } = secret;
		if (
			typeof secretValue !== "string" ||
			(source !== "user" && source !== "detected" && source !== "tag") ||
			typeof createdAt !== "string"
		) {
			throw new Error("Vault secret fields are invalid");
		}
		parsed[name] = { value: secretValue, source, createdAt };
	}
	return { secrets: parsed };
}

function parseVaultFile(value: unknown): VaultFile {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		!("version" in value) ||
		!("alg" in value) ||
		!("iv" in value) ||
		!("tag" in value) ||
		!("data" in value)
	) {
		throw new Error("Vault file is not an object");
	}
	const { version, alg, iv, tag, data } = value;
	if (
		version !== 1 ||
		alg !== "aes-256-gcm" ||
		typeof iv !== "string" ||
		typeof tag !== "string" ||
		typeof data !== "string"
	) {
		throw new Error("Vault file format is invalid");
	}
	return { version, alg, iv, tag, data };
}

function decryptVault(serialized: string, key: Buffer): VaultPayload {
	const file = parseVaultFile(JSON.parse(serialized));
	const iv = Buffer.from(file.iv, "base64");
	const tag = Buffer.from(file.tag, "base64");
	const data = Buffer.from(file.data, "base64");
	if (iv.length !== 12 || tag.length !== 16 || data.length === 0) throw new Error("Vault cipher fields are invalid");

	const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
	decipher.setAuthTag(tag);
	const plaintext = Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
	return parseVaultPayload(JSON.parse(plaintext));
}

function encryptVault(payload: VaultPayload, key: Buffer): VaultFile {
	const iv = crypto.randomBytes(12);
	const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
	const data = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
	return {
		version: 1,
		alg: "aes-256-gcm",
		iv: iv.toString("base64"),
		tag: cipher.getAuthTag().toString("base64"),
		data: data.toString("base64"),
	};
}

export class SecretVault implements SecretVaultLike {
	#agentDir: string;
	#key: Buffer | undefined;
	#secrets: Record<string, StoredSecret>;
	#degradedReason: string | undefined;
	readonly keyBackend: VaultKeyBackend;
	readonly keyMaterialToRedact: string;

	constructor(
		agentDir: string,
		key: Buffer | undefined,
		keyBackend: VaultKeyBackend,
		keyMaterialToRedact: string,
		secrets: Record<string, StoredSecret>,
		degradedReason?: string,
	) {
		this.#agentDir = agentDir;
		this.#key = key;
		this.keyBackend = keyBackend;
		this.keyMaterialToRedact = keyMaterialToRedact;
		this.#secrets = secrets;
		this.#degradedReason = degradedReason;
	}

	static #degraded(
		agentDir: string,
		vaultPath: string,
		keyBackend: VaultKeyBackend,
		keyMaterialToRedact: string,
		cause: unknown,
	): SecretVault {
		const error = cause instanceof Error ? cause.message : String(cause);
		const reason = `Secret vault at ${vaultPath} is read-only because it could not be opened: ${error}; the original file was left untouched.`;
		logger.error("Secret vault is read-only because it could not be opened", { path: vaultPath, error });
		return new SecretVault(agentDir, undefined, keyBackend, keyMaterialToRedact, {}, reason);
	}

	static async open(agentDir: string): Promise<SecretVault> {
		const vaultPath = path.join(agentDir, VAULT_FILE_NAME);
		let vaultKey: VaultKey;
		try {
			vaultKey = await loadOrCreateVaultKey(agentDir);
		} catch (error) {
			const keyBackend = error instanceof VaultKeyRetrievalError ? error.backend : "file";
			if (error instanceof VaultKeyRetrievalError || (await Bun.file(vaultPath).exists())) {
				return SecretVault.#degraded(agentDir, vaultPath, keyBackend, DEGRADED_VAULT_INERT_KEY_MATERIAL, error);
			}
			throw error;
		}

		try {
			const secrets = decryptVault(await Bun.file(vaultPath).text(), vaultKey.key).secrets;
			return new SecretVault(agentDir, vaultKey.key, vaultKey.backend, vaultKey.keyMaterialToRedact, secrets);
		} catch (error) {
			if (isEnoent(error)) {
				return new SecretVault(agentDir, vaultKey.key, vaultKey.backend, vaultKey.keyMaterialToRedact, {});
			}
			return SecretVault.#degraded(agentDir, vaultPath, vaultKey.backend, vaultKey.keyMaterialToRedact, error);
		}
	}

	list(): VaultSecretMeta[] {
		return Object.entries(this.#secrets).map(([name, secret]) => ({
			name,
			mask: maskSecretValue(secret.value),
			length: secret.value.length,
			source: secret.source,
			createdAt: secret.createdAt,
		}));
	}

	get(name: string): string | undefined {
		return this.#secrets[normalizeSecretName(name)]?.value;
	}

	async set(name: string, value: string, source: VaultSecretSource): Promise<string> {
		this.#assertWritable();
		for (const [existingName, secret] of Object.entries(this.#secrets)) {
			if (secret.value === value) return existingName;
		}

		const baseName = normalizeSecretName(name);
		let finalName = baseName;
		let suffix = 2;
		while (this.#secrets[finalName]) {
			const suffixText = `_${suffix++}`;
			finalName = `${baseName.slice(0, 64 - suffixText.length)}${suffixText}`;
		}

		const secrets = {
			...this.#secrets,
			[finalName]: { value, source, createdAt: new Date().toISOString() },
		};
		await this.#persist(secrets);
		this.#secrets = secrets;
		return finalName;
	}

	async remove(name: string): Promise<boolean> {
		this.#assertWritable();
		const normalized = normalizeSecretName(name);
		if (!this.#secrets[normalized]) return false;
		const { [normalized]: _, ...secrets } = this.#secrets;
		await this.#persist(secrets);
		this.#secrets = secrets;
		return true;
	}

	env(): Record<string, string> {
		return Object.fromEntries(Object.entries(this.#secrets).map(([name, secret]) => [name, secret.value]));
	}

	toSecretEntries(): SecretEntry[] {
		return Object.entries(this.#secrets).map(([name, secret]) => vaultSecretEntry(name, secret.value));
	}

	#assertWritable(): void {
		if (this.#degradedReason) throw new Error(this.#degradedReason);
	}

	async #persist(secrets: Record<string, StoredSecret>): Promise<void> {
		const key = this.#key;
		if (!key) throw new Error("Secret vault has no encryption key");
		await fs.mkdir(this.#agentDir, { recursive: true });
		const vaultPath = path.join(this.#agentDir, VAULT_FILE_NAME);
		const temporaryPath = path.join(this.#agentDir, `.${VAULT_FILE_NAME}.${crypto.randomUUID()}.tmp`);
		try {
			await Bun.write(temporaryPath, JSON.stringify(encryptVault({ secrets }, key)));
			await fs.chmod(temporaryPath, 0o600);
			await fs.rename(temporaryPath, vaultPath);
			await fs.chmod(vaultPath, 0o600);
		} catch (err) {
			await fs.rm(temporaryPath, { force: true }).catch(() => {});
			throw err;
		}
	}
}
