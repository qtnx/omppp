import { afterEach, describe, expect, it, vi } from "bun:test";
import "@oh-my-pi/pi-coding-agent/utils/markit";
import { logger } from "@oh-my-pi/pi-utils";

interface MuPdfWasmModuleConfig {
	printErr?: (...values: unknown[]) => void;
}

describe("markit MuPDF warnings", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("routes recoverable PDF warnings to the file logger", () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const debug = vi.spyOn(logger, "debug").mockImplementation(() => undefined);
		const moduleConfig = globalThis.$libmupdf_wasm_Module as MuPdfWasmModuleConfig | undefined;

		moduleConfig?.printErr?.("Screen annotations are not supported");

		expect(consoleError).not.toHaveBeenCalled();
		expect(debug).toHaveBeenCalledWith("mupdf wasm output", {
			stream: "stderr",
			message: "Screen annotations are not supported",
		});
	});
});
