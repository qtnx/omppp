export interface Conversation {
    id?: string | null;
    messages: Message[];
    create_time?: number | null;
    metadata?: Record<string, unknown>;
}
export interface Message {
    id?: string | null;
    role: Role;
    name?: string | null;
    create_time?: number | null;
    metadata?: Record<string, unknown>;
    content: MessageContent[] | string;
    channel?: string | null;
    recipient?: string | null;
    content_type?: string | null;
}
export declare enum Role {
    User = "user",
    Assistant = "assistant",
    System = "system",
    Developer = "developer",
    Tool = "tool"
}
export declare enum RealAuthor {
    ToolWeb = "tool:web"
}
export interface Author {
    role: Role;
    name?: string | null;
}
export type MessageContent = TextMessageContent | CodeMessageContent | SystemContentMessageContent | DeveloperContentMessageContent;
export declare const EUPHONY_MESSAGE_CONTENT_TYPES: readonly ["code", "developer", "system", "text"];
export type EuphonyMessageContentType = (typeof EUPHONY_MESSAGE_CONTENT_TYPES)[number];
export interface TextMessageContent {
    text: string;
}
export interface CodeMessageContent {
    content_type: 'code';
    text: string;
    language?: string | null;
}
export type ReasoningEffort = 'Low' | 'Medium' | 'High';
export interface ChannelConfig {
    valid_channels: string[];
    channel_required: boolean;
}
export interface ToolDescription {
    name: string;
    description: string;
    parameters?: Record<string, unknown> | null;
}
export interface ToolNamespaceConfig {
    name: string;
    description?: string | null;
    tools: ToolDescription[];
}
export interface SystemContentMessageContent {
    model_identity?: string | null;
    reasoning_effort?: ReasoningEffort | null;
    conversation_start_date?: string | null;
    knowledge_cutoff?: string | null;
    channel_config?: ChannelConfig | null;
    tools?: Record<string, ToolNamespaceConfig> | null;
}
export interface DeveloperContentMessageContent {
    instructions?: string | null;
    tools?: Record<string, ToolNamespaceConfig> | null;
}
export declare const getContentTypeFromContent: (content: MessageContent[] | string) => EuphonyMessageContentType;
export declare const tryGetContentTypeFromContent: (content: MessageContent[] | string) => EuphonyMessageContentType | null;
export declare const getContentFromContentOrString: (content: MessageContent[] | string) => MessageContent;
