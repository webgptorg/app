import { createFileRoute } from '@tanstack/react-router';

import { requireFeature } from '../app/registry/require-feature';
import { PageStub } from '../features/shell/page-stub';
import { m } from '../paraglide/messages';

// U-06 fills this screen.
export const Route = createFileRoute('/secrets')({
    beforeLoad: requireFeature('secrets'),
    component: () => <PageStub title={m.secrets_title()} />,
});
