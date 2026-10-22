export type TextPart =
    { readonly kind: 'text'; readonly text: string } | { readonly kind: 'link'; readonly href: string };

const URL_PATTERN = /https?:\/\/[^\s<>"']+/g;

/**
 * Splits an email's plain text into text and links. Only URLs on the dashboard's own origin become links: the mailbox
 * opens sign-up and recovery links here and never turns other text into somewhere to go.
 */
export function linkParts(text: string, origin: string): readonly TextPart[] {
    const parts: TextPart[] = [];
    let rest = 0;
    for (const match of text.matchAll(URL_PATTERN)) {
        const url = URL.parse(match[0]);
        if (url?.origin !== origin) continue;
        if (match.index > rest) parts.push({ kind: 'text', text: text.slice(rest, match.index) });
        parts.push({ kind: 'link', href: url.href });
        rest = match.index + match[0].length;
    }
    if (rest < text.length) parts.push({ kind: 'text', text: text.slice(rest) });
    return parts;
}
