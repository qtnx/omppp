import { LitElement, PropertyValues } from 'lit';
export interface DialogInfo {
    header: string;
    message: string;
    yesButtonText: string;
    errorMessage?: string;
}
/**
 * Confirm dialog element.
 *
 */
export declare class NightjarInputDialog extends LitElement {
    dialogElement: HTMLDialogElement | undefined;
    header: string;
    message: string;
    yesButtonText: string;
    errorMessage: string;
    isError: boolean;
    isLoading: boolean;
    inputStorageKey: string;
    confirmAction: (input: string) => void;
    cancelAction: () => void;
    inputValidate: (input: string) => Promise<boolean> | boolean;
    constructor();
    firstUpdated(): void;
    /**
     * This method is called before new DOM is updated and rendered
     * @param changedProperties Property that has been changed
     */
    willUpdate(changedProperties: PropertyValues<this>): void;
    initData: () => Promise<void>;
    show(dialogInfo: DialogInfo, confirmAction: (input: string) => void, cancelAction?: () => void, inputValidate?: (input: string) => Promise<boolean> | boolean): void;
    dialogClicked(e: MouseEvent): void;
    cancelClicked(e: MouseEvent): void;
    confirmClicked(e: MouseEvent): Promise<void>;
    render(): import('lit-html').TemplateResult<1>;
    static styles: import('lit').CSSResult[];
}
declare global {
    interface HTMLElementTagNameMap {
        'nightjar-input-dialog': NightjarInputDialog;
    }
}
