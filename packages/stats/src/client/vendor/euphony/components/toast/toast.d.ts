import { LitElement, PropertyValues } from 'lit';
/**
 * Toast element.
 *
 */
export declare class NightjarToast extends LitElement {
    type: 'success' | 'warning' | 'error';
    message: string;
    duration: number;
    isHidden: boolean;
    timer: null | number;
    constructor();
    /**
     * This method is called before new DOM is updated and rendered
     * @param changedProperties Property that has been changed
     */
    willUpdate(changedProperties: PropertyValues<this>): void;
    initData(): Promise<void>;
    /**
     * Show the toast message
     */
    show(): void;
    /**
     * Hide the toast message
     */
    hide(): void;
    render(): import('lit-html').TemplateResult<1>;
    static styles: import('lit').CSSResult[];
}
declare global {
    interface HTMLElementTagNameMap {
        'nightjar-toast': NightjarToast;
    }
}
