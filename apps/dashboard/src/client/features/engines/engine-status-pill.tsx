import { StatusPill } from '@ptbk/ui';

import type { EngineView } from '../../../shared/api/routes';
import { engineStatusLabel, engineStatusTone } from './engine-labels';

/** Status as a dot and words; `quiet` drops the wash for dense rows. */
export function EngineStatusPill(props: {
    readonly engine: Pick<EngineView, 'status' | 'suspendedBy'>;
    readonly variant?: 'soft' | 'quiet';
}) {
    return (
        <StatusPill tone={engineStatusTone(props.engine.status)} variant={props.variant ?? 'soft'}>
            {engineStatusLabel(props.engine)}
        </StatusPill>
    );
}
