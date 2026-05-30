import { LitElement, PropertyValues } from 'lit';
/**
 * Confirm window element.
 *
 */
export declare class EuphonySearchWindow extends LitElement {
    windowElement: HTMLElement | undefined;
    showErrorMessage: boolean;
    errorMessage: string | null;
    isOpen: boolean;
    isSearching: boolean;
    constructor();
    firstUpdated(): void;
    /**
     * This method is called before new DOM is updated and rendered
     * @param changedProperties Property that has been changed
     */
    willUpdate(changedProperties: PropertyValues<this>): void;
    initData: () => Promise<void>;
    show(): void;
    close(): void;
    searchSucceeded(): void;
    searchFailed(errorMessage: string): void;
    /**
     * Simple query validation
     * @param query - The query to validate
     * @returns True if the query is valid, false otherwise
     */
    isQueryValid(query: string): boolean;
    cancelClicked(e: MouseEvent): void;
    confirmClicked(e: MouseEvent): void;
    /**
     * This method is called when the user starts dragging the window
     * @param event The mouse event
     */
    private onDragStart;
    render(): import('lit-html').TemplateResult<1>;
    static styles: import('lit').CSSResult[];
}
declare global {
    interface HTMLElementTagNameMap {
        'euphony-search-window': EuphonySearchWindow;
    }
}
