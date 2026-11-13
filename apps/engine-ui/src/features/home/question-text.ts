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
    const plain = asking
        .replace(/\+@User\b:?\s*/g, '')
        .replace(/^\s*(?:[-*+]|\d+\.|#{1,6}|>)\s+/gm, '')
        .replace(/[*_`]+/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    return plain.length > MAX_QUOTE_LENGTH ? `${plain.slice(0, MAX_QUOTE_LENGTH - 1).trimEnd()}…` : plain;
}
