import { EngineId } from '@ptbk/protocol';
import { createFileRoute } from '@tanstack/react-router';

import { EngineDetailPage } from '../../../features/engines/engine-detail-page';

function EngineRoute() {
    const { engineId } = Route.useParams();
    // Anything that is not an engine ID cannot name one, so it is "not found" without asking the API.
    const parsed = EngineId.safeParse(engineId);
    return <EngineDetailPage engineId={parsed.success ? parsed.data : null} />;
}

export const Route = createFileRoute('/_app/engines/$engineId')({
    component: EngineRoute,
});
