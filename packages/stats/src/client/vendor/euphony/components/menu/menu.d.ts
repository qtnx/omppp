import { LitElement, PropertyValues } from 'lit';
interface MenuItem {
    name: string;
    icon?: string;
}
/**
 * Menu element.
 *
 */
export declare class NightjarMenu extends LitElement {
    menuItems: MenuItem[];
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
    menuItemClicked(e: MouseEvent, menuItemName: string): void;
    render(): import('lit-html').TemplateResult<1>;
    static styles: import('lit').CSSResult[];
}
declare global {
    interface HTMLElementTagNameMap {
        'nightjar-menu': NightjarMenu;
    }
}
export {};
