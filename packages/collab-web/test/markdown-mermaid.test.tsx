import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "../src/components/transcript/Markdown";

const DIAGRAM = "graph TD;\n  A[Start] --> B[Finish];";

describe("Markdown mermaid blocks", () => {
	it("routes a mermaid fence to the diagram component instead of a plain code block", () => {
		const html = renderToStaticMarkup(<Markdown text={`Before\n\n\`\`\`mermaid\n${DIAGRAM}\n\`\`\`\n\nAfter`} />);

		// The diagram container replaces the generic fenced-code rendering...
		expect(html).toContain("tr-mermaid-fallback");
		expect(html).not.toContain("language-mermaid");
		// ...and the prose around it still renders as markdown.
		expect(html).toContain("<p>Before</p>");
		expect(html).toContain("<p>After</p>");
		// Server render keeps the source readable until the browser swaps in SVG.
		expect(html).toContain("A[Start]");
	});

	it("treats an info string with attributes as mermaid too", () => {
		const html = renderToStaticMarkup(<Markdown text={`\`\`\`mermaid title=flow\n${DIAGRAM}\n\`\`\``} />);

		expect(html).toContain("tr-mermaid-fallback");
	});

	it("leaves other fenced languages as code blocks", () => {
		const html = renderToStaticMarkup(<Markdown text={'```ts\nconst a = 1;\n```'} />);

		expect(html).toContain("<code");
		expect(html).not.toContain("tr-mermaid");
	});

	it("renders a mermaid-free message through the original single-container path", () => {
		const html = renderToStaticMarkup(<Markdown text={"# Title\n\nSome **bold** text."} />);

		// One container, markdown html inlined directly — no per-segment wrapper divs.
		expect(html.startsWith('<div class="tr-md"><h1>Title</h1>')).toBe(true);
		expect(html).toContain("<p>Some <strong>bold</strong> text.</p>");
		expect(html).not.toContain('<div class="tr-md"><div');
	});
});
