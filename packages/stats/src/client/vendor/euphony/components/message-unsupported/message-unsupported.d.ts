import { LitElement, PropertyValues } from 'lit';
import { Message } from '../../types/harmony-types';
export declare class EuphonyMessageUnsupported extends LitElement {
    message: Message | null;
    isCollapsed: boolean;
    firstUpdated(): void;
    willUpdate(changedProperties: PropertyValues<this>): void;
    initData(): Promise<void>;
    private getHighlightedCode;
    private getRawContentJSON;
    private getContentTypeLabel;
    render(): import('lit-html').TemplateResult<1>;
    static styles: import('lit').CSSResult[];
}
declare global {
    interface HTMLElementTagNameMap {
        'euphony-message-unsupported': EuphonyMessageUnsupported;
    }
}
