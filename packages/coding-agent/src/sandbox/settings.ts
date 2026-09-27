import { register } from "../config/registry";
import {
	DEFAULT_LINUX_PODMAN_IMAGE,
	DEFAULT_LINUX_SANDBOX_ALLOWED_PATHS,
	DEFAULT_MACOS_SANDBOX_ALLOWED_PATHS,
} from "../config/sandbox-defaults";

export const cfgSandboxAllowedPaths = register({
	id: "sandbox.allowedPaths",
	type: "array",
	default: DEFAULT_MACOS_SANDBOX_ALLOWED_PATHS,
	ui: {
		tab: "tools",
		group: "Execution",
		label: "macOS Sandbox Allowlist",
		description:
			"Trusted file or directory paths the macOS sandbox may read/write. Supports ~. Only user/global config is trusted for sandboxing; project settings cannot widen the sandbox.",
	},
});

export const cfgSandboxLinuxAllowedPaths = register({
	id: "sandbox.linux.allowedPaths",
	type: "array",
	default: DEFAULT_LINUX_SANDBOX_ALLOWED_PATHS,
	ui: {
		tab: "tools",
		group: "Execution",
		label: "Linux Podman Sandbox Allowlist",
		description:
			"Trusted file or directory paths the Linux Podman sandbox may bind-mount read/write. Supports ~. Empty by default; only user/global config is trusted for sandboxing.",
	},
});

export const cfgSandboxPodmanEnabled = register({
	id: "sandbox.podman.enabled",
	type: "boolean",
	default: false,
	ui: {
		tab: "tools",
		group: "Execution",
		label: "Linux Podman Sandbox",
		description:
			"Run top-level OMPx sessions inside a rootless Podman container on Linux. Disabled by default; uses the default dev image unless sandbox.podman.image or PI_OMPX_PODMAN_IMAGE overrides it. Only trusted user/global config is honored; project settings cannot enable the sandbox.",
	},
});

export const cfgSandboxPodmanImage = register({
	id: "sandbox.podman.image",
	type: "string",
	default: DEFAULT_LINUX_PODMAN_IMAGE,
	ui: {
		tab: "tools",
		group: "Execution",
		label: "Linux Podman Image",
		description: `Trusted OCI image containing the matching OMPx CLI used for Linux Podman workspace sandboxing. Defaults to ${DEFAULT_LINUX_PODMAN_IMAGE}. Only trusted user/global config is honored for sandbox bootstrap; project settings cannot override it.`,
	},
});

export const cfgSandboxSshAuthSock = register({
	id: "sandbox.sshAuthSock",
	type: "string",
	default: undefined,
	ui: {
		tab: "tools",
		group: "Execution",
		label: "macOS Sandbox SSH Agent Socket",
		description:
			"macOS sandbox SSH agent socket for git/ssh. Leave empty to auto-discover the running agent (1Password, Secretive, launchd, or ssh-agent) when SSH_AUTH_SOCK isn't inherited; set an explicit socket path to override (supports ~); set to `off` to disable. Only user/global config is trusted; also settable via the PI_OMPX_SSH_AUTH_SOCK env var.",
	},
});
