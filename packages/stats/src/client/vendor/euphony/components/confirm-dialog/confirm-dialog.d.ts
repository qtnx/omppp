import { LitElement, PropertyValues } from 'lit';
export interface DialogInfo {
    header: string;
    message: string;
    yesButtonText: string;
    /**
     * Used to identify actions to skip
     */
    actionKey: string;
}
/**
 * Confirm dialog element.
 *
 */
export declare class NightjarConfirmDialog extends LitElement {
    dialogElement: HTMLDialogElement | undefined;
    header: string;
    message: string;
    yesButtonText: string;
    actionKey: string;
    confirmAction: () => void;
    cancelAction: () => void;
    constructor();
    firstUpdated(): void;
    /**
     * This method is called before new DOM is updated and rendered
     * @param changedProperties Property that has been changed
     */
    willUpdate(changedProperties: PropertyValues<this>): void;
    initData: () => Promise<void>;
    show(dialogInfo: DialogInfo, confirmAction: () => void, cancelAction?: () => void): void;
    dialogClicked(e: MouseEvent): void;
    cancelClicked(e: MouseEvent): void;
    confirmClicked(e: MouseEvent): void;
    render(): import('lit-html').TemplateResult<1>;
    static styles: import('lit').CSSResult[];
}
declare global {
    interface HTMLElementTagNameMap {
        'nightjar-confirm-dialog': NightjarConfirmDialog;
    }
}
