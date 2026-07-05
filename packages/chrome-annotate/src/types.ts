// Local mirror of annotation wire types; source of truth: packages/coding-agent/src/tools/browser/annotate.ts

export interface AnnotationElementInfo {
	selector: string;
	tag: string;
	id?: string;
	classes?: string[];
	role?: string;
	name?: string;
	text?: string;
	rect: {
		x: number;
		y: number;
		width: number;
		height: number;
	};
}

export interface AnnotationRect {
	x: number;
	y: number;
	width: number;
	height: number;
	note?: string;
	element?: AnnotationElementInfo;
}

export interface AnnotationPayload {
	comment: string;
	rects: AnnotationRect[];
	url: string;
	title?: string;
}
