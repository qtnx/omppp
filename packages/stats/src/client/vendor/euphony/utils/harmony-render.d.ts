import { HarmonyRenderResponse } from '../types/common-types';
export declare const HARMONY_RENDERER_NAME = "o200k_harmony";
export declare const renderHarmonyConversationForDisplay: (conversationJSON: string) => string;
export declare const renderHarmonyConversationInBrowser: (conversation: string, renderer: string) => HarmonyRenderResponse;
