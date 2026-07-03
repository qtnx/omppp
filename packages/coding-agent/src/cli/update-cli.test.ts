import { afterEach, describe, expect, it, vi } from "bun:test";
import { runUpdateCommand } from "./update-cli";

type FetchInput = string | URL | Request;
type FetchInit = RequestInit | BunFetchRequestInit;

describe("runUpdateCommand fetch cancellation", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("checks release metadata with a timeout signal", async () => {
		let requestSignal: AbortSignal | undefined;
		let requestUrl: string | undefined;
		vi.spyOn(console, "log").mockImplementation(() => {});
		const fetchStub = Object.assign(
			async (input: FetchInput, init?: FetchInit) => {
				requestUrl = String(input);
				requestSignal = init?.signal ?? undefined;
				return Response.json([{ tag_name: "v999.0.0", draft: false, prerelease: false }]);
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchStub);

		await runUpdateCommand({ force: false, check: true });
		expect(requestUrl).toBe("https://api.github.com/repos/qtnx/omppp/releases?per_page=100");

		expect(requestSignal).toBeInstanceOf(AbortSignal);
	});
});
