import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	downloadReleaseAsset,
	fetchLatestReleaseInfo,
	getChecksumForAsset,
	releaseAssetUrl,
	releaseInfoFromTag,
} from "../src/cli/update-release";

interface FetchCall {
	url: string;
	init: RequestInit | undefined;
}

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ompx-release-update-test-"));
	tempDirs.push(dir);
	return dir;
}

function responseJson(data: unknown, init?: ResponseInit): Response {
	return new Response(JSON.stringify(data), {
		...init,
		headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
	});
}

async function sha256Hex(text: string): Promise<string> {
	const bytes = new TextEncoder().encode(text);
	const buffer = new ArrayBuffer(bytes.byteLength);
	new Uint8Array(buffer).set(bytes);
	const digest = await crypto.subtle.digest("SHA-256", buffer);
	return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("release update metadata", () => {
	it("selects the highest stable GitHub release tag as the update version source", async () => {
		const calls: FetchCall[] = [];
		const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const url = String(input);
			calls.push({ url, init });
			if (url.endsWith("/releases?per_page=100")) {
				return responseJson(
					[
						{ tag_name: "v15.9.9" },
						{ tag_name: "v99.0.0", prerelease: true },
						{ tag_name: "v100.0.0", draft: true },
						{ tag_name: "latest" },
					],
					{ headers: { Link: '<https://api.github.com/page-2>; rel="next"' } },
				);
			}
			if (url === "https://api.github.com/page-2") {
				return responseJson([{ tag_name: "v15.10.1" }]);
			}
			throw new Error(`Unexpected URL: ${url}`);
		};

		const release = await fetchLatestReleaseInfo(fetchImpl);

		expect(release).toEqual({ tag: "v15.10.1", version: "15.10.1" });
		expect(calls).toHaveLength(2);
		expect(calls[0]?.url).toBe("https://api.github.com/repos/qtnx/omppp/releases?per_page=100");
		const headers = new Headers(calls[0]?.init?.headers);
		expect(headers.get("Accept")).toBe("application/vnd.github+json");
		expect(headers.get("User-Agent")).toBe("ompx-update");
	});

	it("rejects release tags that do not contain a semver version", () => {
		expect(() => releaseInfoFromTag("latest")).toThrow("does not contain a valid semver version");
	});
});

describe("release update assets", () => {
	it("builds release asset URLs from the exact GitHub tag", () => {
		expect(releaseAssetUrl("v15.10.1", "ompx-linux-x64")).toBe(
			"https://github.com/qtnx/omppp/releases/download/v15.10.1/ompx-linux-x64",
		);
	});

	it("selects the checksum for the requested binary asset", () => {
		const linuxHash = "a".repeat(64);
		const windowsHash = "b".repeat(64);

		expect(
			getChecksumForAsset(
				`${linuxHash}  ompx-linux-x64\n${windowsHash} *ompx-windows-x64.exe\n`,
				"ompx-windows-x64.exe",
			),
		).toBe(windowsHash);
	});

	it("rejects ambiguous or malformed checksum manifests", () => {
		const hash = "a".repeat(64);
		expect(() => getChecksumForAsset(`${hash}  ompx-linux-x64\n${hash}  ompx-linux-x64\n`, "ompx-linux-x64")).toThrow(
			"duplicate entries",
		);
		expect(() => getChecksumForAsset(`${hash}  ompx-linux-x64 extra\n`, "ompx-linux-x64")).toThrow(
			"Malformed SHA256SUMS line",
		);
	});

	it("downloads a binary only when its SHA256SUMS entry matches", async () => {
		const dir = await makeTempDir();
		const tempPath = path.join(dir, "ompx.new");
		const payload = "binary payload";
		const binary = new TextEncoder().encode(payload);
		const checksum = await sha256Hex(payload);
		const urls: string[] = [];
		const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
			const url = String(input);
			urls.push(url);
			if (url.endsWith("/SHA256SUMS")) return new Response(`${checksum}  ompx-linux-x64\n`);
			if (url.endsWith("/ompx-linux-x64")) return new Response(binary);
			throw new Error(`Unexpected URL: ${url}`);
		};

		await downloadReleaseAsset({
			release: { tag: "v15.10.1", version: "15.10.1" },
			binaryName: "ompx-linux-x64",
			tempPath,
			fetchImpl,
		});

		expect(await Bun.file(tempPath).text()).toBe("binary payload");
		expect(urls).toEqual([
			"https://github.com/qtnx/omppp/releases/download/v15.10.1/SHA256SUMS",
			"https://github.com/qtnx/omppp/releases/download/v15.10.1/ompx-linux-x64",
		]);
	});

	it("removes the downloaded binary when its checksum does not match", async () => {
		const dir = await makeTempDir();
		const tempPath = path.join(dir, "ompx.new");
		const binary = new TextEncoder().encode("tampered payload");
		const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
			const url = String(input);
			if (url.endsWith("/SHA256SUMS")) return new Response(`${"0".repeat(64)}  ompx-linux-x64\n`);
			if (url.endsWith("/ompx-linux-x64")) return new Response(binary);
			throw new Error(`Unexpected URL: ${url}`);
		};

		await expect(
			downloadReleaseAsset({
				release: { tag: "v15.10.1", version: "15.10.1" },
				binaryName: "ompx-linux-x64",
				tempPath,
				fetchImpl,
			}),
		).rejects.toThrow("checksum mismatch");
		expect(await Bun.file(tempPath).exists()).toBe(false);
	});
});
