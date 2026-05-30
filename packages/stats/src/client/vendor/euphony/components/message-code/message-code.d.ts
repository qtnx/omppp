import { LitElement, PropertyValues } from 'lit';
import { Message } from '../../types/harmony-types';
/**
 * Message code element.
 */
export declare class EuphonyMessageCode extends LitElement {
    message: Message | null;
    constructor();
    firstUpdated(): void;
    willUpdate(changedProperties: PropertyValues<this>): void;
    initData(): Promise<void>;
    getHighlightedCode(code: string, language?: string | null): import('lit-html').TemplateResult<1>;
    render(): import('lit-html').TemplateResult<1>;
    static styles: import('lit').CSSResult[];
}
declare global {
    interface HTMLElementTagNameMap {
        'euphony-message-code': EuphonyMessageCode;
    }
}
