import { LitElement, PropertyValues } from 'lit';
import { Conversation } from '../../types/harmony-types';
import { APIManager, BrowserAPIManager } from '../../utils/api-manager';
import { EuphonyCodex } from '../codex/codex';
import { NightjarConfirmDialog } from '../confirm-dialog/confirm-dialog';
import { EuphonyConversation } from '../conversation/conversation';
import { NightjarInputDialog } from '../input-dialog/input-dialog';
import { FocusModeSettings, MessageLabelSettings } from '../preference-window/preference-window';
import { EuphonySearchWindow } from '../search-window/search-window';
import { NightjarToast } from '../toast/toast';
import { EuphonyTokenWindow } from '../token-window/token-window';
import { LocalDataWorkerMessage } from './local-data-worker';
import { RequestWorker } from './request-worker';
import { URLManager } from './url-manager';
export interface ToastMessage {
    message: string;
    type: 'success' | 'warning' | 'error';
}
declare enum DataType {
    CONVERSATION = "conversation",
    CODEX = "codex",
    JSON = "json"
}
type MenuItems = 'Load without cache' | 'Load from clipboard' | 'Load local file' | 'Editor mode' | 'Leave editor mode' | 'Filter data' | 'Preferences' | 'Code';
type ConversationViewerElement = EuphonyConversation | EuphonyCodex;
/**
 * App element.
 *
 */
export declare class EuphonyApp extends LitElement {
    allConversationData: Conversation[];
    conversationData: Conversation[];
    JSONData: Record<string, unknown>[];
    codexSessionData: unknown[][];
    dataType: DataType;
    isLoadingData: boolean;
    curPage: number;
    globalIsShowingMetadata: boolean;
    globalShouldRenderMarkdown: boolean;
    jmespathQuery: string;
    focusModeAuthor: string[];
    focusModeRecipient: string[];
    focusModeContentType: string[];
    toastComponent: NightjarToast | undefined;
    toastMessage: string;
    toastType: 'success' | 'warning' | 'error';
    confirmDialogComponent: NightjarConfirmDialog | undefined;
    inputDialogComponent: NightjarInputDialog | undefined;
    searchWindowComponent: EuphonySearchWindow | undefined;
    tokenWindowComponent: EuphonyTokenWindow | undefined;
    conversationGridElement: HTMLElement | undefined | null;
    localFileInputElement: HTMLInputElement | undefined;
    apiManager: APIManager;
    requestWorker: RequestWorker;
    browserAPIManager: BrowserAPIManager;
    private pendingOpenAIKeyPromise;
    euphonyStyleConfig: Record<string, string>;
    appStyleConfig: Record<string, string>;
    itemsPerPage: number;
    _totalConversationSize: number;
    _totalConversationSizeIncludingUnfiltered: number;
    noCacheBlobPaths: Set<string>;
    get totalConversationSize(): number;
    get totalPageNum(): number;
    get totalConversationSizeIncludingUnfiltered(): number;
    isEditorMode: boolean;
    selectedConversationIDs: Set<number>;
    isFrontendOnlyMode: boolean;
    showToolBarMenu: boolean;
    isLoadingFromCache: boolean;
    isLoadingFromClipboard: boolean;
    isGridView: boolean;
    gridViewColumnWidth: number;
    comparisonColumnWidth: number;
    showPreferenceWindow: boolean;
    popperTooltip: HTMLElement | undefined;
    showScrollTopButton: boolean;
    urlManager: URLManager;
    localDataWorker: Worker;
    localDataWorkerRequestCount: number;
    get localDataWorkerRequestID(): number;
    activeLocalDataWorkerRequestID: number | null;
    localDataWorkerPendingRequests: Map<number, {
        resolve: () => void;
        reject: (reason?: unknown) => void;
    }>;
    cacheInfoTooltipDebouncer: number | null;
    constructor();
    disconnectedCallback(): void;
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
     * Load the JSONL file from the URL provided in the input element
     * @returns
     */
    loadButtonClicked({ noCache }?: {
        noCache?: boolean;
    }): Promise<void>;
    /**
     * Serialize the current data and download it as a JSONL file
     */
    downloadButtonClicked(): void;
    selectAllButtonClicked(): void;
    updatePageNumber(newPageNumber: number, scrollToTop: boolean): Promise<void>;
    pageClicked(e: CustomEvent<number>): void;
    itemsPerPageChanged(e: CustomEvent<number>): void;
    hashChanged(): Promise<void>;
    conversationMetadataButtonToggled(e: CustomEvent<boolean>): Promise<void>;
    markdownButtonToggled(e: CustomEvent<boolean>): Promise<void>;
    menuItemClicked(e: CustomEvent<MenuItems>): void;
    cacheInfoMouseEnter(e: MouseEvent): void;
    cacheInfoMouseLeave(useTransition?: boolean): void;
    preferenceWindowMaxMessageHeightChanged(e: CustomEvent<string>): void;
    preferenceWindowMessageLabelChanged(e: CustomEvent<MessageLabelSettings>): void;
    preferenceWindowGridViewColumnWidthChanged(e: CustomEvent<string>): void;
    preferenceWindowComparisonWidthChanged(e: CustomEvent<string>): void;
    preferenceWindowLayoutChanged(e: CustomEvent<string>): void;
    preferenceWindowExpandAllClicked(): void;
    preferenceWindowCollapseAllClicked(): void;
    preferenceWindowTranslateAllClicked(): void;
    preferenceWindowFocusModeSettingsChanged(e: CustomEvent<FocusModeSettings>): void;
    searchWindowQuerySubmitted(e: CustomEvent<string>): Promise<void>;
    /**
     * Show the token window when user clicks on the harmony render button
     * @param e CustomEvent<string> - The custom event containing the conversation string
     */
    harmonyRenderButtonClicked(e: CustomEvent<string>): void;
    /**
     * Ensures an OpenAI API key is available in localStorage.
     * - If present, resolves immediately with the key.
     * - If absent, shows a single input dialog and returns a shared Promise so
     *   concurrent requests wait for the same user action.
     * - Resolves to null if the user cancels.
     */
    private ensureOpenAIAPIKey;
    allChildrenUpdateComplete(): Promise<void>;
    scrollToTop: (top?: number, behavior?: "instant" | "smooth") => void;
    scrollToBottom: (behavior?: "instant" | "smooth") => void;
    scrollToConversation: (conversationID: string, behavior?: "instant" | "smooth") => void;
    scrollToMessage: (conversationID: string, messageIndex: number, behavior?: "instant" | "smooth") => void;
    /**
     * Validate and transform the conversations
     * Transform the conversation id from `conversation_id` to `id` if it exists
     *
     * @param conversations - The conversations to validate and transform
     * @returns The validated and transformed conversations
     */
    validateAndTransformConversations: (conversations: (string | Conversation | Record<string, unknown>)[]) => boolean;
    validateConversation: (conversation: string | Conversation | Record<string, unknown>) => boolean;
    validateComparison: (comparison: string | Conversation | Record<string, unknown>) => boolean;
    loadDataFromText: (sourceText: string, sourceName: "clipboard" | "file") => Promise<void>;
    loadDataFromFile: (sourceFile: File) => Promise<void>;
    localDataWorkerMessageHandler(e: MessageEvent<LocalDataWorkerMessage>): void;
    localFileInputChanged(e: Event): void;
    loadData: ({ blobURL, offset, limit, showSuccessToast, noCache, jmespathQuery }: {
        blobURL: string;
        offset: number;
        limit: number;
        showSuccessToast?: boolean;
        noCache?: boolean;
        jmespathQuery?: string;
    }) => Promise<{
        isLoadDataSuccessful: boolean;
        loadDataMessage: string;
        loadedURL: string;
    }>;
    resetFilter: (filter: "jmespath" | "concept") => Promise<void>;
    resetHash: () => void;
    buildEuphonyStyle(styleConfig: Record<string, string>): string;
    getConversationViewerElements(): ConversationViewerElement[];
    render(): import('lit-html').TemplateResult<1>;
    static styles: import('lit').CSSResult[];
}
declare global {
    interface HTMLElementTagNameMap {
        'euphony-app': EuphonyApp;
    }
}
export {};
