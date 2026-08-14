import mermaid from "mermaid";
import type { ReactNode } from "react";
import { memo, useEffect, useId, useState } from "react";

let initialized = false;

/**
 * Initialize mermaid once per page. `securityLevel: "strict"` keeps diagram
 * source from injecting HTML or running scripts — transcript content is
 * attacker-influenced (it is whatever the host session printed).
 */
function ensureInitialized(): void {
	if (initialized) return;
	const prefersLight =
		typeof window !== "undefined" &&
		typeof window.matchMedia === "function" &&
		window.matchMedia("(prefers-color-scheme: light)").matches;
	mermaid.initialize({
		startOnLoad: false,
		securityLevel: "strict",
		theme: prefersLight ? "default" : "dark",
	});
	initialized = true;
}

/**
 * One ```mermaid fenced block. Renders to SVG in the browser; before the effect
 * runs (server render, first paint) and on any parse error it shows the source
 * as code, so a broken diagram never costs the reader the content.
 */
export const MermaidDiagram = memo(function MermaidDiagram({ code }: { code: string }): ReactNode {
	const reactId = useId();
	const [svg, setSvg] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		const renderId = `mermaid-${reactId.replace(/[^a-zA-Z0-9-]/g, "")}`;
		try {
			ensureInitialized();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
			return;
		}
		mermaid
			.render(renderId, code)
			.then(result => {
				if (cancelled) return;
				setSvg(result.svg);
				setError(null);
			})
			.catch((cause: unknown) => {
				if (cancelled) return;
				setSvg(null);
				setError(cause instanceof Error ? cause.message : String(cause));
			});
		return () => {
			cancelled = true;
		};
	}, [code, reactId]);

	if (svg) {
		return (
			<figure className="tr-mermaid" role="img" aria-label="Diagram" dangerouslySetInnerHTML={{ __html: svg }} />
		);
	}
	return (
		<div className="tr-mermaid-fallback">
			{error && (
				<p className="tr-mermaid-error" role="status">
					Diagram could not be rendered: {error}
				</p>
			)}
			<pre>
				<code>{code}</code>
			</pre>
		</div>
	);
});
