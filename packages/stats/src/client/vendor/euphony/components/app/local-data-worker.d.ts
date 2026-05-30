import { Conversation } from '../../types/harmony-types';
export type LocalDataWorkerMessage = {
    command: 'startParseData';
    payload: {
        requestID: number;
        sourceName: 'clipboard' | 'file';
        sourceText?: string;
        sourceFile?: File;
    };
} | {
    command: 'finishParseData';
    payload: {
        requestID: number;
        sourceName: 'clipboard' | 'file';
        dataType: 'codex';
        codexSessionData: unknown[];
    } | {
        requestID: number;
        sourceName: 'clipboard' | 'file';
        dataType: 'conversation';
        conversationData: Conversation[];
    } | {
        requestID: number;
        sourceName: 'clipboard' | 'file';
        dataType: 'json';
        jsonData: Record<string, unknown>[];
    };
} | {
    command: 'error';
    payload: {
        requestID: number;
        sourceName: 'clipboard' | 'file';
        message: string;
    };
};
