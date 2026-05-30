import { LitElement, PropertyValues } from 'lit';
import { Message } from '../../types/harmony-types';
/**
 * Message text element.
 */
export declare class EuphonyMessageText extends LitElement {
    message: Message | null;
    shouldRenderMarkdown: boolean;
    markdownAllowedTags: string[] | null;
    markdownAllowedAttributes: string[] | null;
    isTranslation: boolean;
    isEditable: boolean;
    constructor();
    /**
     * This method is called when the DOM is added for the first time
     */
    firstUpdated(): void;
    /**
     * This method is called before new DOM is updated and rendered
     * @param changedProperties Property that has been changed
     */
    willUpdate(changedProperties: PropertyValues<this>): void;
    initData(): Promise<void>;
    messageTextChanged(e: InputEvent): void;
    /**
     * Generates an HTML template for an editable content.
     */
    getEditableTemplate: (content: string) => import('lit-html').TemplateResult<1>;
    render(): import('lit-html').TemplateResult<1>;
    static styles: import('lit').CSSResult[];
}
declare global {
    interface HTMLElementTagNameMap {
        'euphony-message-text': EuphonyMessageText;
    }
}
