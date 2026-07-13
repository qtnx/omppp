import { CLIENT_ASSETS } from "./client/assets";
import { scanBundle } from "./scan";
import { createPreviewServer } from "./server";
import { ProductPreviewShareController } from "./share";
import type { ShareController, StartPreviewServer } from "./types";

export { PreviewCommentStore } from "./comments";
export { formatPreviewFeedback } from "./feedback";
export * from "./types";

/** Creates the production share controller for human-gated CLI and slash callers. */
export function makeShareController(): ShareController {
	return new ProductPreviewShareController();
}

/** Starts the public preview server with the embedded client and filesystem scanner. */
export const startPreviewServer: StartPreviewServer = async options =>
	await createPreviewServer(options ?? {}, { clientAssets: CLIENT_ASSETS, scan: scanBundle });
