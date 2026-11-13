const MAX_QUOTE_LENGTH = 240;

/**
 * The words of an agent's question to the User, for quoting on Home: the paragraph that carries `+@User` (the
 * engine's mark for "this asks the User"), else the first one, with the mark and the lightest markdown taken out
 * and whitespace collapsed. Plain text only; the caller renders it as a text node.
 */
export function questionQuote(content: string): string {
    const paragraphs = content
        .split(/\n\s*\n/)
        .map((paragraph) => paragraph.trim())
        .filter((paragraph) => paragraph !== '');
    const asking = paragraphs.find((paragraph) => /\+@User\b/.test(paragraph)) ?? paragraphs[0] ?? '';
    const plain = plainText(asking);
    return plain.length > MAX_QUOTE_LENGTH ? `${plain.slice(0, MAX_QUOTE_LENGTH - 1).trimEnd()}…` : plain;
}

/**
 * A thread's words as one calm line: without the engine's marks (`+@User`, `{task}` braces) and the lightest markdown
 * (list and heading markers, `*` emphasis, backticks; underscores stay, they are in tool names), whitespace collapsed. Still untrusted text: render it as a text node.
 */
export function plainText(text: string): string {
    return text
        .replace(/\+@User\b:?\s*/g, '')
        .replace(/\{([^{}\n]{1,512})\}/g, '$1')
        .replace(/^\s*(?:[-*+]|\d+\.|#{1,6}|>)\s+/gm, '')
        .replace(/(^|\s)[-*+]\s+/g, '$1')
        .replace(/[*`]+/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}
