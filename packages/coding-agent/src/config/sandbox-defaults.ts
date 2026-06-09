// Trusted file/directory paths the macOS sandbox allows by default. These are
// developer-experience paths (shared toolchain caches + git identity) plus the
// kube config file. Directories are made read/write so package managers and
// build tools can reuse their caches; single config files stay file-scoped.
// Override per machine via the `sandbox.allowedPaths` setting (user/global config).
export const DEFAULT_MACOS_SANDBOX_ALLOWED_PATHS: string[] = [
	"~/.gitconfig",
	"~/.bun/install/cache",
	"~/.cargo",
	"~/go",
	"~/.cache",
	"~/.kube/config",
];
