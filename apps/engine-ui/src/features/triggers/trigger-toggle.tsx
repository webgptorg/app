import type { ReadTrigger } from '@ptbk/engine-api';
import { Button } from '@ptbk/ui';
import type { ButtonSize } from '@ptbk/ui';
import { Pause, Play } from 'lucide-react';

import { m } from '../../paraglide/messages';
import { usePermissions } from '../session/use-permissions';
import { canPause, canResume, useTriggerMutations } from './use-trigger-mutations';

/**
 * Pause or resume in one tap, the owner's way to stop anything at once (docs/design/ui.md). Both stay secondary: a
 * list may hold several, and none is the page's primary action. Nothing without `triggers.manage`, and nothing for a
 * trigger that can do neither (ended, or a newer engine's lifecycle).
 */
export function TriggerToggle({
    trigger,
    size = 'sm',
}: {
    readonly trigger: Pick<ReadTrigger, 'id' | 'name' | 'lifecycle'>;
    readonly size?: ButtonSize;
}) {
    const { can } = usePermissions();
    const { pause, resume } = useTriggerMutations();
    if (!can('triggers.manage')) return null;
    const target = { id: trigger.id, name: trigger.name };
    if (canPause(trigger)) {
        return (
            <Button
                size={size}
                aria-label={m.trigger_pause_named({ name: trigger.name })}
                onClick={() => {
                    pause.mutate(target);
                }}
            >
                <Pause aria-hidden className="size-4" />
                {m.trigger_pause()}
            </Button>
        );
    }
    if (canResume(trigger)) {
        return (
            <Button
                size={size}
                aria-label={m.trigger_resume_named({ name: trigger.name })}
                onClick={() => {
                    resume.mutate(target);
                }}
            >
                <Play aria-hidden className="size-4" />
                {m.trigger_resume()}
            </Button>
        );
    }
    return null;
}
