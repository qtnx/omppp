/// <reference path="./client-assets.d.ts" />
/**
 * Preview client static assets.
 *
 * Every client file (HTML/CSS/JS + the three vendor bundles) is text-imported
 * and exposed as a route → { body, contentType } map. The server (P2) consumes
 * this map verbatim — no bundler step, files are served byte-for-byte so that
 * CSP script-src 'self' is satisfied (vendor libs are same-origin, not CDN).
 *
 * Vendor copies under ./vendor are pinned to the installed packages: marked's
 * exports map blocks bare-specifier text imports of its UMD build, so all
 * three are committed and the "vendor bundles" drift test pins each copy
 * byte-for-byte to its node_modules dist source. Bump a dep → re-vendor.
 */

import type { ClientAssetMap } from "../types";
import clientJs from "./client.js" with { type: "text" };
import canvasCss from "./generated/canvas-app.css" with { type: "text" };
import canvasAppJs from "./generated/canvas-app.js" with { type: "text" };
// Text imports. `*.css` is declared by the repo's shared types/assets; the
// `*.html` and verbatim `*.js` bundles are declared by ./client-assets.d.ts.
// HTML is typed as HTMLBundle by bun-types, so cast at the use site (same
// pattern as src/export/html): `with { type: "text" }` yields a string at
// runtime; TS just can't vary the type by import attribute.
import templateHtml from "./index.html" with { type: "text" };
import css from "./styles.css" with { type: "text" };
import dompurifyJs from "./vendor/dompurify.js" with { type: "text" };
import markedJs from "./vendor/marked.js" with { type: "text" };
import mermaidJs from "./vendor/mermaid.js" with { type: "text" };

const html = templateHtml as unknown as string;

const make = (body: string, contentType: string) => ({ body, contentType });
const HTML = make(html, "text/html; charset=utf-8");
const JS = make(clientJs, "text/javascript; charset=utf-8");
const CSS = make(css, "text/css; charset=utf-8");
const CANVAS_CSS = make(canvasCss, "text/css; charset=utf-8");
const CANVAS_JS = make(canvasAppJs, "text/javascript; charset=utf-8");
const vendorJs = (body: string) => make(body, "text/javascript; charset=utf-8");

/**
 * Route path → static asset. Keys are the path the browser requests.
 * Vendor bundles live under /vendor/*.js (loaded by <script src> in index.html).
 */
export const CLIENT_ASSETS: ClientAssetMap = {
	"/": HTML,
	"/client.js": JS,
	"/styles.css": CSS,
	"/vendor/marked.js": vendorJs(markedJs),
	"/vendor/dompurify.js": vendorJs(dompurifyJs),
	"/vendor/mermaid.js": vendorJs(mermaidJs),
	"/generated/canvas-app.css": CANVAS_CSS,
	"/generated/canvas-app.js": CANVAS_JS,
};
