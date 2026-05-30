import { LitElement, PropertyValues, TemplateResult } from 'lit';
import { BlockContent } from '../../types/common-types';
import { Message } from '../../types/harmony-types';
interface EditMetadata {
    location: 'model_identity' | 'conversation_start_date' | 'knowledge_cutoff' | 'valid_channels' | 'channel_required';
    index: number | string;
}
export interface SystemContentEditPayload extends EditMetadata {
    newContent: string;
}
/**
 * Message system content element.
 */
export declare class EuphonyMessageSystemContent extends LitElement {
    message: Message | null;
    shouldRenderMarkdown: boolean;
    markdownAllowedTags: string[] | null;
    markdownAllowedAttributes: string[] | null;
    isTranslation: boolean;
    isEditable: boolean;
    /**
     * Optional URL to the current json/jsonl file (if any). This is used to
     * resolve some relative paths in the asset pointers in the conversation. For
     * example, `aquifer://foo` will be resolved to `dataFileURL/../assets/foo`.
     * We won't resolve relative paths if `dataFileURL` is not provided.
     */
    dataFileURL: string | null;
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
    render(): TemplateResult<1>;
    static styles: import('lit').CSSResult[];
}
declare global {
    interface HTMLElementTagNameMap {
        'euphony-message-system-content': EuphonyMessageSystemContent;
    }
}
export {};
