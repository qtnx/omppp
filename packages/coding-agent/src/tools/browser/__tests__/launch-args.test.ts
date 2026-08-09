import { describe, expect, it } from "bun:test";
import { buildHeadlessLaunchArgs } from "../launch";

describe("buildHeadlessLaunchArgs", () => {
	it("includes Vulkan GPU and unsafe SwiftShader flags when gpu is true", () => {
		const args = buildHeadlessLaunchArgs({ width: 1234, height: 567 }, true);

		expect(args).toContain("--no-sandbox");
		expect(args).toContain("--window-size=1234,567");
		expect(args).toContain("--enable-unsafe-swiftshader");
		expect(args).toContain("--use-angle=vulkan");
		expect(args).toContain("--enable-features=Vulkan");
		expect(args).toContain("--disable-vulkan-surface");
	});

	it("keeps unsafe SwiftShader fallback without Vulkan GPU flags when gpu is false", () => {
		const args = buildHeadlessLaunchArgs({ width: 800, height: 600 }, false);

		expect(args).toContain("--no-sandbox");
		expect(args).toContain("--window-size=800,600");
		expect(args).toContain("--enable-unsafe-swiftshader");
		expect(args).not.toContain("--use-angle=vulkan");
		expect(args).not.toContain("--enable-features=Vulkan");
		expect(args).not.toContain("--disable-vulkan-surface");
	});
});
