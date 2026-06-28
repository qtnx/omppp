import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { getEmbeddedClientCacheRoot } from "@oh-my-pi/omp-stats/server";

describe("stats embedded client cache", () => {
	it("scopes the temp cache root by user id", () => {
		const root = getEmbeddedClientCacheRoot("/tmp", 1234);

		expect(root).toBe(path.join("/tmp", "omp-stats-client-1234"));
		expect(root).not.toBe(path.join("/tmp", "omp-stats-client"));
	});
});
