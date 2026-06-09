// Keep entrypoint environment scrubbing separate from cli.ts so this side-effect
// module can run before broader CLI imports load pi-utils env overlays.
try {
	delete process.env.MallocStackLogging;
	delete process.env.MallocStackLoggingNoCompact;
} catch {}

if (!process.env.PI_OMPX_MACOS_SANDBOX_INHERITED?.trim()) {
	const inheritedMacOSSandbox = process.env.OMP_OMPX_MACOS_SANDBOX ?? process.env.PI_OMPX_MACOS_SANDBOX;
	process.env.PI_OMPX_MACOS_SANDBOX_INHERITED = inheritedMacOSSandbox?.trim() ? inheritedMacOSSandbox : "default";
}

if (!process.env.PI_OMPX_MACOS_SANDBOX_ACTIVE_INHERITED?.trim()) {
	process.env.PI_OMPX_MACOS_SANDBOX_ACTIVE_INHERITED = process.env.PI_OMPX_MACOS_SANDBOX_ACTIVE?.trim()
		? process.env.PI_OMPX_MACOS_SANDBOX_ACTIVE
		: "0";
}

if (!process.env.PI_OMPX_TRUSTED_CONFIG_DIR?.trim()) {
	process.env.PI_OMPX_TRUSTED_CONFIG_DIR = process.env.PI_CONFIG_DIR?.trim() ? process.env.PI_CONFIG_DIR : "default";
}
if (!process.env.PI_OMPX_TRUSTED_CODING_AGENT_DIR?.trim()) {
	process.env.PI_OMPX_TRUSTED_CODING_AGENT_DIR = process.env.PI_CODING_AGENT_DIR?.trim()
		? process.env.PI_CODING_AGENT_DIR
		: "default";
}
// Allow pointing the sandbox at an explicit agent socket when the launching
// context didn't export SSH_AUTH_SOCK (e.g. a supervisor that strips it). Runs
// before the trusted-capture below so the override flows through the trust model.
if (!process.env.SSH_AUTH_SOCK?.trim() && process.env.PI_OMPX_SSH_AUTH_SOCK?.trim()) {
	process.env.SSH_AUTH_SOCK = process.env.PI_OMPX_SSH_AUTH_SOCK;
}
if (!process.env.PI_OMPX_TRUSTED_SSH_AUTH_SOCK?.trim()) {
	process.env.PI_OMPX_TRUSTED_SSH_AUTH_SOCK = process.env.SSH_AUTH_SOCK?.trim()
		? process.env.SSH_AUTH_SOCK
		: "default";
}
