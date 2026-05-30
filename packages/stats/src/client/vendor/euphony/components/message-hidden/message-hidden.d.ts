import { LitElement, PropertyValues } from 'lit';
import { Message } from '../../types/harmony-types';
/**
 * Compact placeholder shown when a message is hidden by focus mode filters.
 * Clicking it emits an event that the parent conversation uses to unhide the
 * specific message instance.
 */
export declare class EuphonyMessageHidden extends LitElement {
    /**
     * The original message object. We only use it to derive a human-readable
     * content type label (e.g. "text", "developer") for the placeholder text.
     */
    message: Message | null;
    constructor();
    /**
     * This method is called when the DOM is added for the first time.
     * Present for consistency with other message components.
     */
    firstUpdated(): void;
    /**
     * This method is called before new DOM is updated and rendered.
     * Present for consistency with other message components.
     * @param changedProperties Property that has been changed
     */
    willUpdate(changedProperties: PropertyValues<this>): void;
    /**
     * Placeholder to match the common component interface used across message
     * components in this codebase.
     */
    initData(): Promise<void>;
    render(): import('lit-html').TemplateResult<1>;
    static styles: import('lit').CSSResult[];
}
declare global {
    interface HTMLElementTagNameMap {
        'euphony-message-hidden': EuphonyMessageHidden;
    }
}
