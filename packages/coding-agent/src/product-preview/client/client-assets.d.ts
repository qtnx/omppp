/**
 * Ambient declarations for product-preview client asset text imports.
 *
 * The repo's shared `types/assets` already declares `*.css` and `*.md` text
 * modules, and deliberately omits `*.html` (bun-types claims it as HTMLBundle).
 * Following the export/html pattern, `.html` is imported and cast at the use
 * site. The verbatim client JS bundles here (served byte-for-byte under CSP
 * script-src 'self') need string-module declarations. Patterns are scoped to
 * exactly the files assets.ts imports — a global `*.js` rule would retype
 * every JS import in the package.
 */
declare module "*/client.js" {
	const content: string;
	export default content;
}
declare module "*/vendor/marked.js" {
	const content: string;
	export default content;
}
declare module "*/vendor/dompurify.js" {
	const content: string;
	export default content;
}
declare module "*/vendor/mermaid.js" {
	const content: string;
	export default content;
}
declare module "*/generated/canvas-app.js" {
	const content: string;
	export default content;
}
