/**
 * Hand free native-heap pages back to the OS.
 *
 * The natives addon allocates through glibc malloc from dozens of Tokio and
 * Rayon threads, and glibc keeps every thread arena's freed chunks until
 * `malloc_trim` runs. One burst of parallel native work therefore pins its
 * peak for the rest of the process: 288 parallel `grep` calls left 853 MB
 * resident in 59 arenas, and `malloc_trim(0)` brought it back to 72 MB.
 * Long-running sessions measured ~110 arenas and ~175 MB of glibc heap each,
 * mostly swapped out. Mirrors the libc-FFI pattern in `process-name.ts`.
 */
import { dlopen, FFIType } from "bun:ffi";

type MallocTrim = (pad: bigint) => number;

let mallocTrim: MallocTrim | null | undefined;

function loadMallocTrim(): MallocTrim | null {
	// glibc only: musl has no `malloc_trim` and returns freed memory on its own.
	if (process.platform !== "linux") return null;
	try {
		const libc = dlopen("libc.so.6", { malloc_trim: { args: [FFIType.u64], returns: FFIType.i32 } });
		return pad => libc.symbols.malloc_trim(pad);
	} catch {
		return null;
	}
}

/**
 * Release free native-heap memory to the OS (`malloc_trim(0)` on Linux glibc).
 * Returns whether a trim ran; a no-op elsewhere. Never throws. Call it from an
 * idle point: it briefly locks each malloc arena while it walks the free lists.
 */
export function releaseNativeHeap(): boolean {
	if (mallocTrim === undefined) mallocTrim = loadMallocTrim();
	if (!mallocTrim) return false;
	try {
		mallocTrim(0n);
		return true;
	} catch {
		return false;
	}
}
