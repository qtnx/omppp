import { LitElement, PropertyValues, TemplateResult } from 'lit';
import { TranslatableConversation } from '../../types/common-types';
import { Conversation, Message, Role } from '../../types/harmony-types';
import { EuphonyFloatingToolbar, FloatingToolbarButton } from '../floating-toolbar/floating-toolbar';
import { EuphonyTokenWindow } from '../token-window/token-window';
import { MessageEditorUserSetData } from '../message-editor-popover/message-editor-popover';
import { FocusModeSettings, MessageLabelSettings } from '../preference-window/preference-window';
type CustomMessageLabel = [number | string, string] | [number | string, string, string] | [number | string, string, string, string];
/**
 * Conversation element.
 */
export declare class EuphonyConversation extends LitElement {
    conversationString: string;
    conversationData: TranslatableConversation | null;
    /**
     * The URL for the sharing button. If it's null, the copy URL button will be
     * hidden.
     */
    sharingURL: string | null;
    /**
     * Optional URL to the current json/jsonl file (if any). This is used to
     * resolve some relative paths in the asset pointers in the conversation. For
     * example, `aquifer://foo` will be resolved to `dataFileURL/../assets/foo`.
     * We won't resolve relative paths if `dataFileURL` is not provided.
     */
    dataFileURL: string | null;
    /**
     * This overrides the JSON content when user clicks copy JSON or download
     * JSON. It should never be set unless the content you want users to copy is
     * different form the Conversation data itself (e.g., we use it for
     * Comparison).
     */
    overrideSharingJSONString: string | null;
    shouldRenderMarkdown: boolean;
    /**
     * We use DOMPurify to sanitize the markdown rendered HTML before displaying
     * it. This property is used to pass DOMPurify's allowed tags. If this is not
     * provided, we use the default allowed tags defined in dompurify-configs.ts
     */
    markdownAllowedTags: string[] | null;
    /**
     * We use DOMPurify to sanitize the markdown rendered HTML before displaying
     * it. This property is used to pass DOMPurify's allowed attributes. If this
     * is not provided, we use the default allowed attributes defined in
     * dompurify-configs.ts
     */
    markdownAllowedAttributes: string[] | null;
    /**
     * The label shown before the conversation ID.
     */
    conversationLabel: string;
    conversation: TranslatableConversation | null;
    isEditable: boolean;
    /**
     * Focus mode settings.
     * Each of the three properties is an independent filter. If it is empty, we
     * do not apply any filter.
     */
    focusModeAuthor: string[];
    focusModeRecipient: string[];
    focusModeContentType: string[];
    focusModeExemptedMessageIndexes: Set<number>;
    deletedMessageIndexes: Set<number>;
    insertMessageMenuIndex: number | null;
    showMessageEditorPopover: boolean;
    editorFocusedMessage: Message | null;
    editorFocusedMessageIndex: number | null;
    isConvoMarkedForDeletion: boolean;
    hasMessageSharingURLEventListener: boolean;
    hasTranslationEventListener: boolean;
    isShowingTranslation: boolean;
    isTranslating: boolean;
    translationProgress: string;
    translationSourceLanguage: string | null;
    /**
     * Custom labels. They will be shown on the header bar. Each item is a string
     * array with at most four items.
     * 1. ['value'] -> 'value'
     * 2. ['key', 'value'] -> 'key: value'
     * 3. ['key', 'value', 'tooltip text'] -> 'key: value' + tooltip text
     * 4. ['key', 'value', 'tooltip text', 'color'] -> 'key: value' + tooltip text
     *    + text color
     */
    customLabels: string[][];
    /**
     * Custom message labels. They will be shown below the author icon. Each item
     * is a string array with at most four items. The first two items are
     * required, and the last two items are optional.
     * 1. [message index / 'message id', 'tooltip text']
     * 2. [message index / 'message id', 'tooltip text', 'color']
     * 3. [message index / 'message id', 'tooltip text', 'color', 'icon text']
     */
    customMessageLabels: CustomMessageLabel[];
    private effectiveCustomLabels;
    private effectiveCustomMessageLabels;
    private updateEffectiveCustomLabels;
    /**
     * Custom share buttons. They will be shown on in the floating bar when hover
     * over the share button. Each item is a string array with 3 items.
     * You can leave the svg string empty if you want to use the default icon.
     * ['name', 'url', 'svg string']
     */
    customShareButtons: string[][];
    baseTime: number | null;
    popperTooltip: HTMLElement | undefined;
    messageMetadataOverlay: HTMLElement | undefined;
    isResizingMessageMetadata: boolean;
    shareFloatingToolbar: EuphonyFloatingToolbar | undefined | null;
    showShareFloatingToolbar: boolean;
    shareFloatingToolbarButtons: FloatingToolbarButton[];
    cleanupShareFloatingToolbarAutoUpdate: () => void;
    shareFloatingToolbarRepositionAdded: boolean;
    cleanupMessageEditorPopoverAutoUpdate: () => void;
    messageEditorPopoverRepositionAdded: boolean;
    cleanupInsertMessageMenuAutoUpdate: () => void;
    insertMessageMenuRepositionAdded: boolean;
    hasInsertMessageMenuOutsideClickListener: boolean;
    hasMessageEditorPopoverOutsideClickListener: boolean;
    tokenWindowComponent: EuphonyTokenWindow | undefined;
    isShowingMetadata: boolean;
    mouseoverMessage: Message | null;
    mouseoverMessageIndex: number | null;
    isShowingMessageMetadata: boolean;
    conversationMaxWidth: number | null;
    conversationMinWidth: number | null;
    disableMarkdownButton: boolean;
    disableTranslationButton: boolean;
    disableShareButton: boolean;
    disableMetadataButton: boolean;
    disableEditingModeSaveButton: boolean;
    disableConversationIDCopyButton: boolean;
    isShowingPreferenceWindow: boolean;
    euphonyStyleConfig: Record<string, string>;
    disableMessageMetadata: boolean;
    disableConversationName: boolean;
    disablePreferenceButton: boolean;
    disableTokenWindow: boolean;
    theme: 'auto' | 'light' | 'dark';
    isDarkTheme: boolean;
    toolbarTooltipDebouncer: number | null;
    shareFloatingToolbarDebouncer: number | null;
    shareFloatingToolbarDisappearDebouncer: number | null;
    metadataDisappearDebouncer: number | null;
    metadataAppearDebouncer: number | null;
    constructor();
    addEventListener(type: keyof HTMLElementEventMap | 'translation-requested' | 'translation-completed' | 'conversation-metadata-button-toggled' | 'markdown-button-toggled' | 'editing-save-button-clicked' | 'fetch-message-sharing-url' | 'refresh-renderer-list-requested' | 'harmony-render-requested', listener: EventListener, options?: AddEventListenerOptions): void;
    /**
     * This method is called when the DOM is added for the first time
     */
    firstUpdated(): void;
    /**
     * This method is called before new DOM is updated and rendered
     * @param changedProperties Property that has been changed
     */
    willUpdate(changedProperties: PropertyValues<this>): void;
    updated(changedProperties: PropertyValues<this>): void;
    initData(): Promise<void>;
    refreshBaseTime(): void;
    resetComponent(): void;
    /**
     * Return the edited conversation data after filtering deleted messages.
     * This is the single source of truth for all editor-mode exports.
     */
    getEditedConversationData(): Conversation | null;
    /**
     * Serialize the current conversation to a JSON string. It will ignore the
     * deleted messages.
     */
    serializeConversation(indent?: number | null): string;
    updateShareFloatingToolbarPosition(shareButton: HTMLElement, floatingToolbar: HTMLElement): void;
    updateInsertMessageMenuPosition(addButton: HTMLElement, insertMessageMenu: HTMLElement): void;
    updateMessageEditorPopoverPosition(editButton: HTMLElement, messageEditorPopover: HTMLElement): void;
    /**
     * In editor mode, conversations with zero messages need a temporary deleted
     * placeholder so the existing per-message add controls still have an anchor.
     * The placeholder stays filtered out of all exports unless the user restores
     * or inserts real content.
     */
    bootstrapEmptyConversationForEditorMode(): void;
    getMessageByIndex: (messageIndex: number) => HTMLElement | null | undefined;
    translationButtonClicked(): Promise<void>;
    /**
     * MouseEnter Event handler for all the buttons in the toolbar
     * @param e Mouse event
     */
    toolButtonMouseEnter(e: MouseEvent, type: 'markdown' | 'translate' | 'share' | 'metadata' | 'delete' | 'add' | 'edit' | 'reorder-up' | 'reorder-down' | 'custom-label' | 'preference' | 'message-share', maybeTooltipText?: string): void;
    /**
     * MouseLeave Event handler for all the buttons in the toolbar
     * @param e Mouse event
     */
    toolButtonMouseLeave(useTransition?: boolean): void;
    shareButtonMouseEnter(): void;
    shareButtonMouseLeave(): void;
    shareFloatingToolbarButtonClicked(e: CustomEvent<string>): Promise<void>;
    metadataButtonClicked(): void;
    markdownButtonClicked(): void;
    /**
     * Send the current conversation string to the parent
     */
    editingSaveButtonClicked(): void;
    private swapDeletedMessageIndexes;
    private shiftDeletedIndexesAfterInsert;
    reorderUpButtonClicked(messageIndex: number): void;
    reorderDownButtonClicked(messageIndex: number): void;
    createEmptyMessageForContentType(referenceMessage: Message | undefined, contentType: 'text' | 'system' | 'developer'): Message;
    insertMessageAfterIndex(messageIndex: number, contentType: 'text' | 'system' | 'developer'): Promise<void>;
    closeInsertMessageMenu(): void;
    insertMessageMenuWindowPointerDown: (e: Event) => void;
    messageEditorAddMessageButtonClicked(messageIndex: number): void;
    closeMessageEditorPopover(): void;
    messageEditorEditButtonClicked(messageIndex: number): void;
    messageEditorPopoverSaveButtonClicked(e: CustomEvent<MessageEditorUserSetData>): void;
    messageEditorPopoverCancelButtonClicked(): void;
    messageEditorPopoverWindowPointerDown: (e: Event) => void;
    focusEditableFieldsForMessage(messageIndex: number): void;
    preferenceButtonClicked(): void;
    messageInfoMouseEnter(e: MouseEvent, message: Message, messageIndex: number): void;
    messageInfoMouseLeave(): void;
    metadataOverlayMouseEnter(): void;
    metadataOverlayMouseLeave(): void;
    metadataOverlayShareButtonClicked(e: MouseEvent, messageIndex: number): void;
    /**
     * Prevent mouse leave when user drag the overlay to resize it
     * Note this handler is not called on Safari. For some reason, Safari doesn't
     * fire mousedown event when user clicks the resize handle. It doesn't fire it
     * on window or document as well when user clicks the resize handle :(
     * WebKit but: https://bugs.webkit.org/show_bug.cgi?id=280956
     * @param e Mouse event
     */
    metadataMouseDown: () => void;
    loadKatexScript(): HTMLScriptElement | undefined;
    preferenceWindowMaxMessageHeightChanged(e: CustomEvent<string>): void;
    preferenceWindowFocusModeSettingsChanged(e: CustomEvent<FocusModeSettings>): void;
    preferenceWindowMessageLabelChanged(e: CustomEvent<MessageLabelSettings>): void;
    allChildrenUpdateComplete(): Promise<void>;
    relativeTimestampFormatter(creationTime: number): string;
    absoluteTimestampFormatter(creationTime: number): string;
    getAuthorIcon(role: Role): TemplateResult<1>;
    /**
     * Check if the message is hidden by focus mode settings.
     * @param message Message to check
     * @returns True if the message is hidden, false otherwise
     */
    isMessageHiddenByFocusMode(message: Message, messageIndex: number): boolean;
    getMessageContentTemplate(message: Message, i: number): TemplateResult<1>;
    renderTextWithWordBreaks(text: string): TemplateResult[];
    getMessageMetadataInfo(message: Message): TemplateResult<1>;
    render(): TemplateResult<1>;
    static styles: import('lit').CSSResult[];
    expandBlockContents(): void;
    collapseBlockContents(): void;
}
declare global {
    interface HTMLElementTagNameMap {
        'euphony-conversation': EuphonyConversation;
    }
}
export declare const parseConversationJSONString: (conversationString: string) => Conversation | null;
export {};
