import { LitElement, PropertyValues } from 'lit';
/**
 * Pagination element.
 *
 */
export declare class NightjarPagination extends LitElement {
    curPage: number;
    totalPageNum: number;
    pageWindowSize: number;
    itemsPerPage: number;
    itemsPerPageOptions: number[];
    constructor();
    /**
     * This method is called before new DOM is updated and rendered
     * @param changedProperties Property that has been changed
     */
    willUpdate(changedProperties: PropertyValues<this>): void;
    initData(): Promise<void>;
    pageButtonClicked(name: string): void;
    itemsPerPageChanged(e: InputEvent): void;
    getPageButtonTemplate: (name: string) => import('lit-html').TemplateResult<1>;
    render(): import('lit-html').TemplateResult<1>;
    static styles: import('lit').CSSResult[];
}
declare global {
    interface HTMLElementTagNameMap {
        'nightjar-pagination': NightjarPagination;
    }
}
