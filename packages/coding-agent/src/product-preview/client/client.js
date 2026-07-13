/*
 * Product Preview WebUI — client logic (zero-build, no framework).
 *
 * CSP: script-src 'self'. Vendor libs (marked/DOMPurify/mermaid) load from
 * same-origin /vendor/*.js and attach globals. No CDN, no inline, no eval.
 *
 * Flow: GET /api/manifest -> render tree -> GET /api/doc/<id> -> render.
 * Events: EventSource(/events) reloads on manifest/doc-changed, reconnects on drop.
 * Side-ask: POST /api/side-ask with header x-ompx-preview.
 */

"use strict";

(function () {
	// --- Copy constants (design doc source of truth) ----------------------
	const COPY = {
		empty: (root) =>
			`No artifacts under ${root}. Run the product skills (discovery → spec → design → architecture) or pass root/paths to present.`,
		liveOk: "Live — connected",
		liveReconnect: "Reconnecting…",
		askSent: "Delivered to the owner's session.",
		askNoAgent:
			"No agent session is attached to this preview. Start it from an ompx session (present tool) to receive asks.",
		shareGate:
			"Enabling share requires a command in your terminal so only a human can expose the preview.",
		shareEnded: "Sharing has ended. Ask the owner for a new link.",
		mmdFail: "Diagram failed to parse — showing source.",
		storyIndicator: (n, m) => `parsed ${n}/${m} stories`,
	};

	// --- DOM refs ----------------------------------------------------------
	const $ = (id) => document.getElementById(id);
	const el = {
		bundleTitle: $("bundleTitle"),
		tree: $("tree"),
		content: $("content"),
		statusText: $("statusText"),
		statusStrip: $("statusStrip"),
		liveDot: $("liveDot"),
		liveLabel: $("liveLabel"),
		viewTabs: $("viewTabs"),
		tabOverview: $("tab-overview"),
		tabStorymap: $("tab-storymap"),
		tabPhases: $("tab-phases"),
		nav: $("nav"),
		menuToggle: $("menuToggle"),
		askBtn: $("askBtn"),
		askPanel: $("askPanel"),
		askForm: $("askForm"),
		askInput: $("askInput"),
		askSubmit: $("askSubmit"),
		askRate: $("askRate"),
		askToast: $("askToast"),
		askError: $("askError"),
		askContext: $("askContext"),
		shareBtn: $("shareBtn"),
		sharePanel: $("sharePanel"),
		endedOverlay: $("endedOverlay"),
		commentPanel: $("commentPanel"),
		commentThreads: $("commentThreads"),
		commentAuthor: $("commentAuthor"),
		commentInput: $("commentInput"),
		commentSubmit: $("commentSubmit"),
		commentCapability: $("commentCapability"),
		commentTabs: $("commentTabs"),
		commentOpenCount: $("commentOpenCount"),
		commentSentCount: $("commentSentCount"),
		commentResolvedCount: $("commentResolvedCount"),
		commentContext: $("commentContext"),
		commentDelivery: $("commentDelivery"),
		sharedBadge: $("sharedBadge"),
		nameChip: $("nameChip"),
	};

	// --- State -------------------------------------------------------------
	const state = {
		manifest: null,
		currentId: null,
		currentView: "overview",
		isLoopback: location.hostname === "127.0.0.1" || location.hostname === "localhost" || location.hostname === "0.0.0.0",
		es: null,
		esRetryDelay: 1000,
		mermaidRunning: false,
		docCache: new Map(),
		comments: [],
		renderGeneration: 0,
		pendingAnchor: null,
		pendingRequestId: null,
		pendingContext: "",
		commentFilter: "open",
		pendingOperationIds: new Map(),
		displayName: localStorage.getItem("ompxPreviewName") || "",
		mockupFrame: null,
		canvasHandle: null,
		commentSelectionListening: false,
		canvasDocument: null,
		activePanel: null,
		panelTriggers: new Map(),
	};

	// Kept in sync with ../anchoring.ts.
	function buildAnchor(docText, start, end) {
		const safeStart = Math.max(0, Math.min(start, docText.length));
		const safeEnd = Math.max(safeStart, Math.min(end, docText.length));
		return {
			type: "text",
			quote: docText.slice(safeStart, safeEnd),
			prefix: docText.slice(Math.max(0, safeStart - 32), safeStart),
			suffix: docText.slice(safeEnd, safeEnd + 32),
		};
	}

	// Kept in sync with ../anchoring.ts.
	function resolveAnchor(docText, anchor) {
		if (!anchor.quote) return null;
		const candidates = [];
		let start = docText.indexOf(anchor.quote);
		while (start !== -1) {
			const end = start + anchor.quote.length;
			let score = 0;
			if (anchor.prefix && docText.slice(Math.max(0, start - anchor.prefix.length), start) === anchor.prefix) score += 1;
			if (anchor.suffix && docText.slice(end, end + anchor.suffix.length) === anchor.suffix) score += 1;
			candidates.push({ start, end, score });
			start = docText.indexOf(anchor.quote, start + 1);
		}
		if (!candidates.length) return null;
		const bestScore = Math.max(...candidates.map((candidate) => candidate.score));
		const winners = candidates.filter((candidate) => candidate.score === bestScore);
		return winners.length === 1 ? { start: winners[0].start, end: winners[0].end } : null;
	}

	// Kept in sync with ../question-parser.ts.
	function parseQuestionBlock(text) {
		let value;
		try {
			value = JSON.parse(text);
		} catch {
			return null;
		}
		if (!value || typeof value !== "object" || Array.isArray(value)) return null;
		if (typeof value.id !== "string" || !value.id.trim() || typeof value.question !== "string" || !value.question.trim()) return null;
		if (!Array.isArray(value.options) || value.options.length < 2) return null;
		const options = [];
		for (const option of value.options) {
			if (!option || typeof option !== "object" || Array.isArray(option) || typeof option.label !== "string") return null;
			if (option.description !== undefined && typeof option.description !== "string") return null;
			options.push(option.description === undefined ? { label: option.label } : { label: option.label, description: option.description });
		}
		return { id: value.id, question: value.question, options, multi: value.multi === true };
	}

	// ===================================================================
	// Manifest fetch + tree render
	// ===================================================================

	async function fetchManifest() {
		const res = await fetch("/api/manifest", { headers: { Accept: "application/json" } });
		if (!res.ok) throw new Error(`Manifest fetch failed: ${res.status}`);
		return res.json();
	}

	function applyManifest(manifest) {
		state.manifest = manifest;
		el.bundleTitle.textContent = manifest.bundle.title || "Product Preview";
		renderTree(manifest.items);
		showTabsFor(manifest.items);
		const feedbackAvailable = manifest.capabilities?.feedback === true;
		el.commentSubmit.disabled = !feedbackAvailable;
		el.commentSubmit.title = feedbackAvailable ? "" : "Feedback needs a live agent session.";
		el.commentCapability.textContent = feedbackAvailable
			? "Feedback is delivered to the owning agent session."
			: "Feedback is unavailable until a live agent session is attached.";
		setCommentDelivery(feedbackAvailable ? "Ready to send." : "Connect this preview to an agent before sending feedback.", feedbackAvailable ? "" : "warn");

		const hash = getHashId();
		if (hash) {
			selectDoc(hash);
		} else if (state.currentView === "overview" || !state.currentId) {
			renderOverview(manifest);
		}
	}

	// Group items by kind, render semantic <nav><ul> tree.
	function renderTree(items) {
		const groups = groupByKind(items);
		const frag = document.createDocumentFragment();

		if (items.length === 0) {
			const empty = document.createElement("p");
			empty.className = "empty-state";
			empty.textContent = COPY.empty(state.manifest?.bundle?.root || "docs/product");
			frag.appendChild(empty);
			el.tree.innerHTML = "";
			el.tree.appendChild(frag);
			return;
		}

		for (const [kind, groupItems] of groups) {
			const group = document.createElement("div");
			group.className = "tree-group";

			const head = document.createElement("div");
			head.className = "tree-group-head";
			head.textContent = `${kindLabel(kind)} `;
			const count = document.createElement("span");
			count.className = "tree-group-count";
			count.textContent = `(${groupItems.length})`;
			head.appendChild(count);
			group.appendChild(head);

			const list = document.createElement("ul");
			list.className = "tree-list";
			for (const item of groupItems) {
				const li = document.createElement("li");
				const a = document.createElement("a");
				a.className = "tree-link";
				a.href = `#doc=${item.id}`;
				a.textContent = item.title;
				a.dataset.id = item.id;
				a.addEventListener("click", (e) => {
					e.preventDefault();
					selectDoc(item.id);
				});
				if (item.id === state.currentId) a.setAttribute("aria-current", "true");
				const openCount = state.comments.filter((comment) => comment.anchor.itemId === item.id && !comment.resolved).length;
				if (openCount) {
					const badge = document.createElement("span");
					badge.className = "comment-count";
					badge.textContent = String(openCount);
					badge.setAttribute("aria-label", `${openCount} open comments`);
					li.appendChild(badge);
				}
				li.appendChild(a);
				list.appendChild(li);
			}
			group.appendChild(list);
			frag.appendChild(group);
		}

		el.tree.innerHTML = "";
		el.tree.appendChild(frag);
	}

	// Stable kind ordering for the tree.
	const KIND_ORDER = ["brief", "spec", "design", "architecture", "plan", "canvas", "mockup", "doc"];
	function groupByKind(items) {
		const map = new Map();
		for (const item of items) {
			if (!map.has(item.kind)) map.set(item.kind, []);
			map.get(item.kind).push(item);
		}
		const sorted = [];
		for (const k of KIND_ORDER) {
			if (map.has(k)) sorted.push([k, map.get(k).sort((a, b) => a.relPath.localeCompare(b.relPath))]);
		}
		return sorted;
	}

	function kindLabel(kind) {
		const labels = {
			brief: "Brief",
			spec: "Specs",
			design: "Design",
			architecture: "Architecture",
			plan: "Plans",
			canvas: "Canvases",
			mockup: "Mockups",
			doc: "Docs",
		};
		return labels[kind] || kind;
	}

	// ===================================================================
	// View tabs (Overview / Story map / Phases)
	// ===================================================================

	function showTabsFor(items) {
		const hasSpec = items.some((i) => i.kind === "spec");
		el.viewTabs.hidden = !hasSpec;
		// Story map + Phases tabs only show when a spec exists; the doc-view
		// tabs surface derived views only when their source parses.
	}

	function setView(view) {
		state.currentView = view;
		for (const tab of el.viewTabs.querySelectorAll(".view-tab")) {
			tab.setAttribute("aria-selected", tab.dataset.view === view ? "true" : "false");
		}
		if (view === "overview") {
			renderOverview(state.manifest);
		} else if (view === "storymap" && state.currentId) {
			renderSpecStoryMap(state.currentId);
		} else if (view === "phases" && state.currentId) {
			renderPhases(state.currentId);
		}
	}

	// ===================================================================
	// Overview
	// ===================================================================

	function renderOverview(manifest) {
		el.content.setAttribute("aria-busy", "false");
		state.currentView = "overview";
		setTabSelected("overview");
		const counts = {};
		for (const item of manifest.items) counts[item.kind] = (counts[item.kind] || 0) + 1;

		const recent = [...manifest.items].sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 5);
		const generatedAgo = relativeTime(manifest.bundle.generatedAt);

		const wrap = document.createElement("div");
		wrap.className = "overview";
		wrap.innerHTML = "";

		const h1 = document.createElement("h1");
		h1.textContent = manifest.bundle.title;
		wrap.appendChild(h1);

		const meta = document.createElement("div");
		meta.className = "overview-meta";
		meta.textContent = `generated ${generatedAgo}`;
		wrap.appendChild(meta);

		const countPills = document.createElement("div");
		countPills.className = "overview-counts";
		for (const k of KIND_ORDER) {
			if (counts[k]) {
				const pill = document.createElement("span");
				pill.className = "count-pill";
				pill.textContent = `${counts[k]} ${kindLabel(k).toLowerCase()}`;
				countPills.appendChild(pill);
			}
		}
		wrap.appendChild(countPills);

		if (recent.length) {
			const head = document.createElement("div");
			head.className = "tree-group-head";
			head.textContent = "Recent changes";
			wrap.appendChild(head);
			const ul = document.createElement("ul");
			ul.className = "recent-list";
			for (const item of recent) {
				const li = document.createElement("li");
				li.className = "recent-item";
				const a = document.createElement("a");
				a.href = `#doc=${item.id}`;
				a.textContent = item.relPath;
				a.addEventListener("click", (e) => {
					e.preventDefault();
					selectDoc(item.id);
				});
				const time = document.createElement("span");
				time.className = "recent-time";
				time.textContent = relativeTime(item.mtimeMs);
				time.title = new Date(item.mtimeMs).toISOString();
				li.appendChild(a);
				li.appendChild(time);
				ul.appendChild(li);
			}
			wrap.appendChild(ul);
		}

		el.content.innerHTML = "";
		el.content.appendChild(wrap);
	}

	// ===================================================================
	// Doc selection + render
	// ===================================================================

	async function selectDoc(id) {
		if (!state.manifest) return;
		const item = state.manifest.items.find((i) => i.id === id);
		if (!item) return;
		state.currentId = id;
		state.currentView = "doc";
		setTabSelected("overview");
		highlightTreeItem(id);
		closeNavDrawer();
		updateAskContext(item);
		state.canvasHandle?.destroy();
		state.canvasHandle = null;
		state.canvasDocument = null;
		state.pendingAnchor = null;
		state.pendingContext = "";
		state.pendingRequestId = null;
		updateCommentContext();

		el.content.setAttribute("aria-busy", "true");

		// For specs, surface story-map/phases tabs.
		const specTabs = item.kind === "spec";
		el.tabStorymap.hidden = !specTabs;
		el.tabPhases.hidden = !specTabs;

		try {
			if (item.kind === "canvas") {
				const response = await fetch(`/api/canvas/${id}`, { headers: { Accept: "application/json" } });
				if (!response.ok) {
					const failure = await response.json().catch(() => null);
					const error = new Error(failure?.error?.message || `Canvas fetch failed: ${response.status}`);
					error.code = failure?.error?.code;
					error.field = failure?.error?.field;
					throw error;
				}
				const data = await response.json();
				await renderCanvas(item, data.canvas);
				return;
			}
			let content = state.docCache.get(id);
			if (!content) {
				const res = await fetch(`/api/doc/${id}`, { headers: { Accept: "application/json" } });
				if (!res.ok) throw new Error(`Doc fetch failed: ${res.status}`);
				const data = await res.json();
				content = data.content;
				state.docCache.set(id, content);
			}
			await renderDoc(item, content);
		} catch (err) {
			renderErrorBanner(err, item);
		} finally {
			el.content.setAttribute("aria-busy", "false");
		}
	}

	async function renderDoc(item, content) {
		const generation = ++state.renderGeneration;
		const wrap = document.createElement("div");
		wrap.className = "doc-pane";
		const head = document.createElement("div");
		head.className = "doc-head";
		const path = document.createElement("span");
		path.className = "doc-path";
		path.textContent = item.relPath;
		const copyBtn = document.createElement("button");
		copyBtn.type = "button";
		copyBtn.className = "btn btn-sm";
		copyBtn.textContent = "Copy path";
		copyBtn.setAttribute("aria-label", "Copy document path");
		copyBtn.dataset.ompxUi = "";
		copyBtn.addEventListener("click", () => copyText(item.relPath, copyBtn));
		head.append(path, copyBtn);
		wrap.appendChild(head);
		el.content.innerHTML = "";
		el.content.appendChild(wrap);

		if (item.kind === "mockup") {
			renderMockup(item, wrap);
			return;
		}

		const body = document.createElement("div");
		body.className = "doc-body";
		wrap.appendChild(body);
		const rawHtml = window.marked.parse(content);
		body.innerHTML = window.DOMPurify.sanitize(rawHtml, { USE_PROFILES: { html: true }, ADD_ATTR: ["target", "rel"] });
		for (const link of body.querySelectorAll("a[href^='http']")) {
			link.setAttribute("target", "_blank");
			link.setAttribute("rel", "noopener noreferrer");
		}
		await renderMermaidBlocks(body);
		enhanceQuestionBlocks(body, item, generation);
		await refreshComments(item.id, body, generation);
		installCommentSelection(body, item.id);
		const openDocument = makePreviewModalButton("Open document", item.title || item.relPath, () => {
			const clone = body.cloneNode(true);
			for (const node of clone.querySelectorAll("[id]")) node.removeAttribute("id");
			return clone;
		});
		openDocument.classList.add("preview-modal-toggle--document");
		head.appendChild(openDocument);
	}

	async function renderCanvas(item, canvas) {
		const generation = ++state.renderGeneration;
		const wrap = document.createElement("div");
		wrap.className = "doc-pane canvas-pane";
		const head = document.createElement("div");
		head.className = "doc-head";
		const path = document.createElement("span");
		path.className = "doc-path";
		path.textContent = item.relPath;
		head.append(path);
		const mount = document.createElement("div");
		mount.className = "canvas-host";
		wrap.append(head, mount);
		el.content.innerHTML = "";
		el.content.appendChild(wrap);
		const host = window.ProductPreviewCanvasHost;
		if (!host) throw new Error("Canvas viewer failed to load.");
		state.canvasDocument = canvas;
		const selectNode = selection => {
			state.pendingAnchor = { type: "canvas-node", itemId: selection.itemId, nodeId: selection.nodeId };
			state.pendingContext = `Canvas node: ${selection.title}`;
			state.pendingRequestId = null;
			updateCommentContext();
		};
		const openComposer = selection => {
			selectNode(selection);
			state.commentFilter = "open";
			openCommentPanel(undefined, el.content);
		};
		const resolveRef = refPath => {
			const normalized = refPath.replace(/^\.\//, "");
			return state.manifest?.items.find(candidate => candidate.relPath === normalized)?.id ?? null;
		};
		state.canvasHandle = host.mount(mount, {
			item,
			canvas,
			comments: state.comments,
			onNodeSelected: selectNode,
			onOpenComment: openComposer,
			resolveRef,
			onNavigateRef: targetId => {
				location.hash = `doc=${targetId}`;
				selectDoc(targetId);
			},
		});
		await refreshComments(item.id, null, generation);
	}

	// ===================================================================
	// Mermaid rendering under CSP script-src 'self' (no eval)
	// ===================================================================

	async function renderMermaidBlocks(root) {
		if (!window.mermaid) return;
		if (!state.mermaidRunning) {
			window.mermaid.initialize({
				startOnLoad: false,
				securityLevel: "strict", // no eval, no HTML injection
				theme: "dark",
			});
			state.mermaidRunning = true;
		}

		const blocks = root.querySelectorAll("pre code.language-mermaid");
		let i = 0;
		for (const code of blocks) {
			const pre = code.parentElement;
			const source = code.textContent;
			const id = `mmd-${Date.now()}-${i++}`;
			try {
				const { svg } = await window.mermaid.render(id, source);
				const container = document.createElement("div");
				container.className = "mermaid-container";
				container.dataset.ompxUi = "";
				container.innerHTML = svg;
				container.appendChild(makePreviewModalButton("Open flow", svgElLabel(source), () => container.querySelector("svg")?.cloneNode(true)));
				const svgEl = container.querySelector("svg");
				if (svgEl) {
					svgEl.setAttribute("role", "img");
					const title = source.match(/^---[\s\S]*?title:\s*(.+)$/m);
					svgEl.setAttribute("aria-label", title ? title[1].trim() : "diagram");
				}
				pre.replaceWith(container);
			} catch (err) {
				// Parse failure: keep code block, add red badge (spec S1-AC3).
				const badge = document.createElement("span");
				badge.className = "mmd-error";
				badge.textContent = COPY.mmdFail;
				pre.parentElement.insertBefore(badge, pre);
			}
		}
	}
	// Client-only rendering additions are intentionally excluded from document anchors.
	function commentableTextNodes(root) {
		const nodes = [];
		const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
		let node = walker.nextNode();
		while (node) {
			// Skip injected UI chrome, but keep .pv-comment-mark quote text in the
			// document-text walk so anchors stay stable after marks are rendered.
			const ui = node.parentElement?.closest("[data-ompx-ui]");
			if (!ui || ui.classList.contains("pv-comment-mark")) nodes.push(node);
			node = walker.nextNode();
		}
		return nodes;
	}

	function documentText(root) {
		return commentableTextNodes(root).map((node) => node.data).join("");
	}

	function nodeOffsets(root, target) {
		let offset = 0;
		for (const node of commentableTextNodes(root)) {
			if (node === target.node) return offset + target.offset;
			offset += node.data.length;
		}
		return null;
	}

	function selectionOffsets(root) {
		const selection = window.getSelection();
		if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) return null;
		const range = selection.getRangeAt(0);
		if (!root.contains(range.commonAncestorContainer)) return null;
		// Reject real injected chrome, but allow endpoints inside .pv-comment-mark
		// so marked quote text still participates in selection offset math.
		const startUi = range.startContainer.parentElement?.closest("[data-ompx-ui]");
		const endUi = range.endContainer.parentElement?.closest("[data-ompx-ui]");
		if ((startUi && !startUi.classList.contains("pv-comment-mark")) || (endUi && !endUi.classList.contains("pv-comment-mark"))) return null;
		const start = nodeOffsets(root, { node: range.startContainer, offset: range.startOffset });
		const end = nodeOffsets(root, { node: range.endContainer, offset: range.endOffset });
		return start === null || end === null || start === end ? null : { start: Math.min(start, end), end: Math.max(start, end) };
	}

	function wrapCommentRange(root, range, commentId) {
		// Already wrapped on a prior refresh — re-wrapping would nest marks.
		if (root.querySelector(`.pv-comment-mark[data-comment-id="${CSS.escape(commentId)}"]`)) return;
		let offset = 0;
		for (const node of commentableTextNodes(root)) {
			const nodeStart = offset;
			const nodeEnd = offset + node.data.length;
			offset = nodeEnd;
			// Text already inside another mark still contributes to offsets above,
			// but must not be re-wrapped (would nest interactive marks).
			if (node.parentElement?.closest(".pv-comment-mark")) continue;
			const start = Math.max(range.start, nodeStart);
			const end = Math.min(range.end, nodeEnd);
			if (start >= end) continue;
			const localStart = start - nodeStart;
			const localEnd = end - nodeStart;
			const text = node.data;
			const mark = document.createElement("mark");
			mark.className = "pv-comment-mark";
			mark.dataset.commentId = commentId;
			mark.dataset.ompxUi = "";
			mark.setAttribute("role", "button");
			mark.setAttribute("aria-label", "Open comment");
			mark.tabIndex = 0;
			mark.textContent = text.slice(localStart, localEnd);
			const open = () => openCommentPanel(mark.dataset.commentId, mark);
			mark.addEventListener("click", open);
			mark.addEventListener("keydown", (event) => {
				if (event.key === "Enter" || event.key === " ") {
					event.preventDefault();
					open();
				}
			});
			const fragment = document.createDocumentFragment();
			if (localStart) fragment.appendChild(document.createTextNode(text.slice(0, localStart)));
			fragment.appendChild(mark);
			if (localEnd < text.length) fragment.appendChild(document.createTextNode(text.slice(localEnd)));
			node.parentNode.replaceChild(fragment, node);
		}
	}

	function installCommentSelection(root, itemId) {
		for (const stale of document.querySelectorAll(".comment-float")) stale.remove();
		const button = document.createElement("button");
		button.type = "button";
		button.className = "comment-float btn btn-primary";
		button.textContent = "Comment";
		button.setAttribute("aria-label", "Comment on selected text");
		button.dataset.ompxUi = "";
		button.hidden = true;
		document.body.appendChild(button);
		const hide = () => {
			button.hidden = true;
		};
		root.addEventListener("mouseup", () => {
			const offsets = selectionOffsets(root);
			if (!offsets) return hide();
			state.pendingAnchor = { itemId, ...buildAnchor(documentText(root), offsets.start, offsets.end) };
			state.pendingContext = `Selected text: “${state.pendingAnchor.quote.slice(0, 120)}${state.pendingAnchor.quote.length > 120 ? "…" : ""}”`;
			state.pendingRequestId = null;
			updateCommentContext();
			const rect = window.getSelection().getRangeAt(0).getBoundingClientRect();
			button.style.left = `${rect.left + window.scrollX}px`;
			button.style.top = `${rect.bottom + window.scrollY + 6}px`;
			button.hidden = false;
		});
		if (!state.commentSelectionListening) {
			document.addEventListener("selectionchange", () => {
				if (window.getSelection()?.toString()) return;
				for (const candidate of document.querySelectorAll(".comment-float")) candidate.hidden = true;
			});
			state.commentSelectionListening = true;
		}
		button.addEventListener("click", () => {
			// Float is hidden immediately; store main content as focus-return target
			// so Esc/close lands on a visible, focusable element (tabindex=-1).
			openCommentPanel(undefined, el.content);
			hide();
		});
	}

	async function previewFetch(url, init) {
		const headers = new Headers(init?.headers);
		headers.set("x-ompx-preview", "1");
		return fetch(url, { ...init, headers });
	}

	function newRequestId() {
		return globalThis.crypto?.randomUUID?.() ?? `preview-${Date.now()}-${Math.random().toString(36).slice(2)}`;
	}

	async function refreshComments(itemId, root, generation) {
		try {
			const response = await previewFetch("/api/comments");
			if (!response.ok) throw new Error(`Comments unavailable (${response.status})`);
			if (generation !== state.renderGeneration) return;
			const data = await response.json();
			state.comments = data.comments || [];
			if (state.canvasHandle && state.canvasDocument) {
				const item = state.manifest?.items.find(candidate => candidate.id === state.currentId);
				if (item) state.canvasHandle.update({ item, canvas: state.canvasDocument, comments: state.comments });
			}
			if (root) {
				const text = documentText(root);
				for (const comment of currentComments()) {
					if (comment.anchor.type !== "text") continue;
					const range = resolveAnchor(text, comment.anchor);
					if (range) wrapCommentRange(root, range, comment.id);
				}
			}
			renderCommentThreads();
			renderTree(state.manifest.items);
		} catch (error) {
			setStatus(error.message || "Couldn't load comments.", "warn");
		}
	}

	function currentComments() {
		return state.comments.filter((comment) => comment.anchor.itemId === state.currentId);
	}

	function setCommentDelivery(message, tone = "") {
		if (!el.commentDelivery) return;
		el.commentDelivery.textContent = message;
		el.commentDelivery.dataset.tone = tone;
	}

	function updateCommentContext() {
		if (!el.commentContext) return;
		el.commentContext.textContent = state.pendingContext;
		el.commentContext.hidden = !state.pendingContext;
	}

	function setCommentFilter(filter) {
		state.commentFilter = filter;
		for (const button of el.commentTabs?.querySelectorAll("[data-review-filter]") || []) {
			const active = button.dataset.reviewFilter === filter;
			button.classList.toggle("is-active", active);
			button.setAttribute("aria-pressed", String(active));
		}
		renderCommentThreads();
	}

	function renderCommentThreads(focusId) {
		if (!el.commentThreads) return;
		el.commentThreads.innerHTML = "";
		const active = currentComments();
		const body = el.content.querySelector(".doc-body");
		const orphaned = active.filter(comment => comment.anchor.type === "text" && body && !resolveAnchor(documentText(body), comment.anchor));
		const resolved = active.filter(comment => comment.resolved);
		const sent = active.filter(comment => !comment.resolved);
		const openCount = state.pendingAnchor ? 1 : 0;
		el.commentOpenCount.textContent = String(openCount);
		el.commentSentCount.textContent = String(sent.length);
		el.commentResolvedCount.textContent = String(resolved.length);
		for (const button of el.commentTabs?.querySelectorAll("[data-review-filter]") || []) {
			const selected = button.dataset.reviewFilter === state.commentFilter;
			button.classList.toggle("is-active", selected);
			button.setAttribute("aria-pressed", String(selected));
		}

		let visible = [];
		if (state.commentFilter === "sent") visible = sent;
		if (state.commentFilter === "resolved") visible = resolved;
		for (const comment of visible) {
			el.commentThreads.appendChild(renderCommentThread(comment, orphaned.includes(comment)));
		}
		if (!visible.length) {
			const empty = document.createElement("p");
			empty.className = "empty-state";
			if (state.commentFilter === "open") {
				empty.textContent = state.pendingAnchor
					? state.manifest?.capabilities?.feedback === true
						? "Feedback is ready. Add an instruction below and send it to the agent."
						: "Feedback is drafted. Connect this preview to an agent session to send it."
					: state.currentId && state.manifest?.items.find(item => item.id === state.currentId)?.kind === "canvas"
						? "Select a canvas node, then choose Send feedback."
						: "Select document text, then choose Comment.";
			} else if (state.commentFilter === "sent") {
				empty.textContent = "No feedback has been sent for this item.";
			} else {
				empty.textContent = "No resolved feedback for this item.";
			}
			el.commentThreads.appendChild(empty);
		}
		if (focusId) document.getElementById(`comment-${focusId}`)?.scrollIntoView({ block: "nearest" });
	}

	function renderCommentThread(comment, orphaned = false) {
		const thread = document.createElement("article");
		thread.className = "comment-thread";
		thread.id = `comment-${comment.id}`;
		const delivery = document.createElement("span");
		delivery.className = `comment-delivery-badge ${comment.resolved ? "is-resolved" : "is-sent"}`;
		delivery.textContent = comment.resolved ? "Resolved" : "Sent to agent";
		const text = document.createElement("p");
		text.className = "comment-body";
		text.textContent = comment.body;
		const meta = document.createElement("p");
		meta.className = "comment-meta";
		meta.textContent = `${comment.author} · ${new Date(comment.ts).toLocaleString()}${orphaned ? " · Source changed" : ""}`;
		thread.append(delivery, text, meta);
		for (const reply of comment.replies || []) {
			const replyEl = document.createElement("p");
			replyEl.className = "comment-reply";
			replyEl.textContent = `${reply.author}: ${reply.body}`;
			thread.appendChild(replyEl);
		}
		const actions = document.createElement("div");
		actions.className = "comment-actions";
		const resolve = document.createElement("button");
		resolve.type = "button";
		resolve.className = "btn btn-sm";
		resolve.textContent = comment.resolved ? "Reopen" : "Resolve";
		resolve.setAttribute("aria-label", `${comment.resolved ? "Reopen" : "Resolve"} comment`);
		resolve.dataset.ompxUi = "";
		resolve.addEventListener("click", () => updateComment(comment.id, "resolve", { resolved: !comment.resolved }));
		actions.appendChild(resolve);
		const reply = document.createElement("button");
		reply.type = "button";
		reply.className = "btn btn-sm";
		reply.textContent = "Reply";
		reply.setAttribute("aria-label", "Reply to comment");
		reply.dataset.ompxUi = "";
		actions.appendChild(reply);
		if (comment.mine === true) {
			const remove = document.createElement("button");
			remove.type = "button";
			remove.className = "btn btn-sm";
			remove.textContent = "Delete";
			remove.setAttribute("aria-label", "Delete comment");
			remove.dataset.ompxUi = "";
			remove.addEventListener("click", () => updateComment(comment.id, "delete", {}));
			actions.appendChild(remove);
		}
		const composer = document.createElement("div");
		composer.className = "comment-reply-composer";
		composer.dataset.ompxUi = "";
		composer.hidden = true;
		const replyId = `comment-reply-${comment.id}`;
		const replyLabel = document.createElement("label");
		replyLabel.htmlFor = replyId;
		replyLabel.textContent = "Reply";
		const replyInput = document.createElement("textarea");
		replyInput.id = replyId;
		replyInput.className = "ask-input";
		replyInput.maxLength = 2000;
		replyInput.rows = 2;
		replyInput.dataset.ompxUi = "";
		replyInput.setAttribute("aria-label", "Reply to comment");
		const submitReply = document.createElement("button");
		submitReply.type = "button";
		submitReply.className = "btn btn-primary btn-sm";
		submitReply.textContent = "Add reply";
		submitReply.dataset.ompxUi = "";
		reply.addEventListener("click", () => {
			composer.hidden = false;
			replyInput.focus();
		});
		submitReply.addEventListener("click", async () => {
			const body = replyInput.value.trim();
			if (!body) return;
			// Capture draft before requireName may re-focus the panel name field.
			const draft = body;
			const author = requireName(submitReply);
			if (!author) {
				// requireName may re-render threads when the panel was closed;
				// restore this thread's draft into the (possibly new) composer.
				const restored = document.getElementById(replyId);
				if (restored) {
					restored.value = draft;
					const composerEl = restored.closest(".comment-reply-composer");
					if (composerEl) composerEl.hidden = false;
				}
				return;
			}
			await updateComment(comment.id, "reply", { body: draft, author });
		});
		composer.append(replyLabel, replyInput, submitReply);
		thread.append(actions, composer);
		return thread;
	}

	function saveDisplayName() {
		const name = el.commentAuthor?.value.trim() || "";
		state.displayName = name;
		localStorage.setItem("ompxPreviewName", name);
		if (!state.isLoopback) {
			if (name) {
				el.nameChip.textContent = name;
				showEl(el.nameChip);
			} else {
				hideEl(el.nameChip);
			}
		}
		return name;
	}

	function requireName(trigger) {
		const name = saveDisplayName();
		if (name) return name;
		// If the comment panel is already open (e.g. inline reply), focus the
		// display-name field without re-rendering threads — re-render would wipe
		// the typed reply draft. Only re-render when the panel was closed.
		const alreadyOpen = !el.commentPanel?.hidden;
		if (alreadyOpen) {
			if (trigger instanceof HTMLElement && !el.commentPanel.contains(trigger)) {
				state.panelTriggers.set(el.commentPanel.id, trigger);
			}
			el.commentAuthor?.focus();
		} else {
			openCommentPanel(undefined, trigger || document.activeElement, el.commentAuthor);
		}
		setStatus("Add a display name before sending feedback.", "warn");
		return null;
	}

	function openCommentPanel(focusId, trigger = document.activeElement, focusTarget = el.commentInput) {
		if (focusId) {
			const focused = state.comments.find(comment => comment.id === focusId);
			state.commentFilter = focused?.resolved ? "resolved" : "sent";
		} else if (state.pendingAnchor) {
			state.commentFilter = "open";
		}
		const alreadyOpen = !el.commentPanel?.hidden;
		openPanel(el.commentPanel, trigger, focusTarget);
		updateCommentContext();
		// Skip re-render when already open without a focus target id so inline
		// reply drafts and open composers survive requireName / re-open paths.
		if (!alreadyOpen || focusId) renderCommentThreads(focusId);
		if (el.commentAuthor) el.commentAuthor.value = state.displayName;
	}

	async function updateComment(commentId, action, body) {
		const url = `/api/comments/${action}`;
		const operationKey = `${action}:${commentId}:${JSON.stringify(body)}`;
		const requestId = action === "delete" ? null : state.pendingOperationIds.get(operationKey) ?? newRequestId();
		if (requestId) state.pendingOperationIds.set(operationKey, requestId);
		const payload = action === "delete" ? { commentId, ...body } : { commentId, ...body, requestId };
		setCommentDelivery(`${action === "reply" ? "Sending reply" : "Updating feedback"}…`);
		try {
			const response = await previewFetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
			if (!response.ok) {
				const failure = await response.json().catch(() => null);
				throw new Error(failure?.error?.message || `Couldn't update comment (${response.status})`);
			}
			state.pendingOperationIds.delete(operationKey);
			await refreshCurrentComments();
			setCommentDelivery(action === "delete" ? "Feedback deleted." : "Delivered to agent.", "ok");
		} catch (error) {
			setCommentDelivery(error.message || "Couldn't update feedback. Retry the action.", "error");
			setStatus(error.message || "Couldn't update comment.", "error");
		}
	}

	async function refreshCurrentComments() {
		if (!state.currentId) return;
		const body = el.content.querySelector(".doc-body");
		await refreshComments(state.currentId, body, state.renderGeneration);
	}

	function setupComments() {
		el.commentAuthor.value = state.displayName;
		el.commentAuthor.addEventListener("change", saveDisplayName);
		for (const button of el.commentTabs?.querySelectorAll("[data-review-filter]") || []) {
			button.addEventListener("click", () => setCommentFilter(button.dataset.reviewFilter));
		}
		el.commentSubmit.addEventListener("click", async () => {
			if (!state.pendingAnchor) return setStatus("Select document text or a canvas node before sending feedback.", "warn");
			const body = el.commentInput.value.trim();
			if (!body) return;
			const author = requireName(el.commentSubmit);
			if (!author) return;
			state.pendingRequestId ??= newRequestId();
			el.commentSubmit.disabled = true;
			setCommentDelivery("Sending to agent…");
			try {
				const response = await previewFetch("/api/comments", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ anchor: state.pendingAnchor, body, author, requestId: state.pendingRequestId }),
				});
				if (!response.ok) {
					const failure = await response.json().catch(() => null);
					const error = new Error(failure?.error?.code === "side_ask_unavailable"
						? "Couldn't reach the agent. Reconnect the preview and retry."
						: failure?.error?.code === "invalid_anchor"
							? "This canvas changed. Select the node again, then retry."
							: failure?.error?.message || `Couldn't send feedback (${response.status})`);
					error.code = failure?.error?.code;
					throw error;
				}
				el.commentInput.value = "";
				state.pendingAnchor = null;
				state.pendingContext = "";
				state.pendingRequestId = null;
				state.commentFilter = "sent";
				updateCommentContext();
				await refreshCurrentComments();
				setCommentDelivery("Delivered to agent.", "ok");
				setStatus("Delivered to agent.", "ok");
			} catch (error) {
				if (error.code === "invalid_anchor") {
					state.pendingAnchor = null;
					state.pendingContext = "";
					updateCommentContext();
				}
				setCommentDelivery(error.message || "Couldn't send feedback.", "error");
				setStatus(error.message || "Couldn't send feedback.", "error");
			} finally {
				el.commentSubmit.disabled = state.manifest?.capabilities?.feedback !== true;
			}
		});
	}

	function enhanceQuestionBlocks(root, item, generation) {
		for (const code of root.querySelectorAll("pre > code.language-ompx-question")) {
			const question = parseQuestionBlock(code.textContent || "");
			if (!question) continue;
			const card = document.createElement("section");
			card.className = "question-card";
			card.dataset.ompxUi = "";
			card.setAttribute("aria-label", question.question);
			const heading = document.createElement("h3");
			heading.textContent = question.question;
			card.appendChild(heading);
			const fieldset = document.createElement("fieldset");
			const legend = document.createElement("legend");
			const answer = state.answers.get(question.id);
			let editing = false;
			legend.textContent = question.question;
			fieldset.appendChild(legend);
			for (const option of question.options) {
				const label = document.createElement("label");
				const input = document.createElement("input");
				input.type = question.multi ? "checkbox" : "radio";
				input.name = `question-${question.id}`;
				input.value = option.label;
				input.checked = Boolean(answer?.selection.includes(option.label));
				input.disabled = Boolean(answer);
				label.append(input, document.createTextNode(option.label));
				if (option.description) {
					const description = document.createElement("span");
					description.className = "question-description";
					description.textContent = option.description;
					label.appendChild(description);
				}
				fieldset.appendChild(label);
			}
			card.appendChild(fieldset);
			const action = document.createElement("button");
			action.type = "button";
			action.className = "btn btn-primary";
			action.setAttribute("aria-label", answer ? "Change answer" : "Submit answer");
			action.textContent = answer ? `Answered: ${answer.selection.join(", ")} — change answer` : question.multi ? "Submit answer" : "Choose answer";
			action.addEventListener("click", async () => {
				if (answer && !editing) {
					editing = true;
					for (const input of fieldset.querySelectorAll("input")) input.disabled = false;
					action.textContent = "Submit changed answer";
					action.setAttribute("aria-label", "Submit changed answer");
					return;
				}
				const selection = [...fieldset.querySelectorAll("input:checked")].map((input) => input.value);
				if (!selection.length) return setStatus("Choose at least one option.", "warn");
				await postAnswer(question, item.id, selection, generation);
			});
			card.appendChild(action);
			code.parentElement.replaceWith(card);
		}
		hydrateAnswers(item.id, generation);
	}

	async function hydrateAnswers(itemId, generation) {
		try {
			const response = await previewFetch(`/api/answers?itemId=${encodeURIComponent(itemId)}`);
			if (!response.ok) throw new Error(`Answers unavailable (${response.status})`);
			const data = await response.json();
			if (generation !== state.renderGeneration) return;
			let changed = false;
			for (const [id, answer] of Object.entries(data.answers || {})) {
				if (JSON.stringify(state.answers.get(id)?.selection) !== JSON.stringify(answer.selection)) changed = true;
				state.answers.set(id, answer);
			}
			const content = state.docCache.get(itemId);
			const item = state.manifest?.items.find((candidate) => candidate.id === itemId);
			if (changed && content && item && generation === state.renderGeneration) renderDoc(item, content);
		} catch (error) {
			setStatus(error.message || "Couldn't refresh answers.", "warn");
		}
	}

	async function postAnswer(question, itemId, selection, generation) {
		const author = requireName();
		if (!author) return;
		const response = await previewFetch("/api/answer", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ questionId: question.id, question: question.question, itemId, selection, author }) });
		if (!response.ok) return setStatus(`Couldn't save answer (${response.status}).`, "error");
		state.answers.set(question.id, { selection, author, ts: Date.now() });
		if (generation === state.renderGeneration) {
			const item = state.manifest.items.find((candidate) => candidate.id === itemId);
			if (item) await renderDoc(item, state.docCache.get(itemId) || "");
		}
	}

	function svgElLabel(source) {
		const title = source.match(/^---[\s\S]*?title:\s*(.+)$/m)?.[1]?.trim();
		return (title || "Diagram preview").slice(0, 120);
	}

	function makePreviewModalButton(text, title, createContent, hooks = {}) {
		const button = document.createElement("button");
		button.type = "button";
		button.className = "btn btn-sm preview-modal-toggle";
		button.textContent = text;
		button.setAttribute("aria-label", `${text}: ${title}`);
		button.dataset.ompxUi = "";
		button.addEventListener("click", () => {
			const content = createContent();
			if (!content) {
				setStatus("Preview content is unavailable.", "warn");
				return;
			}
			const dialog = document.createElement("dialog");
			dialog.className = "preview-modal";
			dialog.dataset.ompxUi = "";
			const headingId = `preview-modal-${newRequestId()}`;
			dialog.setAttribute("aria-labelledby", headingId);
			const header = document.createElement("div");
			header.className = "preview-modal__head";
			const heading = document.createElement("h2");
			heading.id = headingId;
			heading.textContent = title;
			const controls = document.createElement("div");
			controls.className = "preview-modal__controls";
			const zoomOut = document.createElement("button");
			zoomOut.type = "button";
			zoomOut.className = "btn btn-sm";
			zoomOut.textContent = "−";
			zoomOut.setAttribute("aria-label", "Zoom out");
			const zoomLabel = document.createElement("output");
			zoomLabel.textContent = "100%";
			zoomLabel.setAttribute("aria-label", "Preview zoom");
			const zoomIn = document.createElement("button");
			zoomIn.type = "button";
			zoomIn.className = "btn btn-sm";
			zoomIn.textContent = "+";
			zoomIn.setAttribute("aria-label", "Zoom in");
			const fit = document.createElement("button");
			fit.type = "button";
			fit.className = "btn btn-sm";
			fit.textContent = "Fit";
			const close = document.createElement("button");
			close.type = "button";
			close.className = "btn btn-sm";
			close.textContent = "Close";
			controls.append(zoomOut, zoomLabel, zoomIn, fit, close);
			header.append(heading, controls);
			const viewport = document.createElement("div");
			viewport.className = "preview-modal__viewport";
			const stage = document.createElement("div");
			stage.className = "preview-modal__stage";
			content.classList.add("preview-modal__content");
			stage.appendChild(content);
			viewport.appendChild(stage);
			dialog.append(header, viewport);
			let scale = 1;
			let offsetX = 0;
			let offsetY = 0;
			let drag;
			const applyTransform = () => {
				stage.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${scale})`;
			};
			const setScale = next => {
				scale = Math.max(0.25, Math.min(3, next));
				applyTransform();
				zoomLabel.textContent = `${Math.round(scale * 100)}%`;
			};
			const fitContent = () => {
				const width = Math.max(content.scrollWidth, content.getBoundingClientRect().width / scale, 1);
				const height = Math.max(content.scrollHeight, content.getBoundingClientRect().height / scale, 1);
				offsetX = 0;
				offsetY = 0;
				setScale(Math.min(1, (viewport.clientWidth - 32) / width, (viewport.clientHeight - 32) / height));
			};
			const endPan = event => {
				if (!drag || event.pointerId !== drag.pointerId) return;
				drag = undefined;
				viewport.classList.remove("is-panning");
				if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
			};
			viewport.addEventListener("pointerdown", event => {
				if (event.button !== 0 || event.target.closest("a, button, input, textarea, select, iframe")) return;
				drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, offsetX, offsetY };
				viewport.setPointerCapture(event.pointerId);
				viewport.classList.add("is-panning");
			});
			viewport.addEventListener("pointermove", event => {
				if (!drag || event.pointerId !== drag.pointerId) return;
				offsetX = drag.offsetX + event.clientX - drag.x;
				offsetY = drag.offsetY + event.clientY - drag.y;
				applyTransform();
				event.preventDefault();
			});
			viewport.addEventListener("pointerup", endPan);
			viewport.addEventListener("pointercancel", endPan);
			zoomOut.addEventListener("click", () => setScale(scale - 0.15));
			zoomIn.addEventListener("click", () => setScale(scale + 0.15));
			fit.addEventListener("click", fitContent);
			close.addEventListener("click", () => dialog.close());
			dialog.addEventListener("click", event => {
				if (event.target === dialog) dialog.close();
			});
			dialog.addEventListener("close", () => {
				hooks.onClose?.();
				dialog.remove();
				button.focus();
			}, { once: true });
			document.body.appendChild(dialog);
			hooks.onOpen?.(content);
			dialog.showModal();
			requestAnimationFrame(fitContent);
		});
		return button;
	}

	function renderMockup(item, wrap) {
		const viewer = document.createElement("div");
		viewer.className = "mockup-viewer";
		viewer.dataset.ompxUi = "";
		const frame = document.createElement("iframe");
		frame.className = "mockup-frame";
		frame.sandbox = "allow-scripts";
		frame.src = `/mockup/${encodeURIComponent(item.id)}`;
		frame.title = item.relPath;
		frame.dataset.ompxUi = "";
		state.mockupFrame = frame;
		const openPreview = makePreviewModalButton("Open preview", item.title || item.relPath, () => {
			const modalFrame = frame.cloneNode();
			modalFrame.className = "mockup-frame preview-modal-frame";
			modalFrame.title = `${item.title || item.relPath} preview`;
			return modalFrame;
		}, {
			onOpen: modalFrame => {
				state.mockupFrame = modalFrame;
			},
			onClose: () => {
				state.mockupFrame = frame;
			},
		});
		viewer.append(openPreview, frame);
		wrap.appendChild(viewer);
	}
	window.addEventListener("message", async (event) => {
		if (event.source !== state.mockupFrame?.contentWindow || event.data?.__ompxPreview !== 1) return;
		const message = event.data;
		if (message.kind === "ready") return state.mockupFrame.contentWindow.postMessage({ __ompxPreview: 1, kind: "ack" }, "*");
		if (message.kind === "prompt" && typeof message.prompt === "string" && message.prompt.length <= 4000) {
			const author = requireName();
			if (!author) return;
			await previewFetch("/api/side-ask", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ comment: message.prompt, source: "template", itemId: state.currentId, author }) });
		}
		if (message.kind === "answer" && typeof message.questionId === "string" && typeof message.question === "string" && message.question.length <= 500 && Array.isArray(message.selection) && message.selection.length <= 10 && message.selection.every((entry) => typeof entry === "string" && entry.length <= 200)) {
			await postAnswer({ id: message.questionId, question: message.question }, state.currentId, message.selection, state.renderGeneration);
		}
	});

	// ===================================================================
	// Spec story-map parser
	// ===================================================================
	/*
	 * Parses a spec doc into a story board. Looks for story blocks matching:
	 *   ### S<n> <Title>
	 *   **Persona:** <persona>
	 *   AC bullets (lines starting with `- `)
	 * Returns { stories: [...], total, parsed } or null on total failure.
	 * Total failure triggers raw-markdown fallback.
	 */

	function parseSpecStories(md) {
		// Kept in sync with ../spec-parser.ts (the tested contract). Two shapes:
		//   heading style  — `### S1 Title` (or `## S1 Title`)
		//   bold-paragraph — `**S1 — Title** (Persona). …` + `- AC…` bullets
		const found = [];
		for (const m of md.matchAll(/^#{2,3}\s+S(\d+)\s+(.+)$/gm)) {
			found.push({ id: `S${m[1]}`, title: m[2].trim(), inlinePersona: "", bodyStart: m.index + m[0].length });
		}
		for (const m of md.matchAll(/^\*\*S(\d+)(?:\s*[—–:-])?\s+([^*\n]+)\*\*(?:\s*\(([^)\n]+)\))?/gm)) {
			found.push({
				id: `S${m[1]}`,
				title: m[2].trim(),
				inlinePersona: m[3] ? m[3].trim() : "",
				bodyStart: m.index + m[0].length,
			});
		}
		if (found.length === 0) return null;
		found.sort((a, b) => a.bodyStart - b.bodyStart);

		const stories = [];
		for (let i = 0; i < found.length; i++) {
			const match = found[i];
			const hardEnd = i + 1 < found.length ? found[i + 1].bodyStart : md.length;
			let body = md.slice(match.bodyStart, hardEnd);
			const nextHeading = body.search(/^#{1,6}\s/m);
			if (nextHeading !== -1) body = body.slice(0, nextHeading);

			// Persona: inline `(Persona)` on the bold form, else a Persona: line.
			let persona = match.inlinePersona;
			if (!persona) {
				const personaM = body.match(/\*\*Persona:?\*\*\s*(.+)/i) || body.match(/Persona:\s*(.+)/i);
				if (personaM) persona = personaM[1].trim().split(/\s{2,}|\||—/)[0].trim();
			}

			// Acceptance criteria: explicit block marker, else every body bullet.
			let acCount = 0;
			const acMarker = body.match(/(?:Acceptance criteria|AC)[:\s]*\n([\s\S]+)/i);
			const acSource = acMarker ? acMarker[1] : body;
			for (const line of acSource.split("\n")) {
				if (/^\s*[-*]\s+\S/.test(line)) acCount++;
			}

			stories.push({ id: match.id, title: match.title, persona: persona || "—", acCount });
		}
		return { stories, total: found.length, parsed: stories.length };
	}

	async function renderSpecStoryMap(specId) {
		state.currentView = "storymap";
		setTabSelected("storymap");
		el.content.setAttribute("aria-busy", "true");
		const item = state.manifest.items.find((i) => i.id === specId);
		let content = state.docCache.get(specId);
		if (!content) {
			const res = await fetch(`/api/doc/${specId}`);
			const data = await res.json();
			content = data.content;
			state.docCache.set(specId, content);
		}

		const parsed = parseSpecStories(content);
		if (!parsed) {
			// Total failure -> raw doc view + toast.
			setStatus("Story parse failed — showing raw.", "warn");
			setTabSelected("overview");
			state.currentView = "doc";
			await renderDoc(item, content);
			return;
		}

		const wrap = document.createElement("div");
		wrap.className = "storymap";
		const head = document.createElement("div");
		head.className = "storymap-head";
		const h2 = document.createElement("h2");
		h2.textContent = `Story map — ${item.relPath}`;
		const ind = document.createElement("span");
		ind.className = "storymap-indicator";
		ind.textContent = COPY.storyIndicator(parsed.parsed, parsed.total);
		head.appendChild(h2);
		head.appendChild(ind);
		wrap.appendChild(head);

		const board = document.createElement("div");
		board.className = "storymap-board";
		for (const s of parsed.stories) {
			const card = document.createElement("a");
			card.className = "story-card";
			card.href = `#doc=${specId}`;
			card.addEventListener("click", (e) => {
				e.preventDefault();
				selectDoc(specId);
			});
			card.innerHTML = "";
			const idEl = document.createElement("div");
			idEl.className = "story-id";
			idEl.textContent = s.id;
			const titleEl = document.createElement("p");
			titleEl.className = "story-title";
			titleEl.textContent = s.title;
			const badge = document.createElement("span");
			badge.className = "story-badge";
			badge.textContent = s.persona;
			const ac = document.createElement("div");
			ac.className = "story-ac";
			ac.textContent = `${s.acCount} AC`;
			card.appendChild(idEl);
			card.appendChild(titleEl);
			card.appendChild(badge);
			card.appendChild(ac);
			board.appendChild(card);
		}
		wrap.appendChild(board);
		el.content.innerHTML = "";
		el.content.appendChild(wrap);
		el.content.setAttribute("aria-busy", "false");
	}

	// ===================================================================
	// Phases (NOW/NEXT/NOT) parser + render
	// ===================================================================

function parseSpecPhases(md) {
	// Kept in sync with ../spec-parser.ts (the tested contract). Shapes:
	//   row-oriented table    — `| NOW | contents |` per row (skill template)
	//   column-oriented table — `| NOW | NEXT | NOT |` header + value rows
	//   inline list           — `- NOW: contents`
	const cols = { NOW: [], NEXT: [], NOT: [] };
	const sectionRe = /(?:^|\n)#{1,6}\s*[^\n]*(?:cut.?line|phases?)[^\n]*\n([\s\S]*?)(?=\n#{1,6}\s|\n*$)/i;
	const m = md.match(sectionRe);
	const body = m ? m[1] : null;
	if (!body) return null;

	let headerOrder = null;
	for (const raw of body.split("\n")) {
		const line = raw.trim();
		if (!line || /^[-:|\s]+$/.test(line)) continue;
		let arr = line.split("|").map((c) => c.trim());
		if (arr[0] === "") arr = arr.slice(1);
		if (arr[arr.length - 1] === "") arr = arr.slice(0, -1);
		if (arr.length < 2) {
			const im = line.match(/^(?:[-*]\s+)?(NOW|NEXT|NOT)\s*[:—–-]\s*(.+)/i);
			if (im) cols[im[1].toUpperCase()].push(im[2].trim());
			continue;
		}
		// A row whose EVERY cell is a bare phase label is a column-table header.
		if (!headerOrder && arr.every((c) => /^(NOW|NEXT|NOT)$/i.test(c))) {
			headerOrder = arr.map((c) => c.toUpperCase());
			continue;
		}
		// Row-oriented: first cell is the phase label (suffixes allowed).
		const rowKeyM = arr[0].toUpperCase().match(/^(NOW|NEXT|NOT)\b/);
		if (rowKeyM) {
			const content = arr.slice(1).join(" — ").trim();
			if (content) cols[rowKeyM[1]].push(content);
			continue;
		}
		// Column-oriented: a `| NOW | NEXT | NOT |` header row sets the order.
		if (!headerOrder) {
			const order = arr.map((c) => c.toUpperCase().match(/^(NOW|NEXT|NOT)$/)?.[0]).filter(Boolean);
			if (order.length >= 1) { headerOrder = order; continue; }
		}
		if (headerOrder) {
			for (let i = 0; i < headerOrder.length && i < arr.length; i++) {
				if (arr[i].trim()) cols[headerOrder[i]].push(arr[i].trim());
			}
		}
	}
	if (!cols.NOW.length && !cols.NEXT.length && !cols.NOT.length) return null;
	return cols;
}

	async function renderPhases(specId) {
		state.currentView = "phases";
		setTabSelected("phases");
		let content = state.docCache.get(specId);
		if (!content) {
			const res = await fetch(`/api/doc/${specId}`);
			const data = await res.json();
			content = data.content;
			state.docCache.set(specId, content);
		}
		const cols = parseSpecPhases(content);
		if (!cols) {
			setStatus("No cut-lines table found in spec.", "warn");
			return;
		}
		const wrap = document.createElement("div");
		const head = document.createElement("div");
		head.className = "storymap-head";
		const h2 = document.createElement("h2");
		h2.textContent = "Phases";
		head.appendChild(h2);
		wrap.appendChild(head);

		const board = document.createElement("div");
		board.className = "phases-board";
		for (const [label, items] of Object.entries(cols)) {
			const col = document.createElement("div");
			col.className = "phase-col";
			const colHead = document.createElement("div");
			colHead.className = "phase-head";
			colHead.textContent = label;
			col.appendChild(colHead);
			for (const it of items) {
				const row = document.createElement("div");
				row.className = "phase-item";
				row.textContent = it;
				col.appendChild(row);
			}
			board.appendChild(col);
		}
		wrap.appendChild(board);
		el.content.innerHTML = "";
		el.content.appendChild(wrap);
	}

	// ===================================================================
	// Side-ask
	// ===================================================================

	function setupSideAsk() {
		el.askBtn.addEventListener("click", () => togglePanel(el.askPanel, el.askBtn));
		el.askForm.addEventListener("submit", onSubmitAsk);
		el.askInput.addEventListener("keydown", (e) => {
			if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
				e.preventDefault();
				el.askForm.requestSubmit();
			}
		});
		// Live char count
		el.askInput.addEventListener("input", () => {
			const len = el.askInput.value.length;
			el.askRate.textContent = `${len}/10000`;
		});
	}

	async function onSubmitAsk(e) {
		e.preventDefault();
		const comment = el.askInput.value.trim();
		hideEl(el.askError);
		hideEl(el.askToast);
		if (!comment) {
			el.askInput.setAttribute("aria-invalid", "true");
			return;
		}
		// Capture author before disabling the button so requireName can focus
		// #commentAuthor when missing, matching comment/reply/answer paths.
		const author = requireName(el.askSubmit);
		if (!author) return;
		el.askInput.removeAttribute("aria-invalid");
		el.askSubmit.disabled = true;
		const original = el.askSubmit.textContent;
		el.askSubmit.textContent = "Sending…";

		try {
			const res = await fetch("/api/side-ask", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"x-ompx-preview": "1", // SIDE_ASK_HEADER required by server
				},
				body: JSON.stringify({ comment, itemId: state.currentId, author }),
			});
			if (res.status === 202) {
				el.askToast.textContent = COPY.askSent;
				showEl(el.askToast);
				el.askInput.value = "";
				el.askRate.textContent = "";
			} else {
				throw await mapAskError(res);
			}
		} catch (err) {
			el.askError.textContent = err.message || "Couldn't send your message.";
			showEl(el.askError);
		} finally {
			el.askSubmit.disabled = false;
			el.askSubmit.textContent = original;
		}
	}

	async function mapAskError(res) {
		if (res.status === 403) return new Error("This page can't send asks (missing preview header).");
		if (res.status === 422) {
			const body = await safeJson(res);
			return new Error(`Too long — max 10,000 characters (currently ${body?.length ?? "?"}).`);
		}
		if (res.status === 429) {
			const retry = res.headers.get("retry-after");
			return new Error(`Rate limit — wait ${retry || "a moment"}.`);
		}
		if (res.status === 503) return new Error(COPY.askNoAgent);
		return new Error(`Couldn't send your message (${res.status}).`);
	}

	function updateAskContext(item) {
		if (!item) {
			hideEl(el.askContext);
			return;
		}
		el.askContext.textContent = `Viewing: ${item.relPath} (attached context)`;
		showEl(el.askContext);
	}

	// ===================================================================
	// Share panel
	// ===================================================================

	function setupShare() {
		if (state.isLoopback) {
			showEl(el.shareBtn);
		} else {
			showEl(el.sharedBadge);
			if (state.displayName) {
				el.nameChip.textContent = state.displayName;
				showEl(el.nameChip);
			}
		}
		el.shareBtn.addEventListener("click", () => togglePanel(el.sharePanel, el.shareBtn));
		for (const btn of document.querySelectorAll("[data-copy]")) {
			btn.addEventListener("click", () => {
				const target = $(btn.dataset.copy);
				if (target) copyText(target.textContent, btn);
			});
		}
	}

	// ===================================================================
	// Panels + nav drawer
	// ===================================================================

	function openPanel(panel, trigger, focusTarget) {
		if (!panel) return;
		if (state.activePanel && state.activePanel !== panel) closePanel(state.activePanel, false);
		if (trigger instanceof HTMLElement && !panel.contains(trigger)) state.panelTriggers.set(panel.id, trigger);
		showEl(panel);
		state.activePanel = panel;
		if (panel === el.askPanel) el.askBtn.setAttribute("aria-expanded", "true");
		if (panel === el.sharePanel) el.shareBtn.setAttribute("aria-expanded", "true");
		setTimeout(() => (focusTarget || panel.querySelector(".panel-close, button, input, textarea"))?.focus(), 0);
	}

	function closePanel(panel, restoreFocus = true) {
		if (!panel || panel.hidden) return;
		hideEl(panel);
		if (state.activePanel === panel) state.activePanel = null;
		if (panel === el.askPanel) el.askBtn.setAttribute("aria-expanded", "false");
		if (panel === el.sharePanel) el.shareBtn.setAttribute("aria-expanded", "false");
		const trigger = state.panelTriggers.get(panel.id);
		if (restoreFocus && trigger?.isConnected) {
			setTimeout(() => {
				// Hidden/zero-size triggers (e.g. the selection float after hide())
				// are not usable focus targets — fall back to main content.
				const usable = !trigger.hidden && !trigger.disabled && trigger.getClientRects().length > 0;
				(usable ? trigger : el.content)?.focus();
			}, 0);
		}
	}

	function trapPanelFocus(event) {
		const panel = state.activePanel;
		if (event.key !== "Tab" || !panel || panel.hidden) return;
		const focusable = [...panel.querySelectorAll("a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])")]
			.filter((node) => !node.hidden && node.getClientRects().length);
		if (!focusable.length) return;
		const first = focusable[0];
		const last = focusable[focusable.length - 1];
		if (event.shiftKey && document.activeElement === first) {
			event.preventDefault();
			last.focus();
		} else if (!event.shiftKey && (document.activeElement === last || !panel.contains(document.activeElement))) {
			event.preventDefault();
			first.focus();
		}
	}

	function togglePanel(panel, trigger) {
		if (panel.hidden) openPanel(panel, trigger, panel === el.askPanel ? el.askInput : undefined);
		else closePanel(panel);
	}

	document.querySelectorAll("[data-close]").forEach((btn) => {
		btn.addEventListener("click", () => closePanel($(btn.dataset.close)));
	});

	el.menuToggle.addEventListener("click", () => {
		const open = el.nav.classList.toggle("open");
		el.menuToggle.setAttribute("aria-expanded", String(open));
	});

	function closeNavDrawer() {
		el.nav.classList.remove("open");
		el.menuToggle.setAttribute("aria-expanded", "false");
	}

	// ===================================================================
	// EventSource (SSE)
	// ===================================================================

	function connectSSE() {
		setLiveState("connecting");
		if (state.es) state.es.close();
		const es = new EventSource("/events");
		state.es = es;

		es.addEventListener("open", () => {
			setLiveState("live");
			state.esRetryDelay = 1000;
		});

		es.addEventListener("manifest", (e) => {
			const data = JSON.parse(e.data);
			state.docCache.clear();
			applyManifest(data.manifest);
		});

		es.addEventListener("doc-changed", (e) => {
			const data = JSON.parse(e.data);
			state.docCache.delete(data.id);
			if (data.id === state.currentId) selectDoc(data.id);
		});

		es.addEventListener("share-revoked", () => {
			showEl(el.endedOverlay);
			if (state.es) state.es.close();
		});

		es.addEventListener("error", () => {
			setLiveState("reconnect");
			es.close();
			// Exponential backoff reconnect.
			setTimeout(() => {
				state.esRetryDelay = Math.min(state.esRetryDelay * 1.5, 15000);
				connectSSE();
			}, state.esRetryDelay);
		});
	}

	// ===================================================================
	// Helpers
	// ===================================================================

	function setLiveState(s) {
		el.liveDot.dataset.state = s;
		if (s === "live") {
			el.liveDot.title = COPY.liveOk;
			el.liveLabel.textContent = COPY.liveOk;
		} else if (s === "reconnect") {
			el.liveDot.title = COPY.liveReconnect;
			el.liveLabel.textContent = COPY.liveReconnect;
		} else {
			el.liveDot.title = "Connecting…";
			el.liveLabel.textContent = "Connecting…";
		}
	}

	function setStatus(msg, level) {
		el.statusText.textContent = msg;
		el.statusStrip.dataset.level = level || "";
	}

	function highlightTreeItem(id) {
		for (const a of el.tree.querySelectorAll(".tree-link")) {
			if (a.dataset.id === id) a.setAttribute("aria-current", "true");
			else a.removeAttribute("aria-current");
		}
	}

	function setTabSelected(view) {
		for (const tab of el.viewTabs.querySelectorAll(".view-tab")) {
			tab.setAttribute("aria-selected", tab.dataset.view === view ? "true" : "false");
		}
	}

	function getHashId() {
		const h = location.hash;
		const m = h.match(/doc=([a-f0-9]+)/);
		return m ? m[1] : null;
	}

	function showEl(node) {
		if (node) node.hidden = false;
	}
	function hideEl(node) {
		if (node) node.hidden = true;
	}

	function relativeTime(ms) {
		const diff = Date.now() - ms;
		const s = Math.floor(diff / 1000);
		if (s < 60) return "just now";
		const m = Math.floor(s / 60);
		if (m < 60) return `${m}m ago`;
		const h = Math.floor(m / 60);
		if (h < 24) return `${h}h ago`;
		const d = Math.floor(h / 24);
		return `${d}d ago`;
	}

	async function copyText(text, btn) {
		try {
			await navigator.clipboard.writeText(text);
			const original = btn.textContent;
			btn.textContent = "Copied";
			setTimeout(() => (btn.textContent = original), 1500);
		} catch {
			// Fallback for non-secure contexts
			const ta = document.createElement("textarea");
			ta.value = text;
			document.body.appendChild(ta);
			ta.select();
			document.execCommand("copy");
			ta.remove();
		}
	}

	async function safeJson(res) {
		try {
			return await res.json();
		} catch {
			return null;
		}
	}

	function renderErrorBanner(err, item) {
		el.content.setAttribute("aria-busy", "false");
		const banner = document.createElement("div");
		banner.className = "error-banner";
		const heading = document.createElement("h2");
		heading.textContent = item?.kind === "canvas" ? "Canvas couldn’t be displayed" : "Document couldn’t be displayed";
		const context = document.createElement("p");
		context.textContent = item?.relPath ? `File: ${item.relPath}` : "The selected item could not be loaded.";
		const code = document.createElement("p");
		const codeEl = document.createElement("code");
		codeEl.textContent = err.field ? `${err.field}: ${err.message || String(err)}` : err.message || String(err);
		code.appendChild(codeEl);
		const actions = document.createElement("div");
		actions.className = "error-banner__actions";
		const retry = document.createElement("button");
		retry.type = "button";
		retry.className = "btn btn-primary";
		retry.textContent = "Retry";
		retry.addEventListener("click", () => {
			if (state.currentId) selectDoc(state.currentId);
		});
		actions.appendChild(retry);
		if (item?.kind === "canvas") {
			const send = document.createElement("button");
			send.type = "button";
			send.className = "btn";
			send.textContent = "Send error to agent";
			const feedbackAvailable = state.manifest?.capabilities?.feedback === true;
			send.disabled = !feedbackAvailable;
			send.title = feedbackAvailable ? "" : "Feedback needs a live agent session.";
			send.addEventListener("click", async () => {
				const author = requireName(send);
				if (!author) return;
				send.disabled = true;
				const comment = `Canvas ${item.relPath} could not be displayed${err.field ? ` at ${err.field}` : ""}: ${err.message || String(err)}`;
				try {
					const response = await previewFetch("/api/side-ask", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ comment, source: "user", itemId: item.id, author }),
					});
					if (!response.ok) throw new Error(`Couldn't send error (${response.status})`);
					send.textContent = "Error sent to agent";
					setStatus("Error sent to agent.", "ok");
				} catch (error) {
					send.disabled = false;
					setStatus(error.message || "Couldn't send error to agent.", "error");
				}
			});
			actions.appendChild(send);
		}
		banner.append(heading, context, code, actions);
		el.content.innerHTML = "";
		el.content.appendChild(banner);
	}

	// ===================================================================
	// View tab wiring
	// ===================================================================

	for (const tab of el.viewTabs.querySelectorAll(".view-tab")) {
		tab.addEventListener("click", () => {
			const view = tab.dataset.view;
			if (view === "overview") renderOverview(state.manifest);
			else if (view === "storymap" && state.currentId) renderSpecStoryMap(state.currentId);
			else if (view === "phases" && state.currentId) renderPhases(state.currentId);
		});
	}

	window.addEventListener("hashchange", () => {
		const id = getHashId();
		if (id) selectDoc(id);
	});

	document.addEventListener("keydown", (e) => {
		trapPanelFocus(e);
		if (e.key === "Escape") {
			if (state.activePanel) closePanel(state.activePanel);
			closeNavDrawer();
		}
	});

	// ===================================================================
	// Boot
	// ===================================================================

	async function boot() {
		setupSideAsk();
		setupShare();
		setupComments();
		connectSSE();
		try {
			const manifest = await fetchManifest();
			applyManifest(manifest);
			el.tree.setAttribute("aria-busy", "false");
		} catch (err) {
			el.tree.setAttribute("aria-busy", "false");
			const empty = document.createElement("div");
			empty.className = "empty-state";
			const h2 = document.createElement("h2");
			h2.textContent = "Couldn't load the bundle";
			const p = document.createElement("p");
			p.textContent = COPY.empty("docs/product");
			empty.appendChild(h2);
			empty.appendChild(p);
			el.tree.innerHTML = "";
			el.tree.appendChild(empty);
			setStatus(err.message, "error");
		}
	}

	// Defer: vendor scripts load before client.js (defer), so globals are ready.
	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", boot);
	} else {
		boot();
	}
})();
