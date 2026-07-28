import { loadNative } from "./loader-state.js";

/** Return whether a process is currently running, loading the native addon on first use. */
export function isProcessRunning(pid) {
	const { Process, ProcessStatus } = loadNative();
	return Process.fromPid(pid)?.status() === ProcessStatus.Running;
}

/** Wait for a process to exit, loading the native addon on first use. */
export async function waitForProcessExit(pid, signal) {
	const { Process } = loadNative();
	return (await Process.fromPid(pid)?.waitForExit({ signal })) ?? true;
}

/** Terminate a process tree, loading the native addon on first use. */
export function terminateProcess(pid) {
	const { Process } = loadNative();
	return Process.fromPid(pid)?.terminate();
}
