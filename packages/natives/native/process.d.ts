/** Return whether a process is currently running, loading the native addon on first use. */
export declare function isProcessRunning(pid: number): boolean;

/** Wait for a process to exit, loading the native addon on first use. */
export declare function waitForProcessExit(pid: number, signal?: AbortSignal): Promise<boolean>;

/** Terminate a process tree, loading the native addon on first use. */
export declare function terminateProcess(pid: number): Promise<boolean> | undefined;
