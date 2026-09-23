import { ProductPreviewShareController } from "./share";
import type { ShareController, StartPreviewServer } from "./types";

export { PreviewCommentStore } from "./comments";
export { formatPreviewFeedback } from "./feedback";
export * from "./types";

/** Creates the production share controller for human-gated CLI and slash callers. */
export function makeShareController(): ShareController {
	return new ProductPreviewShareController();
}

/**
 * Starts the public preview server with the embedded client and filesystem scanner.
 * The server, scanner, and client assets load on first start: the embedded client
 * (mermaid, the canvas app, marked, …) is ~5 MB of strings every session would
 * otherwise hold from startup, since the slash command and `present` tool
 * register this module eagerly.
 */
export const startPreviewServer: StartPreviewServer = async options => {
	const [{ CLIENT_ASSETS }, { scanBundle }, { createPreviewServer }] = await Promise.all([
		import("./client/assets"),
		import("./scan"),
		import("./server"),
	]);
	return await createPreviewServer(options ?? {}, { clientAssets: CLIENT_ASSETS, scan: scanBundle });
};
