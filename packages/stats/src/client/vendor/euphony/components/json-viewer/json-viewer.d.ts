import { LitElement, PropertyValues } from 'lit';
type JSONValue = string | number | boolean | null | JSONObject | JSONArray;
interface JSONObject {
    [key: string]: JSONValue;
}
type JSONArray = JSONValue[];
/**
 * Json viewer element.
 */
export declare class EuphonyJsonViewer extends LitElement {
    data: JSONValue;
    isDarkTheme: boolean;
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
    getHighlightedCode(code: string, language: string): import('lit-html').TemplateResult<1>;
    render(): import('lit-html').TemplateResult<1>;
    static styles: import('lit').CSSResult[];
}
declare global {
    interface HTMLElementTagNameMap {
        'euphony-json-viewer': EuphonyJsonViewer;
    }
}
export {};
