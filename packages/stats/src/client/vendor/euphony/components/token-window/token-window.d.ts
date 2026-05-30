import { LitElement, PropertyValues } from 'lit';
import { HarmonyRenderResponse } from '../../types/common-types';
/**
 * Confirm window element.
 *
 */
export declare class EuphonyTokenWindow extends LitElement {
    conversationString: string | null;
    selectedRenderer: string;
    availableRenderers: string[];
    windowElement: HTMLElement | undefined;
    tabButtons: NodeListOf<HTMLButtonElement>;
    showMessage: boolean;
    message: string | null;
    messageType: 'error' | 'success';
    isOpen: boolean;
    isTokenizing: boolean;
    selectedTab: 'conversation' | 'token' | 'token_id' | 'display_string';
    tokens: number[];
    decodedTokens: string[];
    displayString: string;
    private tabSliderLeft;
    private tabSliderWidth;
    tabOptions: {
        key: EuphonyTokenWindow['selectedTab'];
        label: string;
    }[];
    popperTooltip: HTMLElement | undefined;
    rendererTooltipDebouncer: number | null;
    constructor();
    firstUpdated(): void;
    /**
     * This method is called before new DOM is updated and rendered
     * @param changedProperties Property that has been changed
     */
    willUpdate(changedProperties: PropertyValues<this>): void;
    initData: () => Promise<void>;
    show(conversationString: string): void;
    close(): void;
    tokenizationSucceeded(value: HarmonyRenderResponse): void;
    tokenizationFailed(errorMessage: string): void;
    performHarmonyRender(): void;
    refreshRendererList(): void;
    /**
     * Updates the currently selected tab and drives the slider animation.
     * Using a dedicated handler keeps template bindings lean and readable.
     * @param tabKey - The tab identifier that should be selected.
     */
    tabSelected(tabKey: EuphonyTokenWindow['selectedTab']): void;
    /**
     * Returns the index of the selected tab for positional math.
     * Defaulting to zero keeps the slider predictable even if the array changes.
     */
    getSelectedTabIndex(): number;
    /**
     * Measures the currently selected tab and updates CSS variables that control
     * the sliding highlight width/offset. Runs in rAF to ensure layout has settled.
     */
    updateTabSliderPosition(): void;
    /**
     * Ensure the slider is re-measured whenever relevant state flips (e.g., opening the modal
     * after it was hidden will otherwise report zero widths).
     */
    updated(changedProperties: PropertyValues<this>): void;
    /**
     * Handles clicks on the translucent backdrop to mirror typical modal behavior.
     * Prevents closing while tokenization is in-flight to avoid interrupting active work.
     * @param event - Mouse event emitted when the backdrop is clicked.
     */
    backdropClicked: (event: MouseEvent) => void;
    cancelClicked(e: MouseEvent): void;
    renderButtonClicked(e: MouseEvent): void;
    /**
     * This method is called when the user starts dragging the window
     * @param event The mouse event
     */
    private onDragStart;
    render(): import('lit-html').TemplateResult<1>;
    /**
     * Handles mouse entering the renderer info icon by showing a delayed tooltip.
     * The delay prevents flickering when users quickly pass over the icon while moving the cursor.
     * @param event - The mouse event fired from the info icon.
     */
    rendererInfoMouseEnter(event: MouseEvent): void;
    /**
     * Hides the renderer tooltip and clears any pending display timers.
     * @param useTransition - Whether the hide action should respect CSS transitions.
     */
    rendererInfoMouseLeave(useTransition?: boolean): void;
    static styles: import('lit').CSSResult[];
}
declare global {
    interface HTMLElementTagNameMap {
        'euphony-token-window': EuphonyTokenWindow;
    }
}
