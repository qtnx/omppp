/**
 * `ompx annotate` implementation: write the embedded OMPx Annotate Chrome
 * extension to disk and print the load-unpacked steps. Standalone CLI command —
 * console output here is intentional user-facing output.
 *
 * Chrome has no API for installing an unpacked extension from outside the
 * browser, so the user still loads the folder once via chrome://extensions.
 */
import * as path from "node:path";
import { getAnnotateExtensionDir } from "@oh-my-pi/pi-utils";
import backgroundJs from "../tools/browser/annotate-extension-assets/background.js.txt" with { type: "text" };
import contentJs from "../tools/browser/annotate-extension-assets/content.js.txt" with { type: "text" };
import manifestJson from "../tools/browser/annotate-extension-assets/manifest.json.txt" with { type: "text" };
import popupHtml from "../tools/browser/annotate-extension-assets/popup.html.txt" with { type: "text" };
import popupJs from "../tools/browser/annotate-extension-assets/popup.js.txt" with { type: "text" };

export const ANNOTATE_ACTIONS = ["install"] as const;
export type AnnotateAction = (typeof ANNOTATE_ACTIONS)[number];

export interface AnnotateCommandArgs {
	action: AnnotateAction;
	/** Install target directory; defaults to ~/.omp/annotate/extension. */
	dir?: string;
}

const EXTENSION_FILES: Record<string, string> = {
	"background.js": backgroundJs,
	"content.js": contentJs,
	"manifest.json": manifestJson,
	"popup.html": popupHtml,
	"popup.js": popupJs,
};

export async function runAnnotateCommand(args: AnnotateCommandArgs): Promise<void> {
	const dir = args.dir ? path.resolve(args.dir) : path.join(getAnnotateExtensionDir(), "extension");
	for (const name in EXTENSION_FILES) {
		await Bun.write(path.join(dir, name), EXTENSION_FILES[name]!);
	}
	console.log(`Installed the OMPx Annotate extension to ${dir}`);
	console.log("");
	console.log("Finish setup in Chrome:");
	console.log("  1. Open chrome://extensions and enable Developer mode.");
	console.log(`  2. Click "Load unpacked" and select: ${dir}`);
	console.log("  3. In ompx run `/annotate on`, then paste the host and pairing code into the extension popup.");
	console.log("");
	console.log("Toggle the overlay with Cmd+. (macOS) / Ctrl+. — rebind at chrome://extensions/shortcuts if needed.");
	console.log("Re-run this command after updating ompx, then click Reload on the extension card.");
}
