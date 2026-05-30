import { LitElement, TemplateResult } from 'lit';
import { BlockContent } from '../types/common-types';
import { Conversation } from '../types/harmony-types';
/**
 * Updates the position and appearance of a popper overlay tooltip.
 * @param tooltip - The tooltip element.
 * @param anchor - The anchor element to which the tooltip is attached.
 * @param placement - The placement of the tooltip relative to the anchor
 *  ('bottom', 'left', 'top', 'right').
 * @param withArrow - Indicates whether the tooltip should have an arrow.
 * @param offsetAmount - The offset amount in pixels.
 * @param maxWidth - The maximum width of the tooltip in pixels (optional).
 */
export declare const updatePopperOverlay: (tooltip: HTMLElement, anchor: HTMLElement, placement: "bottom" | "left" | "top" | "right", withArrow: boolean, offsetAmount?: number, maxWidth?: number) => void;
/**
 * Updates the position of a floating element relative to an anchor element.
 * @param floatingElement - The floating element to be positioned.
 * @param anchor - The anchor element to which the floating element is attached.
 * @param placement - The placement of the floating element relative to the
 *  anchor ('bottom', 'left', 'top', 'right').
 * @param offsetAmount - The y offset amount in pixels.
 */
export declare const updateFloatPosition: (anchor: HTMLElement, floatingElement: HTMLElement, placement: "bottom" | "left" | "top" | "right", offsetAmount?: number) => void;
/**
 * Generates an HTML template from a markdown string.
 *
 * @param content - The markdown content to be rendered.
 * @param shouldRenderMarkdown - Whether to render the content as markdown.
 * @returns The HTML template generated from the markdown content.
 */
export declare const getMarkdownTemplate: (content: string, shouldRenderMarkdown: boolean, markdownAllowedTags: string[] | null, markdownAllowedAttributes: string[] | null) => TemplateResult<1>;
/**
 * Creates a deferred promise that will be automatically rejected if not
 * resolved within the specified wait time.
 *
 * @template T - The type of the value that the promise resolves with.
 * @param waitTime - The time in milliseconds to wait before automatically
 * rejecting the promise.
 * @returns An object containing the promise, and wrapped resolve and reject
 * functions.
 */
export declare const getDeferredPromise: <T>(waitTime: number) => {
    promise: Promise<T>;
    resolve: (value: T) => void;
    reject: (reason?: unknown) => void;
};
/**
 * Converts a Blob to a base64 string.
 * @param blob - The Blob to convert.
 * @returns A promise that resolves to the base64 string.
 */
export declare const blobToBase64: (blob: Blob) => Promise<string>;
/**
 * Digests a message using SHA-256.
 * @param message - The message to digest.
 * @returns A promise that resolves to the digest of the message.
 */
export declare const digestMessage: (message: string) => Promise<string>;
/**
 * Converts a style object to a string.
 * @param styles - The style object to convert.
 * @returns The style string.
 */
export declare const styleToString: (styles: Record<string, string>) => string;
export declare const arrayToTable: (data: unknown[][]) => TemplateResult;
/**
 * Get custom convo labels and message labels from magic metadata field
 * @param conversation - The conversation to get custom labels from
 * @returns The custom labels
 */
export declare const getCustomLabelsFromMagicMetadata: (conversation: Conversation) => {
    customLabels: string[][];
    customMessageLabels: ([string | number, string] | [string | number, string, string] | [string | number, string, string, string])[];
};
export declare class EuphonyLitElementWithBlockContents extends LitElement {
    blockContents: BlockContent[];
}
export declare const sharedExpandBlockContents: (element: LitElement | EuphonyLitElementWithBlockContents) => void;
export declare const sharedCollapseBlockContents: (element: LitElement | EuphonyLitElementWithBlockContents) => void;
export declare const createBase64DataURL: (mimeType: string, dataBase64: string) => string;
