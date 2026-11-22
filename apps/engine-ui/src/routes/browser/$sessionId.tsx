import { createFileRoute } from '@tanstack/react-router';

import { requireFeature } from '../../app/registry/require-feature';
import { BrowserViewerPage } from '../../features/browser/browser-viewer-page';

export const Route = createFileRoute('/browser/$sessionId')({
    beforeLoad: requireFeature('browser'),
    component: BrowserViewerPage,
});
