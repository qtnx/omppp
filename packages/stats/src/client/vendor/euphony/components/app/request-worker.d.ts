import { Semaphore } from 'async-mutex';
import { HarmonyRenderRequest, MessageSharingRequest, RefreshRendererListRequest, TranslationRequest } from '../../types/common-types';
import { APIManager, BrowserAPIManager } from '../../utils/api-manager';
import { URLManager } from './url-manager';
/**
 * A class that handles requests from the euphony-conversation component.
 */
export declare class RequestWorker {
    apiBaseURL: string;
    apiManager: APIManager;
    browserAPIManager: BrowserAPIManager;
    constructor(apiBaseURL: string);
    static translationSemaphore: Semaphore;
    /**
     * Handles a translation request with max concurrency control using translationSemaphore.
     * @param e The custom event containing the translation request details
     */
    translationRequestHandler(e: CustomEvent<TranslationRequest>): Promise<void>;
    /**
     * Handles a translation request using the OpenAI API directly from browser.
     * @param e The custom event containing the translation request details
     */
    frontendOnlyTranslationRequestHandler(e: CustomEvent<TranslationRequest>, apiKey: string): Promise<void>;
    /**
     * Handles a fetch message sharing URL request.
     * @param e The custom event containing the fetch message sharing URL request details
     */
    fetchMessageSharingURLRequestHandler(e: CustomEvent<MessageSharingRequest>, conversationIndex: number, urlManager: URLManager, blobPath: string | null): void;
    /**
     * Handles a renderer refresh request by calling API
     */
    refreshRendererListRequestHandler(e: CustomEvent<RefreshRendererListRequest>): Promise<void>;
    /**
     * Handles a renderer refresh request in frontend-only mode.
     */
    frontendOnlyRefreshRendererListRequestHandler(e: CustomEvent<RefreshRendererListRequest>): Promise<void>;
    /**
     * Handles a harmony render request by calling API
     */
    harmonyRenderRequestHandler(e: CustomEvent<HarmonyRenderRequest>): Promise<void>;
    /**
     * Handles a harmony render request in frontend-only mode.
     */
    frontendOnlyHarmonyRenderRequestHandler(e: CustomEvent<HarmonyRenderRequest>): Promise<void>;
}
