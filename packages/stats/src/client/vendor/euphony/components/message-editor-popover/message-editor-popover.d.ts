import { LitElement, PropertyValues } from 'lit';
import { Role, Message } from '../../types/harmony-types';
export interface MessageEditorUserSetData {
    role: Role;
    name: string | null;
    recipient: string | null;
    channel: string | null;
}
/**
 * Floating editor used in conversation editing mode for quick message metadata
 * edits (author role/name, recipient, and channel).
 */
export declare class EuphonyMessageEditorPopover extends LitElement {
    /**
     * Message being edited. The component copies its current values into local
     * editable state when this property changes so users can cancel safely.
     */
    message: Message | null;
    selectedRole: Role;
    authorName: string;
    recipient: string;
    channel: string;
    constructor();
    firstUpdated(): void;
    willUpdate(changedProperties: PropertyValues<this>): void;
    initData(): Promise<void>;
    private saveButtonClick;
    private cancelButtonClick;
    render(): import('lit-html').TemplateResult<1>;
    static styles: import('lit').CSSResult[];
}
declare global {
    interface HTMLElementTagNameMap {
        'euphony-message-editor-popover': EuphonyMessageEditorPopover;
    }
}
