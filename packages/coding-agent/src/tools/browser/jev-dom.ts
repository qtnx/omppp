/**
 * DOM-side helpers shared by both tab backends' Jev drivers, so SELECT and DRAG
 * behave identically on the worker (puppeteer) and cmux paths.
 */

import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";

interface OptionNode {
	tagName?: string;
	value?: string;
	selected?: boolean;
	closest?: (selector: string) => unknown;
	dispatchEvent?: (event: unknown) => void;
}

/**
 * Commit an observed option element through its owning control, in the page.
 * A native `<option>` cannot be clicked — the value must be set on the parent
 * `<select>` and the change announced. Returns `false` when the element is not
 * a native option, which tells the caller to fall back to an ordinary click
 * (ARIA listbox/menu/tree options are click-driven).
 */
export function selectObservedOptionInPage(element: unknown): boolean {
	const node = element as OptionNode;
	if (node.tagName !== "OPTION") return false;
	const select = node.closest?.("select") as { value?: string; dispatchEvent?: (event: unknown) => void } | null;
	if (!select) return false;
	node.selected = true;
	select.value = node.value ?? "";
	const EventCtor = (globalThis as unknown as { Event: new (type: string, init?: { bubbles: boolean }) => unknown })
		.Event;
	select.dispatchEvent?.(new EventCtor("input", { bubbles: true }));
	select.dispatchEvent?.(new EventCtor("change", { bubbles: true }));
	return true;
}

interface BoxedHandle {
	boundingBox(): Promise<{ x: number; y: number; width: number; height: number } | null>;
}

/** Center point of an observed element, for pointer-level operations like drag. */
export async function elementCenter(handle: BoxedHandle, label: string): Promise<{ x: number; y: number }> {
	const box = await handle.boundingBox();
	if (!box) throw new ToolError(`${label} element has no layout box (hidden or zero-sized); nothing dragged.`);
	return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}
