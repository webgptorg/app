/** Case- and accent-insensitive, so "nastaveni" finds "Nastavení". */
export function normalizeForSearch(text: string): string {
    return text.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase();
}

/** Every word of the query appears in one of the texts. An empty query matches everything. */
export function matchesQuery(query: string, texts: readonly string[]): boolean {
    const words = normalizeForSearch(query)
        .split(/\s+/)
        .filter((word) => word !== '');
    if (words.length === 0) return true;
    const haystack = texts.map(normalizeForSearch).join('\n');
    return words.every((word) => haystack.includes(word));
}
