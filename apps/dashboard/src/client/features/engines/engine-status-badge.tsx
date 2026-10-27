import { Badge } from '@ptbk/ui';
import { CircleCheck, CircleDashed, CircleHelp, CircleOff, CircleSlash, CircleUser } from 'lucide-react';

import type { EngineView } from '../../../shared/api/routes';
import { engineStatusLabel, engineStatusTone } from './engine-labels';

const ICONS = {
    online: CircleCheck,
    offline: CircleOff,
    'never-seen': CircleDashed,
    'owner-pending': CircleUser,
    unknown: CircleHelp,
    suspended: CircleSlash,
} as const;

/** Status as a word with a distinct icon; the tone only repeats what both already say. */
export function EngineStatusBadge(props: { readonly engine: Pick<EngineView, 'status' | 'suspendedBy'> }) {
    const Icon = ICONS[props.engine.status];
    return (
        <Badge tone={engineStatusTone(props.engine.status)} icon={<Icon aria-hidden />}>
            {engineStatusLabel(props.engine)}
        </Badge>
    );
}
