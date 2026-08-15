import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { vaultKeychainRuntime } from "../../src/secrets/keychain";
import { maskSecretValue, SecretVault, vaultSecretEntry } from "../../src/secrets/vault";

async function withAgentDir<T>(fn: (agentDir: string) => Promise<T>): Promise<T> {
	const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "secret-vault-"));
	try {
		return await fn(agentDir);
	} finally {
		await removeWithRetries(agentDir);
	}
}

describe("SecretVault", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("persists encrypted secrets across a fresh vault instance and removes them", async () => {
		await withAgentDir(async agentDir => {
			vi.spyOn(vaultKeychainRuntime, "platform").mockReturnValue("win32");
			const vault = await SecretVault.open(agentDir);

			expect(vault.keyBackend).toBe("file");
			await vault.set("github token", "ghp_0123456789abcdefghijklmnop", "user");
			await vault.set("openai", "sk-proj-abcdefghijklmnopqrstuvwxyz", "detected");

			const persisted = await Bun.file(path.join(agentDir, "secrets.vault")).text();
			expect(persisted).not.toContain("ghp_0123456789abcdefghijklmnop");
			expect(persisted).not.toContain("sk-proj-abcdefghijklmnopqrstuvwxyz");

			const reopened = await SecretVault.open(agentDir);
			expect(reopened.get("GITHUB_TOKEN")).toBe("ghp_0123456789abcdefghijklmnop");
			expect(reopened.env()).toEqual({
				GITHUB_TOKEN: "ghp_0123456789abcdefghijklmnop",
				OPENAI: "sk-proj-abcdefghijklmnopqrstuvwxyz",
			});
			expect(reopened.list()).toEqual([
				expect.objectContaining({ name: "GITHUB_TOKEN", source: "user", length: 30 }),
				expect.objectContaining({ name: "OPENAI", source: "detected", length: 34 }),
			]);
			expect(await reopened.remove("github token")).toBe(true);
			expect(await reopened.remove("github token")).toBe(false);
			expect((await SecretVault.open(agentDir)).get("GITHUB_TOKEN")).toBeUndefined();
		});
	});

	it("reuses the first name for an identical value without writing", async () => {
		await withAgentDir(async agentDir => {
			vi.spyOn(vaultKeychainRuntime, "platform").mockReturnValue("win32");
			const vault = await SecretVault.open(agentDir);
			await vault.set("PRIMARY", "same-secret-value", "user");
			const vaultPath = path.join(agentDir, "secrets.vault");
			const before = await Bun.file(vaultPath).text();

			expect(await vault.set("SECONDARY", "same-secret-value", "detected")).toBe("PRIMARY");
			expect(await Bun.file(vaultPath).text()).toBe(before);
			expect(vault.list()).toHaveLength(1);
		});
	});

	it("suffixes name collisions with distinct values", async () => {
		await withAgentDir(async agentDir => {
			vi.spyOn(vaultKeychainRuntime, "platform").mockReturnValue("win32");
			const vault = await SecretVault.open(agentDir);

			expect(await vault.set("api key", "first-value", "user")).toBe("API_KEY");
			expect(await vault.set("API_KEY", "second-value", "user")).toBe("API_KEY_2");
			expect(await vault.set("api key", "third-value", "user")).toBe("API_KEY_3");
		});
	});

	it.each([
		["12345678901", "••••"],
		["abcdefghijkl", "ab…kl"],
		["abcdefghijklmno", "ab…no"],
		["abcdefghijklmnop", "abcd…mnop"],
		["abcdefghijklmnopqrstuvwxyz1234567890ABCD", "abcd…ABCD"],
	])("masks values at length boundaries", (value, expected) => {
		expect(maskSecretValue(value)).toBe(expected);
	});

	it("opens a malformed vault as read-only without overwriting it", async () => {
		await withAgentDir(async agentDir => {
			vi.spyOn(vaultKeychainRuntime, "platform").mockReturnValue("win32");
			const vaultPath = path.join(agentDir, "secrets.vault");
			await Bun.write(vaultPath, "not encrypted data");

			const vault = await SecretVault.open(agentDir);
			expect(vault.list()).toEqual([]);
			await expect(vault.set("TOKEN", "replacement-secret", "user")).rejects.toThrow(
				/original file was left untouched/,
			);
			await expect(vault.remove("TOKEN")).rejects.toThrow(/original file was left untouched/);
			expect(await Bun.file(vaultPath).text()).toBe("not encrypted data");
		});
	});

	it("keeps a tampered vault read-only and leaves ciphertext bytes untouched", async () => {
		await withAgentDir(async agentDir => {
			vi.spyOn(vaultKeychainRuntime, "platform").mockReturnValue("win32");
			const vaultPath = path.join(agentDir, "secrets.vault");
			const vault = await SecretVault.open(agentDir);
			await vault.set("TOKEN", "original-secret-value", "user");

			const encrypted = JSON.parse(await Bun.file(vaultPath).text()) as { data: string };
			encrypted.data = `${encrypted.data.startsWith("A") ? "B" : "A"}${encrypted.data.slice(1)}`;
			await Bun.write(vaultPath, JSON.stringify(encrypted));
			const before = Buffer.from(await Bun.file(vaultPath).arrayBuffer());

			const reopened = await SecretVault.open(agentDir);
			expect(reopened.list()).toEqual([]);
			expect(reopened.get("TOKEN")).toBeUndefined();
			expect(reopened.env()).toEqual({});
			expect(reopened.toSecretEntries()).toEqual([]);
			await expect(reopened.set("TOKEN", "replacement-secret", "user")).rejects.toThrow(
				/original file was left untouched/,
			);
			const after = Buffer.from(await Bun.file(vaultPath).arrayBuffer());
			expect(after.equals(before)).toBe(true);
		});
	});

	it("opens a missing vault as writable after a keychain retrieval failure", async () => {
		await withAgentDir(async agentDir => {
			vi.spyOn(vaultKeychainRuntime, "platform").mockReturnValue("darwin");
			vi.spyOn(vaultKeychainRuntime, "loadMacosKey").mockRejectedValue(new Error("keychain locked"));
			const vaultPath = path.join(agentDir, "secrets.vault");
			expect(await Bun.file(vaultPath).exists()).toBe(false);

			const vault = await SecretVault.open(agentDir);
			expect(vault.keyBackend).toBe("file");
			expect(vault.list()).toEqual([]);
			await expect(vault.set("TOKEN", "new-secret-value", "user")).resolves.toBe("TOKEN");
			expect(await Bun.file(vaultPath).exists()).toBe(true);
		});
	});

	it("does not substitute a file key when a keychain lookup fails for an existing vault", async () => {
		await withAgentDir(async agentDir => {
			vi.spyOn(vaultKeychainRuntime, "platform").mockReturnValue("darwin");
			const key = Buffer.alloc(32, 0x17);
			const loadMacosKey = vi.spyOn(vaultKeychainRuntime, "loadMacosKey").mockResolvedValue(key);
			const vault = await SecretVault.open(agentDir);
			await vault.set("TOKEN", "original-secret-value", "user");

			const vaultPath = path.join(agentDir, "secrets.vault");
			const before = Buffer.from(await Bun.file(vaultPath).arrayBuffer());
			loadMacosKey.mockRejectedValueOnce(new Error("keychain locked"));

			const reopened = await SecretVault.open(agentDir);
			expect(reopened.keyBackend).toBe("keychain");
			expect(reopened.list()).toEqual([]);
			await expect(reopened.set("TOKEN", "replacement-secret", "user")).rejects.toThrow(
				/original file was left untouched/,
			);
			expect(await Bun.file(path.join(agentDir, "secret-vault.key")).exists()).toBe(false);
			const after = Buffer.from(await Bun.file(vaultPath).arrayBuffer());
			expect(after.equals(before)).toBe(true);
		});
	});

	it("reuses an existing file key when the credential store later becomes unavailable", async () => {
		// Headless Linux (no D-Bus session keyring) fails `secret-tool store` on
		// every run, so the file backend owns the key. A later process must reuse
		// that key instead of degrading a vault it can actually read.
		await withAgentDir(async agentDir => {
			vi.spyOn(vaultKeychainRuntime, "platform").mockReturnValue("linux");
			vi.spyOn(vaultKeychainRuntime, "loadLinuxKey").mockRejectedValue(new Error("secret-tool store failed"));

			const vault = await SecretVault.open(agentDir);
			expect(vault.keyBackend).toBe("file");
			await vault.set("TOKEN", "original-secret-value", "user");

			const reopened = await SecretVault.open(agentDir);
			expect(reopened.keyBackend).toBe("file");
			expect(reopened.get("TOKEN")).toBe("original-secret-value");
			await expect(reopened.set("OTHER", "another-secret-value", "user")).resolves.toBe("OTHER");
		});
	});

	it("registers raw key material for every backend", async () => {
		await withAgentDir(async agentDir => {
			vi.spyOn(vaultKeychainRuntime, "platform").mockReturnValue("win32");
			const fileVault = await SecretVault.open(agentDir);
			expect(Buffer.from(fileVault.keyMaterialToRedact, "base64")).toHaveLength(32);

			vi.spyOn(vaultKeychainRuntime, "platform").mockReturnValue("darwin");
			const key = Buffer.alloc(32, 0x31);
			vi.spyOn(vaultKeychainRuntime, "loadMacosKey").mockResolvedValue(key);
			const keychainVault = await SecretVault.open(path.join(agentDir, "keychain"));
			expect(keychainVault.keyBackend).toBe("keychain");
			expect(keychainVault.keyMaterialToRedact).toBe(key.toString("base64"));

			vi.spyOn(vaultKeychainRuntime, "platform").mockReturnValue("linux");
			const libsecretKey = Buffer.alloc(32, 0x42);
			vi.spyOn(vaultKeychainRuntime, "loadLinuxKey").mockResolvedValue(libsecretKey);
			const libsecretVault = await SecretVault.open(path.join(agentDir, "libsecret"));
			expect(libsecretVault.keyBackend).toBe("libsecret");
			expect(libsecretVault.keyMaterialToRedact).toBe(libsecretKey.toString("base64"));
		});
	});

	it("uses replace mode for managed values shorter than eight characters", () => {
		expect(vaultSecretEntry("LONG_TOKEN", "12345678")).toEqual({
			type: "plain",
			content: "12345678",
			mode: "obfuscate",
			friendlyName: "LONG_TOKEN",
		});
		expect(vaultSecretEntry("PIN", "1234567")).toEqual({
			type: "plain",
			content: "1234567",
			mode: "replace",
			friendlyName: "PIN",
		});
	});

	it("uses vaultSecretEntry for every managed secret", async () => {
		await withAgentDir(async agentDir => {
			vi.spyOn(vaultKeychainRuntime, "platform").mockReturnValue("win32");
			const vault = await SecretVault.open(agentDir);
			await vault.set("PIN", "1234567", "user");
			await vault.set("LONG_TOKEN", "12345678", "user");

			expect(vault.toSecretEntries()).toEqual([
				vaultSecretEntry("PIN", "1234567"),
				vaultSecretEntry("LONG_TOKEN", "12345678"),
			]);
		});
	});

	it("restricts vault and fallback key files to the owner", async () => {
		await withAgentDir(async agentDir => {
			vi.spyOn(vaultKeychainRuntime, "platform").mockReturnValue("win32");
			const vault = await SecretVault.open(agentDir);
			await vault.set("TOKEN", "owner-only-value", "tag");

			expect((await fs.stat(path.join(agentDir, "secrets.vault"))).mode & 0o777).toBe(0o600);
			expect((await fs.stat(path.join(agentDir, "secret-vault.key"))).mode & 0o777).toBe(0o600);
		});
	});
});
