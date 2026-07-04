import { afterEach, describe, expect, it, vi } from "bun:test";
import { ConsultTool } from "../consult";
import type { ToolSession } from "../index";

function createToolSession(): ToolSession {
	return {
		consultAdvisor: async () => "blocking-answer",
		consultAdvisorAsync: () => true,
	} as unknown as ToolSession;
}

describe("ConsultTool", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("dispatches async consults without waiting for an advisor answer", async () => {
		const session = createToolSession();
		const blocking = vi.spyOn(session, "consultAdvisor");
		const asyncConsult = vi.spyOn(session, "consultAdvisorAsync");
		const tool = new ConsultTool(session);

		const result = await tool.execute("tc-1", { question: "background?", async: true });

		expect(asyncConsult).toHaveBeenCalledWith("background?");
		expect(blocking).not.toHaveBeenCalled();
		expect(result.useless).toBeUndefined();
		expect(result.content).toEqual([
			{
				type: "text",
				text: "Question dispatched to the advisor asynchronously — it will reply through an advisory note when ready. Keep working; do not block on it.",
			},
		]);
	});

	it("keeps omitted async on the existing blocking consult path", async () => {
		const session = createToolSession();
		const blocking = vi.spyOn(session, "consultAdvisor");
		const asyncConsult = vi.spyOn(session, "consultAdvisorAsync");
		const tool = new ConsultTool(session);

		const result = await tool.execute("tc-2", { question: "gate?" });

		expect(blocking).toHaveBeenCalledWith("gate?", undefined);
		expect(asyncConsult).not.toHaveBeenCalled();
		expect(result.content).toEqual([{ type: "text", text: "blocking-answer" }]);
	});
});
