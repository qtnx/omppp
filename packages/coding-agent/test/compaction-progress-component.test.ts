import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { CompactionProgressComponent } from "@oh-my-pi/pi-coding-agent/modes/components/compaction-progress";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

// Strip ANSI SGR escapes so assertions target the visible text the component emits.
const ANSI = /\x1b\[[0-9;]*m/g;
function plain(component: CompactionProgressComponent, width = 80): string {
	return component.render(width).join("\n").replace(ANSI, "");
}

describe("CompactionProgressComponent", () => {
	beforeAll(() => {
		// The component pulls spinner frames + colors from the active theme.
		initTheme();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it("renders the label and an indeterminate bar with no percentage", () => {
		const component = new CompactionProgressComponent("Auto-compacting context");
		const line = plain(component);
		expect(line).toContain("Auto-compacting context");
		// Indeterminate bar => dotted placeholder, never a percentage.
		expect(line).not.toContain("%");
		expect(line).toContain("·");
		component.stop();
	});

	it("shows the ~N tok counter only after a progress update with bytes>0", () => {
		const component = new CompactionProgressComponent("Compacting");
		// No streamed payload yet -> no token counter.
		expect(plain(component)).not.toContain("tok");
		component.update({ events: 1, bytes: 400, estTokens: 100 });
		const line = plain(component);
		expect(line).toContain("tok");
		expect(line).toContain("100");
		component.stop();
	});

	it("suppresses the token counter when an update carries zero bytes", () => {
		const component = new CompactionProgressComponent("Compacting");
		component.update({ events: 2, bytes: 0 });
		expect(plain(component)).not.toContain("tok");
		component.stop();
	});

	it("advances the m:ss timer as elapsed advances", () => {
		const component = new CompactionProgressComponent("Compacting");
		expect(plain(component)).toContain("0:00");
		component.setElapsed(65_000);
		expect(plain(component)).toContain("1:05");
		component.stop();
	});

	it("ticks the local timer every second even with no progress events", () => {
		vi.useFakeTimers();
		const component = new CompactionProgressComponent("Compacting");
		component.start();
		expect(plain(component)).toContain("0:00");
		vi.advanceTimersByTime(3000);
		const line = plain(component);
		expect(line).not.toContain("0:00");
		expect(line).toContain("0:03");
		component.stop();
	});

	it("stop() clears the interval so no further ticks fire and it does not throw", () => {
		vi.useFakeTimers();
		const component = new CompactionProgressComponent("Compacting");
		component.start();
		vi.advanceTimersByTime(2000);
		const frozen = plain(component);
		expect(frozen).toContain("0:02");
		component.stop();
		// After stop the timer is dead: advancing time must not tick or throw.
		expect(() => vi.advanceTimersByTime(10_000)).not.toThrow();
		expect(plain(component)).toBe(frozen);
	});
});
