import { Marked, type Token, type Tokens } from "marked";
import type { ReactNode } from "react";
import { memo, useMemo } from "react";
import { MermaidDiagram } from "./Mermaid";

function escapeHtml(s: string): string {
	return s
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}
function unescapeHtml(raw: string): string {
	const parseCodePoint = (value: number): string => {
		if (Number.isFinite(value) && value >= 0 && value <= 0x10ffff) {
			try {
				return String.fromCodePoint(value);
			} catch (_) {}
		}
		return "";
	};

	return raw.replace(/&(amp|lt|gt|quot|apos|nbsp|#\d+|#x[0-9a-fA-F]+);/gi, (match, entity) => {
		const lower = entity.toLowerCase();
		switch (lower) {
			case "nbsp":
				return " ";
			case "lt":
				return "<";
			case "gt":
				return ">";
			case "quot":
				return '"';
			case "apos":
				return "'";
			case "amp":
				return "&";
			default: {
				if (lower.startsWith("#x")) {
					return parseCodePoint(Number.parseInt(lower.slice(2), 16));
				}
				if (lower.startsWith("#")) {
					return parseCodePoint(Number(lower.slice(1)));
				}
				return match;
			}
		}
	});
}
function safeHref(href: string): string | null {
	const trimmed = href.trim();
	if (/^(?:https?:|mailto:)/i.test(trimmed)) return trimmed;
	if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return null; // unknown scheme (javascript:, data:, …)
	return trimmed; // relative / fragment
}

const md = new Marked({
	gfm: true,
	renderer: {
		// Raw HTML tokens (block + inline both arrive here) are escaped, never emitted.
		html({ text }) {
			const cleaned = text.replace(/<\/?(?:advisory|span|text)\b(?:\s[^>]*)?\s*\/?>/gi, "");
			if (cleaned === "") return "";
			return escapeHtml(unescapeHtml(cleaned));
		},
		link({ href, title, tokens }) {
			const inner = this.parser.parseInline(tokens);
			const url = safeHref(href);
			if (url === null) return inner;
			const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
			return `<a href="${escapeHtml(url)}"${titleAttr} target="_blank" rel="noopener">${inner}</a>`;
		},
	},
	breaks: true,
});

/** One rendered piece of a message: pre-parsed markdown html, or a mermaid diagram. */
type MarkdownSegment = { kind: "html"; html: string } | { kind: "mermaid"; code: string };

/** True for a fenced block whose info string selects mermaid (```mermaid, ```mermaid title=x). */
function isMermaidCode(token: Token): token is Tokens.Code {
	return token.type === "code" && /^mermaid\b/i.test((token.lang ?? "").trim());
}

/**
 * Split a message into markdown runs and mermaid blocks. Messages with no
 * mermaid fence take the original single-parse path unchanged.
 */
function splitSegments(text: string): MarkdownSegment[] {
	const tokens = md.lexer(text);
	if (!tokens.some(isMermaidCode)) return [{ kind: "html", html: md.parser(tokens) }];
	const segments: MarkdownSegment[] = [];
	let run: Token[] = [];
	const flush = (): void => {
		if (run.length === 0) return;
		segments.push({ kind: "html", html: md.parser(run) });
		run = [];
	};
	for (const token of tokens) {
		if (isMermaidCode(token)) {
			flush();
			segments.push({ kind: "mermaid", code: token.text });
			continue;
		}
		run.push(token);
	}
	flush();
	return segments;
}

export const Markdown = memo(function Markdown({ text }: { text: string }): ReactNode {
	const segments = useMemo(() => {
		try {
			return splitSegments(text);
		} catch {
			return [{ kind: "html", html: escapeHtml(text) } satisfies MarkdownSegment];
		}
	}, [text]);
	const only = segments.length === 1 ? segments[0] : undefined;
	// No mermaid in this message: one container, exactly as before.
	if (only?.kind === "html") return <div className="tr-md" dangerouslySetInnerHTML={{ __html: only.html }} />;
	return (
		<div className="tr-md">
			{segments.map((segment, index) =>
				segment.kind === "mermaid" ? (
					<MermaidDiagram key={index} code={segment.code} />
				) : (
					<div key={index} dangerouslySetInnerHTML={{ __html: segment.html }} />
				),
			)}
		</div>
	);
});
