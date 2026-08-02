import { ImagePlus, Loader2 } from "lucide-react";
import { marked } from "marked";
import { type ChangeEvent, type ClipboardEvent, type DragEvent, useRef, useState } from "react";
import type { KanbanApi } from "./api";

interface DescriptionEditorProps {
	id: string;
	value: string;
	disabled: boolean;
	api: KanbanApi | null;
	invalid: boolean;
	describedBy: string | undefined;
	onChange(next: string): void;
}

type EditorTab = "write" | "preview";

/**
 * Markdown is the rich text here: the same bytes render for a human and read
 * cleanly for the model, and pasted screenshots become ordinary image links
 * the `kanban` tool can resolve back into real images.
 */
export function DescriptionEditor({
	id,
	value,
	disabled,
	api,
	invalid,
	describedBy,
	onChange,
}: DescriptionEditorProps) {
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const [tab, setTab] = useState<EditorTab>("write");
	const [uploading, setUploading] = useState(false);
	const [uploadError, setUploadError] = useState<string | null>(null);
	const [dragging, setDragging] = useState(false);

	const insertAtCursor = (snippet: string): void => {
		const textarea = textareaRef.current;
		if (!textarea) {
			onChange(value.length > 0 ? `${value}\n${snippet}` : snippet);
			return;
		}
		const start = textarea.selectionStart;
		const end = textarea.selectionEnd;
		const before = value.slice(0, start);
		const after = value.slice(end);
		const spacer = before.length > 0 && !before.endsWith("\n") ? "\n" : "";
		const next = `${before}${spacer}${snippet}\n${after}`;
		onChange(next);
		requestAnimationFrame(() => {
			const caret = before.length + spacer.length + snippet.length + 1;
			textarea.focus();
			textarea.setSelectionRange(caret, caret);
		});
	};

	const uploadFiles = async (files: readonly File[]): Promise<void> => {
		const images = files.filter(file => file.type.startsWith("image/"));
		if (images.length === 0 || !api) return;
		setUploading(true);
		setUploadError(null);
		try {
			for (const image of images) {
				const uploaded = await api.uploadAttachment(image);
				insertAtCursor(`![${uploaded.filename}](${uploaded.url})`);
			}
		} catch (error) {
			setUploadError(error instanceof Error ? error.message : "Couldn't upload that image.");
		} finally {
			setUploading(false);
		}
	};

	const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
		const files = [...event.clipboardData.files];
		if (files.length === 0) return;
		event.preventDefault();
		void uploadFiles(files);
	};

	const onDrop = (event: DragEvent<HTMLDivElement>): void => {
		setDragging(false);
		const files = [...event.dataTransfer.files];
		if (files.length === 0) return;
		event.preventDefault();
		void uploadFiles(files);
	};

	const onPick = (event: ChangeEvent<HTMLInputElement>): void => {
		const files = [...(event.target.files ?? [])];
		event.target.value = "";
		void uploadFiles(files);
	};

	return (
		<div className="kb-description-editor" data-dragging={dragging ? "true" : "false"}>
			<div className="kb-description-toolbar">
				<div className="kb-tabs kb-tabs-inline" role="tablist" aria-label="Description mode">
					{(["write", "preview"] as const).map(mode => (
						<button key={mode} type="button" role="tab" aria-selected={tab === mode} onClick={() => setTab(mode)}>
							{mode === "write" ? "Write" : "Preview"}
						</button>
					))}
				</div>
				<button
					type="button"
					className="kb-button"
					disabled={disabled || uploading || !api}
					onClick={() => fileInputRef.current?.click()}
				>
					{uploading ? <Loader2 size={14} aria-hidden="true" /> : <ImagePlus size={14} aria-hidden="true" />}
					{uploading ? "Uploading..." : "Add image"}
				</button>
				<input
					ref={fileInputRef}
					type="file"
					accept="image/png,image/jpeg,image/gif,image/webp"
					multiple
					className="kb-sr-only"
					onChange={onPick}
					tabIndex={-1}
					aria-hidden="true"
				/>
			</div>
			{tab === "write" ? (
				<div
					className="kb-description-drop"
					onDragOver={event => {
						event.preventDefault();
						setDragging(true);
					}}
					onDragLeave={() => setDragging(false)}
					onDrop={onDrop}
				>
					<textarea
						ref={textareaRef}
						id={id}
						value={value}
						onChange={event => onChange(event.target.value)}
						onPaste={onPaste}
						rows={8}
						disabled={disabled}
						aria-invalid={invalid}
						aria-describedby={describedBy}
					/>
				</div>
			) : (
				<div className="kb-markdown" aria-live="polite">
					{value.trim().length > 0 ? (
						<div dangerouslySetInnerHTML={{ __html: renderMarkdown(value) }} />
					) : (
						<p className="kb-markdown-empty">Nothing to preview yet.</p>
					)}
				</div>
			)}
			{uploadError ? (
				<p className="kb-field-error" role="alert">
					{uploadError}
				</p>
			) : null}
		</div>
	);
}

/**
 * Renders board markdown with raw HTML disabled, so a pasted `<script>` stays
 * literal text instead of executing inside the board's own origin.
 */
export function renderMarkdown(source: string): string {
	const escaped = source.replaceAll("<", "&lt;").replaceAll(">", "&gt;");
	return marked.parse(escaped, { async: false, gfm: true, breaks: true });
}
