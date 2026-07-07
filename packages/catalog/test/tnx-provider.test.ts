import { describe, expect, test } from "bun:test";
import { PROVIDER_DESCRIPTORS } from "@oh-my-pi/pi-catalog/provider-models";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

const TNX_BASE_URL = "http://codemc:20128/v1";

describe("TNX provider discovery", () => {
	test("discovers OpenAI-compatible models from the TNX default runtime endpoint", async () => {
		const calls: string[] = [];
		const fetchMock: FetchImpl = async (input: string | URL | Request) => {
			calls.push(String(input));
			return new Response(JSON.stringify({ data: [{ id: "tnx-model", object: "model" }] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		};

		const descriptor = PROVIDER_DESCRIPTORS.find(item => item.providerId === "tnx");
		expect(descriptor).toBeDefined();

		const options = descriptor?.createModelManagerOptions({ apiKey: "token", fetch: fetchMock });
		const models = await options?.fetchDynamicModels?.();

		expect(options?.providerId).toBe("tnx");
		expect(calls).toEqual([`${TNX_BASE_URL}/models`]);
		expect(models?.find(model => model.id === "tnx-model")).toMatchObject({
			id: "tnx-model",
			provider: "tnx",
			baseUrl: TNX_BASE_URL,
			input: ["text"],
		});
	});
});
