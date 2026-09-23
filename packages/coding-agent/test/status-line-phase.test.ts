import { beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { renderSegment } from "@oh-my-pi/pi-tui/status-line/segments";
import type { SegmentContext } from "@oh-my-pi/pi-tui/status-line/types";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

beforeAll(async () => {
	await initTheme();
});

function ctxWith(workPhase: SegmentContext["workPhase"]): SegmentContext {
	return { workPhase } as unknown as SegmentContext;
}

/** ANSI is irrelevant to the label; strip it before asserting. */
function plain(text: string): string {
	return stripVTControlCharacters(text);
}

describe("phase status-line segment", () => {
	it("renders the classified work phase", () => {
		const result = renderSegment("phase", ctxWith({ phase: "implementing", confidence: 0.92 }));

		expect(result.visible).toBe(true);
		expect(plain(result.content)).toBe("implementing");
	});

	it("stays hidden before the first classification and while signals are off", () => {
		const result = renderSegment("phase", ctxWith(null));

		expect(result.visible).toBe(false);
	});
});
