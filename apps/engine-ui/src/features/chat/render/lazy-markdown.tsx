import { lazy, Suspense } from 'react';

import { useBrowser } from '../../../app/browser-context';
import { PlainText } from './plain-text';
import { preloadMarkdown } from './preload-markdown';

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
