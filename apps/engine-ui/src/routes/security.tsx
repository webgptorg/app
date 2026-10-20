import { createFileRoute } from '@tanstack/react-router';

import { requireFeature } from '../app/registry/require-feature';
import { PageStub } from '../features/shell/page-stub';
import { m } from '../paraglide/messages';

// U-06 fills this screen.
export const Route = createFileRoute('/security')({
    beforeLoad: requireFeature('security'),
    component: () => <PageStub title={m.security_title()} />,
});
