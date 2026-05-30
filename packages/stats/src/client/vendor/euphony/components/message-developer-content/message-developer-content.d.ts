import { LitElement, PropertyValues, TemplateResult } from 'lit';
import { BlockContent } from '../../types/common-types';
import { Message } from '../../types/harmony-types';
interface EditMetadata {
    location: 'instruction' | 'tool_namespace_name' | 'tool_namespace_description';
    index: number | string;
}
export interface DeveloperContentEditPayload extends EditMetadata {
    newContent: string;
}
/**
 * Message developer content element.
 */
export declare class EuphonyMessageDeveloperContent extends LitElement {
    message: Message | null;
    shouldRenderMarkdown: boolean;
    markdownAllowedTags: string[] | null;
    markdownAllowedAttributes: string[] | null;
    isEditable: boolean;
    blockContents: BlockContent[];
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
    messageTextChanged(e: InputEvent, editMetadata: EditMetadata): void;
    resetBlockContents(): void;
    getHighlightedCode(code: string, language: string): TemplateResult<1>;
    getEditableTemplate: (content: string, editMetadata: EditMetadata) => TemplateResult<1>;
    renderNamespaceTable(namespaceKey: string, name: string, description: string, isEditable: boolean): TemplateResult<1>;
    render(): TemplateResult<1>;
    static styles: import('lit').CSSResult[];
}
declare global {
    interface HTMLElementTagNameMap {
        'euphony-message-developer-content': EuphonyMessageDeveloperContent;
    }
}
export {};
