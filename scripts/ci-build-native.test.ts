import { describe, expect, it } from "bun:test";
import { withoutSccacheWrappers } from "./bazel-natives";
import { resolveNativeTargets, withPortableNativeBuildEnv } from "./ci-build-native";

describe("ci native target resolution", () => {
	const mappings = [
		{
			name: "linux x64 baseline",
			env: { TARGET_PLATFORM: "linux", TARGET_ARCH: "x64", TARGET_VARIANTS: "baseline" },
			targets: ["linux-x64-baseline"],
		},
		{
			name: "linux x64 modern",
			env: { TARGET_PLATFORM: "linux", TARGET_ARCH: "x64", TARGET_VARIANTS: "modern" },
			targets: ["linux-x64-modern"],
		},
		{
			name: "linux arm64",
			env: { TARGET_PLATFORM: "linux", TARGET_ARCH: "arm64", TARGET_VARIANTS: "" },
			targets: ["linux-arm64"],
		},
		{
			name: "linux musl x64 baseline",
			env: {
				TARGET_PLATFORM: "linux",
				TARGET_ARCH: "x64",
				TARGET_VARIANTS: "baseline",
				LIBC: "musl",
			},
			targets: ["linux-musl-x64-baseline"],
		},
		{
			name: "linux musl arm64",
			env: { TARGET_PLATFORM: "linux", TARGET_ARCH: "arm64", TARGET_VARIANTS: "", LIBC: "musl" },
			targets: ["linux-musl-arm64"],
		},
		{
			name: "darwin x64 baseline",
			env: { TARGET_PLATFORM: "darwin", TARGET_ARCH: "x64", TARGET_VARIANTS: "baseline" },
			targets: ["darwin-x64-baseline"],
		},
		{
			name: "darwin arm64",
			env: { TARGET_PLATFORM: "darwin", TARGET_ARCH: "arm64", TARGET_VARIANTS: "" },
			targets: ["darwin-arm64"],
		},
		{
			name: "win32 x64 baseline",
			env: { TARGET_PLATFORM: "win32", TARGET_ARCH: "x64", TARGET_VARIANTS: "baseline" },
			targets: ["win32-x64-baseline"],
		},
	] as const;

	for (const { name, env, targets } of mappings) {
		it(`resolves ${name}`, () => {
			expect(resolveNativeTargets(env)).toEqual(targets);
		});
	}

	it("resolves disjoint x64 variants together", () => {
		expect(
			resolveNativeTargets({
				TARGET_PLATFORM: "linux",
				TARGET_ARCH: "x64",
				TARGET_VARIANTS: "baseline modern",
			}),
		).toEqual(["linux-x64-baseline", "linux-x64-modern"]);
	});

	it("rejects an unmappable platform and architecture pair with the received environment", () => {
		expect(() =>
			resolveNativeTargets({
				CROSS_TARGET: "aarch64-pc-windows-msvc",
				TARGET_PLATFORM: "win32",
				TARGET_ARCH: "arm64",
				TARGET_VARIANTS: "baseline",
			}),
		).toThrow(/Cannot map CI native target.*TARGET_PLATFORM.*win32.*TARGET_ARCH.*arm64/s);
	});

	it("drops host sccache wrappers so bazel lockfile generation cannot inherit them", () => {
		expect(
			withPortableNativeBuildEnv({
				RUSTC_WRAPPER: "sccache",
				CMAKE_C_COMPILER_LAUNCHER: "sccache",
				CMAKE_CXX_COMPILER_LAUNCHER: "sccache",
				PATH: "/usr/bin",
			}),
		).toEqual({
			PATH: "/usr/bin",
			PCRE2_SYS_STATIC: "1",
		});
	});

	it("keeps a non-sccache rustc wrapper and unrelated env", () => {
		expect(
			withoutSccacheWrappers({
				RUSTC_WRAPPER: "sccache",
				CMAKE_C_COMPILER_LAUNCHER: "ccache",
				PATH: "/usr/bin",
			}),
		).toEqual({
			CMAKE_C_COMPILER_LAUNCHER: "ccache",
			PATH: "/usr/bin",
		});
	});
});
