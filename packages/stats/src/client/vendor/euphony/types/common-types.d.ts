import { TemplateResult } from 'lit';
import { Conversation, DeveloperContentMessageContent, Message, TextMessageContent } from './harmony-types';
export interface MessageSharingRequest {
    /**
     * The message index in the conversation
     */
    messageIndex: number;
    /**
     * The resolve function to call when the message's sharing URL is fetched
     * The value should be a sharable URL
     */
    resolve: (value: string) => void;
    /**
     * The reject function to call when the message's sharing URL is not fetched
     */
    reject: (reason?: string) => void;
}
export interface TranslationRequest {
    /**
     * The text to translate
     */
    text: string;
    /**
     * The resolve function to call when the translation is done
     */
    resolve: (value: TranslateResponse) => void;
    /**
     * The reject function to call when the translation is failed
     */
    reject: (reason?: string) => void;
}
interface BlockContentEditInfo {
    location: string;
    index: number | string;
}
export interface BlockContent {
    label: string;
    content: TemplateResult | string;
    isContentHTML: boolean;
    isCollapsed: boolean;
    subBlocks?: BlockContent[];
    editInfo?: BlockContentEditInfo;
    editableHTML?: TemplateResult;
}
export interface BlobJSONLPayload {
    total: number;
    data: string[] | Conversation[] | Record<string, unknown>[];
    isFiltered: boolean;
    matchedCount: number;
    resolvedURL: string;
}
export interface BlobJSONLResponse {
    offset: number;
    limit: number;
    total: number;
    data: string[] | Conversation[] | Record<string, Conversation | string>[];
    isFiltered: boolean;
    matchedCount: number;
    resolvedURL: string;
}
export interface TranslatableConversation extends Conversation {
    /**
     * Translated messages of the original messages
     */
    translatedMessages?: TranslatableMessage[];
}
export interface TranslationCompletedEventDetail {
    translatedMessages: TranslatableMessage[];
}
export type TranslatableMessage = (Omit<Message, 'content'> & {
    content: TextMessageContent[];
    isTranslated?: boolean;
}) | (Omit<Message, 'content'> & {
    content: DeveloperContentMessageContent[];
    isTranslated?: boolean;
});
export interface TranslateResponse {
    language: string;
    is_translated: boolean;
    translation: string;
    has_command: boolean;
}
export interface SimpleEventMessage {
    message: string;
}
export type Mutable<Type> = {
    -readonly [Key in keyof Type]: Type[Key];
};
export interface Point {
    x: number;
    y: number;
}
export interface Rect {
    x: number;
    y: number;
    width: number;
    height: number;
}
export interface RectPoint {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
}
export interface Padding {
    top: number;
    right: number;
    bottom: number;
    left: number;
}
export interface Size {
    width: number;
    height: number;
}
export interface PromptModel {
    task: string;
    prompt: string;
    variables: string[];
    temperature: number;
    stopSequences?: string[];
}
export type TextGenWorkerMessage = {
    command: 'startTextGen';
    payload: {
        requestID: string;
        apiKey: string;
        prompt: string;
        temperature: number;
        stopSequences?: string[];
        detail?: string;
    };
} | {
    command: 'finishTextGen';
    payload: {
        requestID: string;
        apiKey: string;
        result: string;
        prompt: string;
        detail: string;
    };
} | {
    command: 'error';
    payload: {
        requestID: string;
        originalCommand: string;
        message: string;
    };
};
export interface RefreshRendererListRequest {
    resolve: (value: string[]) => void;
    reject: (reason?: string) => void;
}
export interface RefreshRendererListResponse {
    renderers: string[];
}
export interface HarmonyRenderRequest {
    conversation: string;
    renderer: string;
    resolve: (value: HarmonyRenderResponse) => void;
    reject: (reason?: string) => void;
}
export interface HarmonyRenderResponse {
    tokens: number[];
    decoded_tokens: string[];
    display_string: string;
    partial_success_error_messages: string[];
}
export {};
