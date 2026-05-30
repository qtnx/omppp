import { LitElement, PropertyValues } from 'lit';
import { Conversation } from '../../types/harmony-types';
import { EuphonyConversation } from '../conversation/conversation';
import { FocusModeSettings, MessageLabelSettings } from '../preference-window/preference-window';
export declare class EuphonyCodex extends LitElement {
    sessionString: string;
    sessionData: unknown[] | null;
    sharingURL: string | null;
    conversationLabel: string;
    conversationMaxWidth: string | null;
    conversationStyle: string;
    shouldRenderMarkdown: boolean;
    isShowingMetadata: boolean;
    focusModeAuthor: string[];
    focusModeRecipient: string[];
    focusModeContentType: string[];
    disableMarkdownButton: boolean;
    disableTranslationButton: boolean;
    disableShareButton: boolean;
    disableMetadataButton: boolean;
    disableMessageMetadata: boolean;
    disableConversationName: boolean;
    disablePreferenceButton: boolean;
    disableImagePreviewWindow: boolean;
    disableTokenWindow: boolean;
    disableEditingModeSaveButton: boolean;
    disableConversationIDCopyButton: boolean;
    disableDownloadConvoButtonTooltip: string;
    disableCopyConvoButtonTooltip: string;
    theme: 'auto' | 'light' | 'dark';
    conversation: Conversation | null;
    parseError: string | null;
    conversationComponent: EuphonyConversation | undefined;
    private parseSessionString;
    private refreshConversationFromSession;
    willUpdate(changedProperties: PropertyValues<this>): void;
    render(): import('lit-html').TemplateResult<1>;
    static styles: import('lit').CSSResult[];
    preferenceWindowMessageLabelChanged(e: CustomEvent<MessageLabelSettings>): void;
    preferenceWindowFocusModeSettingsChanged(e: CustomEvent<FocusModeSettings>): void;
    expandBlockContents(): void;
    collapseBlockContents(): void;
    translationButtonClicked(): void;
}
declare global {
    interface HTMLElementTagNameMap {
        'euphony-codex': EuphonyCodex;
    }
}
