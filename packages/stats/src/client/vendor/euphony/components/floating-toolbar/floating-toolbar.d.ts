import { LitElement, PropertyValues } from 'lit';
export interface FloatingToolbarButton {
    name: string;
    tooltip: string;
    svgIcon: string;
}
/**
 * Floating toolbar element.
 */
export declare class EuphonyFloatingToolbar extends LitElement {
    buttons: FloatingToolbarButton[];
    disappearTimeout: number | null;
    popperTooltip: HTMLElement | undefined;
    lastAnchor: HTMLElement | null;
    toolbarTooltipDebouncer: number | null;
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
    updateCurrentTooltip(tooltip: string): void;
    /**
     * MouseEnter Event handler for all the buttons in the toolbar
     * @param e Mouse event
     */
    toolButtonMouseEnter(e: MouseEvent, name: string): void;
    /**
     * MouseLeave Event handler for all the buttons in the toolbar
     * @param e Mouse event
     */
    toolButtonMouseLeave(useTransition?: boolean): void;
    toolbarMouseEnter(): void;
    toolbarMouseLeave(): void;
    render(): import('lit-html').TemplateResult<1>;
    static styles: import('lit').CSSResult[];
}
declare global {
    interface HTMLElementTagNameMap {
        'euphony-floating-toolbar': EuphonyFloatingToolbar;
    }
}
