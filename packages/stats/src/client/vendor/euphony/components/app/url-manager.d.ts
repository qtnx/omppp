import { EuphonyApp } from './app';
export declare class URLManager {
    private app;
    constructor(app: EuphonyApp);
    /**
     * Update the URL based on the current configs.
     */
    updateURL(): void;
    /**
     * Update the configs based on the current URL.
     */
    updateConfigsFromURL(): void;
    /**
     * Get the share URL for a conversation.
     * @param conversationID The ID of the conversation to share.
     * @returns The share URL for the conversation.
     */
    getShareURL: (conversationID: number, blobPath: string | null) => string;
    /**
     * Get the share URL for a message.
     * @param conversationID The ID of the conversation to share.
     * @returns The share URL for the message.
     */
    getMessageShareURL: (conversationID: number, messageIndex: number, blobPath: string | null) => string;
}
