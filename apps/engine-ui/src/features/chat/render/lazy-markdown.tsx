import { lazy, Suspense } from 'react';

import { useBrowser } from '../../../app/browser-context';
import type { Markdown } from './markdown';
import { PlainText } from './plain-text';

interface MarkdownModule {
    readonly Markdown: typeof Markdown;
}

let markdownModule: Promise<MarkdownModule> | undefined;

/** Starts loading the markdown renderer, e.g. when a chat route loads, so finished replies render without a swap. */
export function preloadMarkdown(): Promise<MarkdownModule> {
    markdownModule ??= import('./markdown');
    return markdownModule;
}

const LazyMarkdown = lazy(() => preloadMarkdown().then((module) => ({ default: module.Markdown })));

/** A finished agent reply as safe markdown; until the renderer has loaded, the same text plain. */
export function MessageMarkdown({ source }: { readonly source: string }) {
    const { location } = useBrowser();
    return (
        <Suspense fallback={<PlainText text={source} />}>
            <LazyMarkdown source={source} origin={location.origin} />
        </Suspense>
    );
}
