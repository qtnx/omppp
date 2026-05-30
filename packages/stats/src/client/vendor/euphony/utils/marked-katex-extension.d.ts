export interface MarkedKatexOptions {
    nonStandard?: boolean;
    [key: string]: unknown;
}
interface Token {
    text: string;
    displayMode: boolean;
}
export default function (options?: MarkedKatexOptions): {
    extensions: {
        name: string;
        level: string;
        tokenizer(src: string): {
            type: string;
            raw: string;
            text: string;
            displayMode: boolean;
        } | undefined;
        renderer: (token: Token) => string;
    }[];
};
export {};
