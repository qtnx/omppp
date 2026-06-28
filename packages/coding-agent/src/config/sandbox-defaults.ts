// Trusted file/directory paths the sandbox may allow by default. These are
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

// Linux Podman bind mounts are a stronger host-filesystem exposure than macOS
// Seatbelt allow rules, so start with no extra developer cache mounts. Users can
// explicitly add trusted paths via `sandbox.linux.allowedPaths` / `--sandbox-add-dir`.
export const DEFAULT_LINUX_SANDBOX_ALLOWED_PATHS: string[] = [];

// Default dev OCI image for Linux Podman workspace sandboxing. This matches the
// root Dockerfile/package script (`bun run pi:image`) so source checkouts can
// build a known-good image locally, while installs may override it to a registry
// image via `PI_OMPX_PODMAN_IMAGE` or `sandbox.podman.image`.
export const DEFAULT_LINUX_PODMAN_IMAGE = "oh-my-pi/pi:dev";
