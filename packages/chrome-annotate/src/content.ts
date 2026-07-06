import type { AnnotationElementInfo, AnnotationPayload, AnnotationRect } from "./types";

type ExtWindow = Window &
	typeof globalThis & {
		__ompxExtAnnotateActive?: boolean;
		__ompxExtAnnotateFocusGuard?: EventListener;
		__ompxExtAnnotateListenerInstalled?: boolean;
		__ompxExtAnnotateSetChromeVisible?: (visible: boolean) => void;
		__ompxExtAnnotateTeardown?: () => void;
	};

interface RectEntry {
	el: HTMLDivElement;
	badge: HTMLDivElement;
	pageX: number;
	pageY: number;
	width: number;
	height: number;
	note: string;
	element?: AnnotationElementInfo;
}

interface DragState {
	startX: number;
	startY: number;
	preview: HTMLDivElement;
}

interface SubmitResponse {
	ok?: boolean;
	error?: string;
}

interface PairResponse {
	ok?: boolean;
	error?: string;
	session?: string;
}

interface StatusResponse {
	ok?: boolean;
	error?: string;
	host?: string | null;
	paired?: boolean;
	session?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

(() => {
	const extWindow = window as ExtWindow;
	const HOST_ID = "__ompx-ext-annotate-host";
	const MIN_RECT = 4;
	const NOTE_MAX = 1000;

	const openOverlay = () => {
		if (extWindow.__ompxExtAnnotateActive) return;
		extWindow.__ompxExtAnnotateActive = true;

		const install = () => {
			const doc = document;
			const root = doc.documentElement;
			if (!root) return;

			const stale = doc.getElementById(HOST_ID);
			stale?.remove();

			const host = doc.createElement("div");
			host.id = HOST_ID;
			host.setAttribute("data-ompx", "chrome-annotate");
			host.style.position = "fixed";
			host.style.top = "0";
			host.style.left = "0";
			host.style.width = "0";
			host.style.height = "0";
			host.style.margin = "0";
			host.style.padding = "0";
			host.style.border = "0";
			host.style.zIndex = "2147483647";
			host.style.pointerEvents = "none";
			const shadow = host.attachShadow({ mode: "open" });
			root.appendChild(host);

			const style = doc.createElement("style");
			style.textContent = [
				":host { all: initial; }",
				"* { box-sizing: border-box; }",
				".layer { position: fixed; top: 0; left: 0; pointer-events: none; }",
				".rects { will-change: transform; }",
				".rect { position: absolute; border: 2px solid #e53935; background: rgba(229,57,53,0.08); pointer-events: none; }",
				".badge { position: absolute; top: -1px; left: -1px; min-width: 16px; height: 16px; padding: 0 3px; font: 700 11px/16px ui-sans-serif, system-ui, -apple-system, sans-serif; color: #fff; background: #e53935; text-align: center; border-radius: 0 0 4px 0; }",
				".capture { position: fixed; inset: 0; pointer-events: auto; cursor: crosshair; background: rgba(0,0,0,0.02); }",
				".preview { position: fixed; border: 2px dashed #e53935; background: rgba(229,57,53,0.08); pointer-events: none; }",
				".hl { position: fixed; pointer-events: none; background: rgba(77,144,254,0.28); border: 1px solid rgba(13,108,242,0.85); }",
				".hl-tip { position: fixed; pointer-events: none; font: 500 11px/1.3 ui-monospace, SFMono-Regular, Menlo, monospace; color: #fff; background: #323232; padding: 2px 6px; border-radius: 4px; max-width: 60vw; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }",
				".tb-head { display: flex; align-items: center; gap: 6px; margin: -10px -10px 8px; padding: 6px 8px 6px 10px; cursor: grab; user-select: none; border-bottom: 1px solid #e8e8e8; border-radius: 8px 8px 0 0; background: #fafafa; }",
				".tb-title { flex: 1 1 auto; font: 600 12px/1.2 ui-sans-serif, system-ui, -apple-system, sans-serif; color: #444; }",
				".tb-min { flex: 0 0 auto; width: 20px; height: 20px; padding: 0; border: 0; background: transparent; cursor: pointer; font: 700 13px/20px ui-sans-serif, system-ui, -apple-system, sans-serif; color: #666; border-radius: 4px; }",
				".tb-min:hover { background: #ececec; }",
				".pairing { margin-bottom: 8px; padding: 8px; border: 1px solid #f9c74f; border-radius: 6px; background: #fff8e1; }",
				".pairing-title { margin-bottom: 6px; font: 600 12px/1.3 ui-sans-serif, system-ui, -apple-system, sans-serif; color: #5f4700; }",
				".pairing label { display: block; margin-bottom: 6px; font: 600 11px/1.3 ui-sans-serif, system-ui, -apple-system, sans-serif; color: #5f4700; }",
				".pairing input { display: block; width: 100%; margin-top: 3px; padding: 5px 6px; border: 1px solid #d7b84f; border-radius: 5px; color: #111; background: #fff; font: 400 12px/1.3 ui-sans-serif, system-ui, -apple-system, sans-serif; }",
				".pill { position: fixed; top: 12px; right: 12px; pointer-events: auto; font: 600 12px/1 ui-sans-serif, system-ui, -apple-system, sans-serif; color: #fff; background: #e53935; border: 0; border-radius: 999px; padding: 9px 14px; box-shadow: 0 4px 14px rgba(0,0,0,0.3); cursor: grab; }",
				".note-input { position: fixed; pointer-events: auto; font: 400 12px/1.4 ui-sans-serif, system-ui, -apple-system, sans-serif; padding: 3px 6px; border: 1px solid #e53935; border-radius: 4px; background: #fff; color: #111; box-shadow: 0 2px 6px rgba(0,0,0,0.25); width: 220px; }",
				".toolbar { position: fixed; top: 12px; right: 12px; width: 260px; pointer-events: auto; font: 400 13px/1.4 ui-sans-serif, system-ui, -apple-system, sans-serif; color: #111; background: #fff; border: 1px solid #d0d0d0; border-radius: 8px; box-shadow: 0 6px 20px rgba(0,0,0,0.25); padding: 10px; }",
				".row { display: flex; gap: 6px; margin-bottom: 8px; }",
				".btn { flex: 1 1 auto; font: inherit; padding: 6px 8px; border: 1px solid #c0c0c0; border-radius: 6px; background: #f5f5f5; color: #111; cursor: pointer; }",
				".btn:hover { background: #ececec; }",
				".btn.active { background: #e53935; border-color: #e53935; color: #fff; }",
				".btn.primary { background: #1e88e5; border-color: #1e88e5; color: #fff; }",
				".btn.primary:hover { background: #1976d2; }",
				".btn[disabled] { opacity: 0.5; cursor: default; }",
				"textarea.comment { width: 100%; min-height: 64px; resize: vertical; font: 400 13px/1.4 ui-sans-serif, system-ui, -apple-system, sans-serif; padding: 6px 8px; border: 1px solid #c0c0c0; border-radius: 6px; color: #111; background: #fff; margin-bottom: 8px; }",
				".status { min-height: 16px; font-size: 12px; color: #666; word-break: break-word; }",
				".toast { position: fixed; bottom: 18px; left: 50%; transform: translateX(-50%); pointer-events: none; font: 500 13px/1.4 ui-sans-serif, system-ui, -apple-system, sans-serif; color: #fff; background: #323232; padding: 8px 14px; border-radius: 6px; box-shadow: 0 4px 14px rgba(0,0,0,0.3); max-width: 70vw; }",
				".toast.error { background: #c62828; }",
			].join("\n");
			shadow.appendChild(style);

			const rectsLayer = doc.createElement("div");
			rectsLayer.className = "layer rects";
			rectsLayer.setAttribute("data-ompx-layer", "rects");

			const chromeLayer = doc.createElement("div");
			chromeLayer.className = "layer chrome";
			chromeLayer.setAttribute("data-ompx-layer", "chrome");

			shadow.appendChild(rectsLayer);
			shadow.appendChild(chromeLayer);

			const scrollX = () => window.scrollX || window.pageXOffset || 0;
			const scrollY = () => window.scrollY || window.pageYOffset || 0;
			const syncScroll = () => {
				rectsLayer.style.transform = `translate(${-scrollX()}px,${-scrollY()}px)`;
			};
			syncScroll();
			window.addEventListener("scroll", syncScroll, { capture: true, passive: true });
			window.addEventListener("resize", syncScroll, { passive: true });

			const focusEventIsOurs = (event: FocusEvent) =>
				event.target === host || (event.type === "focusout" && event.relatedTarget === host);
			const focusGuard = (event: Event) => {
				if (!extWindow.__ompxExtAnnotateActive) return;
				if (event instanceof FocusEvent && focusEventIsOurs(event)) event.stopImmediatePropagation();
			};
			const focusEvents = ["focusin", "focusout", "focus"];
			const priorGuard = extWindow.__ompxExtAnnotateFocusGuard;
			if (priorGuard) {
				for (const eventName of focusEvents) window.removeEventListener(eventName, priorGuard, true);
			}
			extWindow.__ompxExtAnnotateFocusGuard = focusGuard;
			for (const eventName of focusEvents) window.addEventListener(eventName, focusGuard, true);

			const stopOverlayKeys = (event: Event) => event.stopPropagation();
			for (const eventName of ["keydown", "keypress", "keyup"]) shadow.addEventListener(eventName, stopOverlayKeys);

			shadow.addEventListener("pointerdown", event => {
				if (!extWindow.__ompxExtAnnotateActive) return;
				if (event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement) {
					event.target.focus({ preventScroll: true });
				}
			});

			const rects: RectEntry[] = [];
			let minimized = false;

			const targetAt = (clientX: number, clientY: number): Element | null => {
				try {
					const stack = doc.elementsFromPoint(clientX, clientY);
					for (const item of stack) {
						if (item.id !== HOST_ID) return item;
					}
					const fallback = doc.elementFromPoint(clientX, clientY);
					return fallback?.id === HOST_ID ? null : fallback;
				} catch {
					return null;
				}
			};

			const describeElement = (target: Element | null): AnnotationElementInfo | undefined => {
				try {
					if (!target) return undefined;

					const parts: string[] = [];
					let node: Element | null = target;
					for (let i = 0; node && i < 6; i++) {
						const tag = node.tagName.toLowerCase();
						if (node.id) {
							parts.unshift(`#${CSS.escape(node.id)}`);
							break;
						}
						let index = 1;
						let sameTag = false;
						let sibling = node.previousElementSibling;
						while (sibling) {
							if (sibling.tagName.toLowerCase() === tag) {
								index++;
								sameTag = true;
							}
							sibling = sibling.previousElementSibling;
						}
						sibling = node.nextElementSibling;
						while (sibling) {
							if (sibling.tagName.toLowerCase() === tag) {
								sameTag = true;
								break;
							}
							sibling = sibling.nextElementSibling;
						}
						parts.unshift(sameTag ? `${tag}:nth-of-type(${index})` : tag);
						if (node === doc.body || node === doc.documentElement) break;
						node = node.parentElement;
					}

					const bounds = target.getBoundingClientRect();
					const info: AnnotationElementInfo = {
						selector: parts.join(" > "),
						tag: target.tagName.toLowerCase(),
						rect: {
							x: Math.round(bounds.x),
							y: Math.round(bounds.y),
							width: Math.round(bounds.width),
							height: Math.round(bounds.height),
						},
					};
					if (target.id) info.id = target.id;
					const classes = Array.prototype.slice.call(target.classList, 0, 3) as string[];
					if (classes.length > 0) info.classes = classes;
					const role = target.getAttribute("role");
					if (role) info.role = role;
					const rawName =
						target.getAttribute("aria-label") ||
						target.getAttribute("alt") ||
						target.getAttribute("placeholder") ||
						target.getAttribute("title");
					const name = rawName ? rawName.trim() : "";
					if (name) info.name = name.slice(0, 120);
					const text = target instanceof HTMLElement ? target.innerText.trim().replace(/\s+/g, " ") : "";
					if (text) info.text = text.slice(0, 200);
					return info;
				} catch {
					return undefined;
				}
			};

			const captureElementInfo = (clientX: number, clientY: number) => describeElement(targetAt(clientX, clientY));

			const renumber = () => {
				for (let i = 0; i < rects.length; i++) rects[i].badge.textContent = String(i + 1);
				if (minimized) pill.textContent = rects.length ? `\u270E ${rects.length}` : "\u270E";
			};

			const addRect = (
				clientX: number,
				clientY: number,
				width: number,
				height: number,
				pickedEl?: Element,
			): RectEntry => {
				const pageX = clientX + scrollX();
				const pageY = clientY + scrollY();
				const el = doc.createElement("div");
				el.className = "rect";
				el.style.left = `${pageX}px`;
				el.style.top = `${pageY}px`;
				el.style.width = `${width}px`;
				el.style.height = `${height}px`;
				const badge = doc.createElement("div");
				badge.className = "badge";
				el.appendChild(badge);
				rectsLayer.appendChild(el);
				const entry: RectEntry = { el, badge, pageX, pageY, width, height, note: "" };
				const element = pickedEl
					? describeElement(pickedEl)
					: captureElementInfo(clientX + width / 2, clientY + height / 2);
				if (element) entry.element = element;
				rects.push(entry);
				renumber();
				return entry;
			};

			const clearRects = () => {
				for (const rect of rects) rect.el.remove();
				rects.length = 0;
				renumber();
			};

			const capture = doc.createElement("div");
			capture.className = "capture";
			capture.style.display = "none";
			chromeLayer.appendChild(capture);

			const toolbar = doc.createElement("div");
			toolbar.className = "toolbar";

			const head = doc.createElement("div");
			head.className = "tb-head";
			const headTitle = doc.createElement("div");
			headTitle.className = "tb-title";
			headTitle.textContent = "Annotate";
			const minBtn = doc.createElement("button");
			minBtn.type = "button";
			minBtn.className = "tb-min";
			minBtn.textContent = "\u2013";
			minBtn.title = "Minimize";
			const closeBtn = doc.createElement("button");
			closeBtn.type = "button";
			closeBtn.className = "tb-min";
			closeBtn.textContent = "\u2715";
			closeBtn.title = "Close";
			head.appendChild(headTitle);
			head.appendChild(minBtn);
			head.appendChild(closeBtn);

			const row = doc.createElement("div");
			row.className = "row";
			const drawBtn = doc.createElement("button");
			drawBtn.type = "button";
			drawBtn.className = "btn";
			drawBtn.textContent = "Draw";
			const pickBtn = doc.createElement("button");
			pickBtn.type = "button";
			pickBtn.className = "btn";
			pickBtn.textContent = "Pick";
			const clearBtn = doc.createElement("button");
			clearBtn.type = "button";
			clearBtn.className = "btn";
			clearBtn.textContent = "Clear";
			row.appendChild(drawBtn);
			row.appendChild(pickBtn);
			row.appendChild(clearBtn);

			const comment = doc.createElement("textarea");
			comment.className = "comment";
			comment.placeholder = "Describe what to fix...";

			const pairBanner = doc.createElement("div");
			pairBanner.className = "pairing";
			pairBanner.style.display = "none";
			const pairTitle = doc.createElement("div");
			pairTitle.className = "pairing-title";
			pairTitle.textContent = "Pair this tab to send annotations.";
			const pairHostLabel = doc.createElement("label");
			pairHostLabel.textContent = "Host";
			const pairHostInput = doc.createElement("input");
			pairHostInput.type = "text";
			pairHostInput.placeholder = "tailscale-ip:3848";
			pairHostInput.autocomplete = "off";
			pairHostLabel.appendChild(pairHostInput);
			const pairCodeLabel = doc.createElement("label");
			pairCodeLabel.textContent = "Pairing code";
			const pairCodeInput = doc.createElement("input");
			pairCodeInput.type = "text";
			pairCodeInput.autocomplete = "off";
			pairCodeLabel.appendChild(pairCodeInput);
			const pairBtn = doc.createElement("button");
			pairBtn.type = "button";
			pairBtn.className = "btn primary";
			pairBtn.textContent = "Pair";
			pairBanner.appendChild(pairTitle);
			pairBanner.appendChild(pairHostLabel);
			pairBanner.appendChild(pairCodeLabel);
			pairBanner.appendChild(pairBtn);

			const sendBtn = doc.createElement("button");
			sendBtn.type = "button";
			sendBtn.className = "btn primary";
			sendBtn.textContent = "Send to agent";

			const status = doc.createElement("div");
			status.className = "status";

			toolbar.appendChild(head);
			toolbar.appendChild(row);
			toolbar.appendChild(pairBanner);
			toolbar.appendChild(comment);
			toolbar.appendChild(sendBtn);
			toolbar.appendChild(status);
			chromeLayer.appendChild(toolbar);

			const pill = doc.createElement("button");
			pill.type = "button";
			pill.className = "pill";
			pill.style.display = "none";
			pill.textContent = "\u270E";
			pill.title = "Annotate";
			chromeLayer.appendChild(pill);

			const hl = doc.createElement("div");
			hl.className = "hl";
			hl.style.display = "none";
			chromeLayer.appendChild(hl);
			const hlTip = doc.createElement("div");
			hlTip.className = "hl-tip";
			hlTip.style.display = "none";
			chromeLayer.appendChild(hlTip);

			const setStatus = (msg: string) => {
				status.textContent = msg;
			};

			let toastEl: HTMLDivElement | null = null;
			let toastTimer = 0;
			const toast = (msg: string, isError = false) => {
				toastEl?.remove();
				toastEl = doc.createElement("div");
				toastEl.className = isError ? "toast error" : "toast";
				toastEl.textContent = msg;
				chromeLayer.appendChild(toastEl);
				window.clearTimeout(toastTimer);
				toastTimer = window.setTimeout(() => {
					toastEl?.remove();
					toastEl = null;
				}, 2600);
			};

			let paired = true;
			let storedHost: string | null = null;

			const showPairingBanner = (hostValue: string | null) => {
				storedHost = hostValue;
				paired = false;
				pairBanner.style.display = "";
				pairHostLabel.style.display = hostValue ? "none" : "block";
				if (hostValue) pairHostInput.value = "";
				setStatus("Enter this tab's pairing code.");
			};

			const hidePairingBanner = () => {
				paired = true;
				pairBanner.style.display = "none";
				pairCodeInput.value = "";
			};

			const refreshPairingStatus = async () => {
				try {
					const response = (await chrome.runtime.sendMessage({ type: "ompx-annotate-status" })) as
						| StatusResponse
						| undefined;
					if (response?.ok) {
						storedHost = response.host ?? null;
						if (response.paired) {
							hidePairingBanner();
							return;
						}
						showPairingBanner(response.host ?? null);
						return;
					}
					toast(response?.error ?? "storage_unavailable", true);
					showPairingBanner(null);
				} catch (error) {
					toast(error instanceof Error ? error.message : String(error), true);
					showPairingBanner(null);
				}
			};

			const pairTab = async () => {
				const code = pairCodeInput.value.trim();
				const hostValue = storedHost ? undefined : pairHostInput.value.trim();
				if (!code || (!storedHost && !hostValue)) {
					toast("missing_pairing", true);
					return;
				}
				pairBtn.disabled = true;
				try {
					const message = hostValue
						? { type: "ompx-annotate-pair", code, host: hostValue }
						: { type: "ompx-annotate-pair", code };
					const response = (await chrome.runtime.sendMessage(message)) as PairResponse | undefined;
					if (response?.ok) {
						if (hostValue) storedHost = hostValue;
						hidePairingBanner();
						toast(`Paired with ${response.session ?? "session"}`);
						return;
					}
					toast(response?.error ?? "missing_pairing", true);
				} catch (error) {
					toast(error instanceof Error ? error.message : String(error), true);
				} finally {
					pairBtn.disabled = false;
				}
			};

			let drawActive = false;
			let pickActive = false;
			let drag: DragState | null = null;
			let noteOpen = false;
			let hoverTarget: Element | null = null;

			const positionPreview = (clientX: number, clientY: number) => {
				if (!drag) return;
				drag.preview.style.left = `${Math.min(drag.startX, clientX)}px`;
				drag.preview.style.top = `${Math.min(drag.startY, clientY)}px`;
				drag.preview.style.width = `${Math.abs(clientX - drag.startX)}px`;
				drag.preview.style.height = `${Math.abs(clientY - drag.startY)}px`;
			};

			const cancelDrag = () => {
				drag?.preview.remove();
				drag = null;
			};

			const syncCapture = () => {
				capture.style.display = drawActive || pickActive ? "block" : "none";
			};

			const hideHighlight = () => {
				hoverTarget = null;
				hl.style.display = "none";
				hlTip.style.display = "none";
			};

			const highlightLabel = (el: Element) => {
				let label = el.tagName.toLowerCase();
				if (el.id) label += `#${el.id}`;
				else if (el.classList.length > 0) label += `.${Array.from(el.classList).slice(0, 2).join(".")}`;
				const bounds = el.getBoundingClientRect();
				return `${label}  ${Math.round(bounds.width)} \u00D7 ${Math.round(bounds.height)}`;
			};

			const showHighlight = (el: Element) => {
				hoverTarget = el;
				const bounds = el.getBoundingClientRect();
				hl.style.left = `${bounds.left}px`;
				hl.style.top = `${bounds.top}px`;
				hl.style.width = `${bounds.width}px`;
				hl.style.height = `${bounds.height}px`;
				hl.style.display = "block";
				hlTip.textContent = highlightLabel(el);
				hlTip.style.display = "block";
				hlTip.style.left = `${Math.max(4, Math.min(bounds.left, window.innerWidth - 160))}px`;
				hlTip.style.top = `${bounds.top >= 26 ? bounds.top - 22 : Math.min(window.innerHeight - 22, bounds.bottom + 4)}px`;
			};

			const onPickScroll = () => {
				if (pickActive && hoverTarget) showHighlight(hoverTarget);
			};
			window.addEventListener("scroll", onPickScroll, { capture: true, passive: true });

			const setDraw = (on: boolean) => {
				if (on && pickActive) setPick(false);
				drawActive = on;
				drawBtn.classList.toggle("active", on);
				syncCapture();
				if (on) {
					setStatus("Drag to draw a box. Esc to exit.");
				} else {
					cancelDrag();
					if (!pickActive) setStatus("");
				}
			};

			const setPick = (on: boolean) => {
				if (on && drawActive) setDraw(false);
				pickActive = on;
				pickBtn.classList.toggle("active", on);
				syncCapture();
				if (on) {
					setStatus("Click an element to mark it. Esc to exit.");
				} else {
					hideHighlight();
					if (!drawActive) setStatus("");
				}
			};

			const promptNote = (entry: RectEntry, clientX: number, clientY: number) => {
				const input = doc.createElement("input");
				input.type = "text";
				input.className = "note-input";
				input.placeholder = "Optional note - Enter to save, Esc to skip";
				input.style.left = `${Math.max(4, Math.min(clientX, window.innerWidth - 230))}px`;
				input.style.top = `${Math.max(4, clientY - 30)}px`;
				chromeLayer.appendChild(input);
				noteOpen = true;
				let done = false;
				const finish = (commit: boolean) => {
					if (done) return;
					done = true;
					noteOpen = false;
					if (commit) entry.note = input.value.slice(0, NOTE_MAX);
					input.remove();
				};
				input.addEventListener("keydown", event => {
					if (event.key === "Enter") {
						event.preventDefault();
						event.stopPropagation();
						finish(true);
					} else if (event.key === "Escape") {
						event.preventDefault();
						event.stopPropagation();
						finish(false);
					}
				});
				input.addEventListener("blur", () => finish(true));
				input.focus();
			};

			const pickElement = (el: Element) => {
				const bounds = el.getBoundingClientRect();
				const x = Math.max(0, bounds.left);
				const y = Math.max(0, bounds.top);
				const width = Math.min(window.innerWidth, bounds.right) - x;
				const height = Math.min(window.innerHeight, bounds.bottom) - y;
				if (width < 1 || height < 1) {
					toast("Element is outside the viewport", true);
					return;
				}
				const entry = addRect(x, y, Math.max(width, MIN_RECT), Math.max(height, MIN_RECT), el);
				setPick(false);
				promptNote(entry, x, y);
			};

			capture.addEventListener("pointerdown", event => {
				if (event.button !== 0) return;
				if (pickActive) {
					event.preventDefault();
					return;
				}
				if (!drawActive) return;
				event.preventDefault();
				if (capture.setPointerCapture) capture.setPointerCapture(event.pointerId);
				const preview = doc.createElement("div");
				preview.className = "preview";
				chromeLayer.appendChild(preview);
				drag = { startX: event.clientX, startY: event.clientY, preview };
				positionPreview(event.clientX, event.clientY);
			});

			capture.addEventListener("pointermove", event => {
				if (pickActive) {
					const el = targetAt(event.clientX, event.clientY);
					if (el) {
						if (el !== hoverTarget) showHighlight(el);
					} else {
						hideHighlight();
					}
					return;
				}
				if (!drag) return;
				event.preventDefault();
				positionPreview(event.clientX, event.clientY);
			});

			capture.addEventListener("pointerup", event => {
				if (pickActive) {
					if (event.button !== 0) return;
					event.preventDefault();
					const el = hoverTarget || targetAt(event.clientX, event.clientY);
					if (el) pickElement(el);
					return;
				}
				if (!drag) return;
				event.preventDefault();
				const x = Math.min(drag.startX, event.clientX);
				const y = Math.min(drag.startY, event.clientY);
				const width = Math.abs(event.clientX - drag.startX);
				const height = Math.abs(event.clientY - drag.startY);
				const preview = drag.preview;
				drag = null;
				preview.remove();
				if (width >= MIN_RECT && height >= MIN_RECT) {
					const entry = addRect(x, y, width, height);
					promptNote(entry, x, y);
				}
			});

			const onKeyDown = (event: KeyboardEvent) => {
				if (event.key !== "Escape") return;
				if (noteOpen) return;
				event.preventDefault();
				if (drag) cancelDrag();
				else if (pickActive) setPick(false);
				else if (drawActive) setDraw(false);
				else teardown();
			};
			doc.addEventListener("keydown", onKeyDown, true);

			const buildPayload = (): AnnotationPayload => {
				const sx = scrollX();
				const sy = scrollY();
				const out: AnnotationRect[] = [];
				for (const rectEntry of rects) {
					const rect: AnnotationRect = {
						x: rectEntry.pageX - sx,
						y: rectEntry.pageY - sy,
						width: rectEntry.width,
						height: rectEntry.height,
					};
					if (rectEntry.note) rect.note = rectEntry.note;
					if (rectEntry.element) rect.element = rectEntry.element;
					out.push(rect);
				}
				return { comment: comment.value, rects: out, url: location.href, title: doc.title };
			};

			const setChromeVisible = (visible: boolean) => {
				chromeLayer.style.display = visible ? "" : "none";
			};

			const waitForChromeRepaint = async () => {
				const { promise, resolve } = Promise.withResolvers<void>();
				requestAnimationFrame(() => {
					requestAnimationFrame(() => resolve());
				});
				await promise;
			};

			const teardown = () => {
				extWindow.__ompxExtAnnotateActive = false;
				if (extWindow.__ompxExtAnnotateSetChromeVisible === setChromeVisible) {
					extWindow.__ompxExtAnnotateSetChromeVisible = undefined;
				}
				if (extWindow.__ompxExtAnnotateTeardown === teardown) {
					extWindow.__ompxExtAnnotateTeardown = undefined;
				}
				window.removeEventListener("scroll", syncScroll, true);
				window.removeEventListener("resize", syncScroll);
				window.removeEventListener("scroll", onPickScroll, true);
				window.removeEventListener("resize", onResize);
				doc.removeEventListener("keydown", onKeyDown, true);
				for (const eventName of focusEvents) window.removeEventListener(eventName, focusGuard, true);
				for (const eventName of ["keydown", "keypress", "keyup"])
					shadow.removeEventListener(eventName, stopOverlayKeys);
				window.clearTimeout(toastTimer);
				host.remove();
			};

			let sending = false;
			const send = async () => {
				if (sending) return;
				if (!paired || pairBanner.style.display !== "none") {
					toast("not_paired \u2014 enter the pairing code first", true);
					return;
				}
				if (comment.value.trim().length === 0 && rects.length === 0) {
					setStatus("Add a comment or draw a box first.");
					return;
				}
				sending = true;
				sendBtn.disabled = true;
				setStatus("Sending...");
				const payload = buildPayload();
				setChromeVisible(false);
				await waitForChromeRepaint();
				try {
					const res = (await chrome.runtime.sendMessage({ type: "ompx-annotate-submit", payload })) as
						| SubmitResponse
						| undefined;
					setChromeVisible(true);
					if (res?.ok) {
						clearRects();
						comment.value = "";
						setStatus("Sent.");
						toast("Sent to agent");
						return;
					}
					const error = res?.error ?? "unknown_error";
					toast(error, true);
					if (error.includes("invalid_code")) showPairingBanner(storedHost);
					setStatus("Send failed. Check pairing and try again.");
				} catch (error) {
					setChromeVisible(true);
					const errMessage = error instanceof Error ? error.message : String(error);
					toast(`Send failed: ${errMessage}`, true);
					setStatus("Send failed. Check pairing and try again.");
				} finally {
					sending = false;
					sendBtn.disabled = false;
				}
			};

			drawBtn.addEventListener("click", () => setDraw(!drawActive));
			pickBtn.addEventListener("click", () => setPick(!pickActive));
			clearBtn.addEventListener("click", () => {
				clearRects();
				setStatus("Cleared.");
			});
			closeBtn.addEventListener("pointerdown", event => event.stopPropagation());
			closeBtn.addEventListener("click", teardown);
			pairBtn.addEventListener("click", pairTab);
			sendBtn.addEventListener("click", send);

			let boxPos: { x: number; y: number } | null = null;
			const applyBoxPos = (el: HTMLElement) => {
				if (!boxPos) return;
				const width = el.offsetWidth || 260;
				const height = el.offsetHeight || 40;
				el.style.left = `${Math.max(4, Math.min(boxPos.x, window.innerWidth - width - 4))}px`;
				el.style.top = `${Math.max(4, Math.min(boxPos.y, window.innerHeight - height - 4))}px`;
				el.style.right = "auto";
			};

			const makeDraggable = (
				handle: HTMLElement,
				box: HTMLElement,
				ignoreEl: HTMLElement | null,
				onTap: ((event: PointerEvent) => void) | null,
			) => {
				handle.addEventListener("pointerdown", event => {
					if (event.button !== 0) return;
					if (ignoreEl && event.target === ignoreEl) return;
					event.preventDefault();
					const startX = event.clientX;
					const startY = event.clientY;
					const bounds = box.getBoundingClientRect();
					const offX = event.clientX - bounds.left;
					const offY = event.clientY - bounds.top;
					let moved = false;
					const onMove = (moveEvent: PointerEvent) => {
						if (!moved && Math.abs(moveEvent.clientX - startX) < 4 && Math.abs(moveEvent.clientY - startY) < 4)
							return;
						moved = true;
						boxPos = { x: moveEvent.clientX - offX, y: moveEvent.clientY - offY };
						applyBoxPos(box);
					};
					const onUp = (upEvent: PointerEvent) => {
						handle.removeEventListener("pointermove", onMove);
						handle.removeEventListener("pointerup", onUp);
						handle.removeEventListener("pointercancel", onUp);
						if (!moved && onTap) onTap(upEvent);
					};
					if (handle.setPointerCapture) {
						try {
							handle.setPointerCapture(event.pointerId);
						} catch {}
					}
					handle.addEventListener("pointermove", onMove);
					handle.addEventListener("pointerup", onUp);
					handle.addEventListener("pointercancel", onUp);
				});
			};

			const setMinimized = (on: boolean) => {
				minimized = on;
				toolbar.style.display = on ? "none" : "";
				pill.style.display = on ? "" : "none";
				if (on) {
					pill.textContent = rects.length ? `\u270E ${rects.length}` : "\u270E";
					applyBoxPos(pill);
				} else {
					applyBoxPos(toolbar);
				}
			};

			const onResize = () => applyBoxPos(minimized ? pill : toolbar);

			minBtn.addEventListener("click", () => setMinimized(true));
			makeDraggable(head, toolbar, minBtn, null);
			makeDraggable(pill, pill, null, () => setMinimized(false));
			window.addEventListener("resize", onResize, { passive: true });

			void refreshPairingStatus();
			extWindow.__ompxExtAnnotateSetChromeVisible = setChromeVisible;
			extWindow.__ompxExtAnnotateTeardown = teardown;
		};

		if (document.documentElement) install();
		else document.addEventListener("DOMContentLoaded", install, { once: true });
	};

	if (!extWindow.__ompxExtAnnotateListenerInstalled) {
		extWindow.__ompxExtAnnotateListenerInstalled = true;
		chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
			if (!isRecord(message) || message.type !== "ompx-annotate-toggle") return;
			if (extWindow.__ompxExtAnnotateActive) extWindow.__ompxExtAnnotateTeardown?.();
			else openOverlay();
			sendResponse({ ok: true });
		});
	}

	openOverlay();
})();
