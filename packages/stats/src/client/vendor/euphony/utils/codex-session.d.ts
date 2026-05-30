import { Conversation } from '../types/harmony-types';
export interface CodexSessionParseResult {
    conversation: Conversation;
    customLabels: string[][];
}
export declare const isCodexSessionJSONL: (raw: unknown[]) => boolean;
export declare const parseCodexSession: (raw: unknown[]) => CodexSessionParseResult | null;
