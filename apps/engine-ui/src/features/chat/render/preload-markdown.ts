import type { Markdown } from './markdown';

export interface MarkdownModule {
    readonly Markdown: typeof Markdown;
}

let markdownModule: Promise<MarkdownModule> | undefined;

/**
 * Starts loading the markdown renderer, e.g. when a chat route loads, so finished replies render without a swap. A
 * module of its own: route loaders sit in the entry chunk, and must not pull the thread's renderers in with them.
 */
export function preloadMarkdown(): Promise<MarkdownModule> {
    markdownModule ??= import('./markdown');
    return markdownModule;
}
