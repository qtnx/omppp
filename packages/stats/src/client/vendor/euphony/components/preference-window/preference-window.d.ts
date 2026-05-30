import { LitElement, PropertyValues } from 'lit';
import { default as RadioGroupElement } from '@shoelace-style/shoelace/dist/components/radio-group/radio-group.js';
interface PreferenceOptions {
    maxMessageHeight: boolean;
    gridView: boolean;
    expandAndCollapseAll: boolean;
    advanced: boolean;
    messageLabel: boolean;
    focusMode: boolean;
    comparisonWidth: boolean;
}
interface DefaultPreferenceOptions {
    gridView: boolean;
    gridViewColumnWidth: number;
    comparisonWidth: number;
}
export interface MessageLabelSettings {
    absoluteTimestamp: boolean;
}
export interface AdvancedSettings {
    renderHTMLBlock: boolean;
}
export interface FocusModeSettings {
    author: string[];
    recipient: string[];
    contentType: string[];
}
/**
 * Preference window element.
 */
export declare class EuphonyPreferenceWindow extends LitElement {
    enabledOptions: PreferenceOptions;
    defaultOptions: DefaultPreferenceOptions;
    isDarkTheme: boolean;
    useCustomMessageHeight: boolean;
    preferenceMaxMessageHeightMode: 'automatic' | 'no-limit' | 'custom';
    preferenceCustomMaxMessageHeight: number;
    preferenceCustomGridViewColumnWidth: number;
    preferenceCustomComparisonWidth: number;
    isAdvancedSectionCollapsed: boolean;
    isFocusModeSectionCollapsed: boolean;
    messageLabelSettings: MessageLabelSettings;
    advancedSettings: AdvancedSettings;
    focusModeSettings: FocusModeSettings;
    isGridView: boolean;
    radioGroupMaxMessageHeight: null | undefined | RadioGroupElement;
    radioGroupLayout: null | undefined | RadioGroupElement;
    popperTooltip: HTMLElement | undefined;
    tooltipDebouncer: number | null;
    constructor();
    loadPreferencesFromStorage(): void;
    writePreferencesToStorage(): void;
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
    /**
     * This method is called when the user starts dragging the window
     * @param event The mouse event
     */
    private onDragStart;
    maxMessageHeightRadioChanged(): void;
    maxMessageHeightRangeInput(event: Event): void;
    maxMessageHeightRangeChanged(event: Event): void;
    layoutRadioChanged(): void;
    gridViewColumnWidthRangeInput(event: Event): void;
    gridViewColumnWidthRangeChanged(event: Event): void;
    comparisonWidthRangeInput(event: Event): void;
    comparisonWidthRangeChanged(event: Event): void;
    expandAllButtonClicked(): void;
    collapseAllButtonClicked(): void;
    translateAllButtonClicked(): void;
    messageLabelCheckBoxChanged(e: InputEvent, name: 'absoluteTimestamp'): void;
    advancedCheckboxChanged(e: InputEvent, name: 'renderHTMLBlock'): void;
    focusModeCheckBoxChanged(e: InputEvent, name: 'author' | 'recipient' | 'contentType', value: string): void;
    /**
     * MouseEnter Event handler for all the buttons in the toolbar
     * @param e Mouse event
     */
    tooltipTargetMouseEnter(e: MouseEvent, type: 'absoluteTimestamp' | 'renderHTMLBlock' | 'focusModeAuthor' | 'focusModeRecipient' | 'focusModeMessageContentType', suffix?: string): void;
    /**
     * MouseLeave Event handler for all the buttons in the toolbar
     * @param e Mouse event
     */
    tooltipTargetMouseLeave(useTransition?: boolean): void;
    notifyParentMaxMessageHeight(): void;
    notifyParentGridViewColumnWidth(): void;
    notifyParentComparisonWidth(): void;
    notifyParentLayoutChange(layout: 'list' | 'grid'): void;
    notifyParentMessageLabelSettings(): void;
    notifyParentAdvancedSettings(): void;
    notifyParentFocusModeSettings(): void;
    render(): import('lit-html').TemplateResult<1>;
    static styles: import('lit').CSSResult[];
}
declare global {
    interface HTMLElementTagNameMap {
        'euphony-preference-window': EuphonyPreferenceWindow;
    }
}
export {};
