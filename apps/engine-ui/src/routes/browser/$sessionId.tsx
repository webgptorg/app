import { KNOWN_CAPABILITIES } from '@ptbk/engine-api';
import { loadAccess } from '../../app/registry/engine-access';
import { createFileRoute } from '@tanstack/react-router';

import { requireFeature } from '../../app/registry/require-feature';
import { BrowserViewerPage } from '../../features/browser/browser-viewer-page';

export const Route = createFileRoute('/browser/$sessionId')({
    beforeLoad: async (input) => {
        const access = await loadAccess(input.context);
        if (access.supports(KNOWN_CAPABILITIES.walletSignIn) && access.can('browser.control')) return;
        return requireFeature('browser')(input);
    },
    component: BrowserViewerPage,
});
