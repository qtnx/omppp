import * as fs from "node:fs/promises";
import { isCompiledBinary, logger } from "@oh-my-pi/pi-utils";

export interface BinarySignature {
	size: number;
	mtimeMs: number;
}

export interface BinaryUpdateNotice {
	path: string;
	currentVersion: string;
	installedVersion?: string;
}

export interface BinaryUpdateDetectorOptions {
	path: string;
	currentVersion: string;
	stat?: () => Promise<BinarySignature>;
	readInstalledVersion?: () => Promise<string | undefined>;
}

function sameSignature(a: BinarySignature, b: BinarySignature): boolean {
	return a.size === b.size && a.mtimeMs === b.mtimeMs;
}

function parseVersion(output: string): string | undefined {
	return output.match(/(?:^|\/)(\d+\.\d+\.\d+)(?:\s|$)/)?.[1];
}

async function statFile(filePath: string): Promise<BinarySignature> {
	const stat = await fs.stat(filePath);
	return { size: stat.size, mtimeMs: stat.mtimeMs };
}

async function readVersionFromBinary(filePath: string): Promise<string | undefined> {
	try {
		const proc = Bun.spawn([filePath, "--version"], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
		const output = await new Response(proc.stdout).text();
		const exitCode = await proc.exited;
		if (exitCode !== 0) return undefined;
		return parseVersion(output.trim());
	} catch (error) {
		logger.debug("Failed to read installed binary version", { path: filePath, error: String(error) });
		return undefined;
	}
}

export class BinaryUpdateDetector {
	readonly #path: string;
	readonly #currentVersion: string;
	readonly #stat: () => Promise<BinarySignature>;
	readonly #readInstalledVersion: () => Promise<string | undefined>;
	#knownSignature: BinarySignature | undefined;

	constructor(options: BinaryUpdateDetectorOptions) {
		this.#path = options.path;
		this.#currentVersion = options.currentVersion;
		this.#stat = options.stat ?? (() => statFile(options.path));
		this.#readInstalledVersion = options.readInstalledVersion ?? (() => readVersionFromBinary(options.path));
	}

	async check(): Promise<BinaryUpdateNotice | undefined> {
		let signature: BinarySignature;
		try {
			signature = await this.#stat();
		} catch (error) {
			logger.debug("Failed to stat installed binary", { path: this.#path, error: String(error) });
			return undefined;
		}

		if (!this.#knownSignature) {
			this.#knownSignature = signature;
			return undefined;
		}
		if (sameSignature(this.#knownSignature, signature)) return undefined;

		this.#knownSignature = signature;
		return {
			path: this.#path,
			currentVersion: this.#currentVersion,
			installedVersion: await this.#readInstalledVersion(),
		};
	}
}

export function createInstalledBinaryUpdateDetector(currentVersion: string): BinaryUpdateDetector | undefined {
	if (!isCompiledBinary()) return undefined;
	return new BinaryUpdateDetector({ path: process.execPath, currentVersion });
}
