declare module "*.css";

/** Bundler asset import: the default export is the emitted file's URL. */
declare module "*.mp4" {
	const src: string;
	export default src;
}
