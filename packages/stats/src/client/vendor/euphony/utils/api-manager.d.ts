import { BlobJSONLPayload, HarmonyRenderResponse } from '../types/common-types';
import { Conversation } from '../types/harmony-types';
export declare let EUPHONY_API_URL: string;
export declare const extractConversationFromJSONL: (data: unknown[]) => Conversation[] | null;
export declare class APIManager {
    apiBaseURL: string;
    constructor(apiBaseURL: string);
    getJSONL: ({ blobURL, offset, limit, noCache, jmespathQuery }: {
        blobURL: string;
        offset: number;
        limit: number;
        noCache: boolean;
        jmespathQuery: string;
    }) => Promise<BlobJSONLPayload>;
    refreshRendererList: () => Promise<string[]>;
    harmonyRender: (conversation: string, renderer: string) => Promise<HarmonyRenderResponse>;
}
export declare class BrowserAPIManager {
    getJSONL: ({ blobURL, offset, limit, noCache, jmespathQuery }: {
        blobURL: string;
        offset: number;
        limit: number;
        noCache: boolean;
        jmespathQuery: string;
    }) => Promise<BlobJSONLPayload>;
    validateOpenAIAPIKey(apiKey: string): Promise<boolean>;
    /**
     * Translates the given text using the OpenAI API directly from browser with a
     * custom API key.
     * @param text The text to translate.
     * @param apiKey The OpenAI API key to use for the request.
     * @returns A promise resolving to the translation result.
     */
    translateTextWithOpenAI(text: string, apiKey: string): Promise<{
        translation: string;
        is_translated: boolean;
        language: string;
        has_command: boolean;
    }>;
    refreshRendererList: () => string[];
    harmonyRender: (conversation: string, renderer: string) => HarmonyRenderResponse;
}
