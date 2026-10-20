import { createFileRoute } from '@tanstack/react-router';

import { requireFeature } from '../app/registry/require-feature';
import { PageStub } from '../features/shell/page-stub';
import { m } from '../paraglide/messages';

// U-07 fills this screen.
export const Route = createFileRoute('/audit')({
    beforeLoad: requireFeature('audit'),
    component: () => <PageStub title={m.audit_title()} />,
});
