import type { ReadTrigger, ReadTriggerFire } from '@ptbk/engine-api';
import { StatusPill } from '@ptbk/ui';
import type { StatusTone } from '@ptbk/ui';

import { m } from '../../paraglide/messages';

export type TriggerKindValue = ReadTrigger['kind'];
export type TriggerLifecycleValue = ReadTrigger['lifecycle'];

/** A kind from a newer engine shows as the engine named it. */
export function triggerKindLabel(trigger: Pick<ReadTrigger, 'kind'> & { readonly rawKind?: string }): string {
    switch (trigger.kind) {
        case 'email':
            return m.trigger_kind_email();
        case 'schedule':
            return m.trigger_kind_schedule();
        case 'webhook':
            return m.trigger_kind_webhook();
        case 'unknown':
            return trigger.rawKind ?? m.trigger_value_unknown();
    }
}

export function knownKindLabel(kind: Exclude<TriggerKindValue, 'unknown'>): string {
    return triggerKindLabel({ kind });
}

interface Look {
    readonly label: string;
    readonly tone: StatusTone;
}

// Paused and ended share the quiet tone the peek cards use; the words tell them apart.
function lifecycleLook(lifecycle: TriggerLifecycleValue, raw: string): Look {
    switch (lifecycle) {
        case 'active':
            return { label: m.trigger_lifecycle_active(), tone: 'success' };
        case 'paused':
            return { label: m.trigger_lifecycle_paused(), tone: 'neutral' };
        case 'ended':
            return { label: m.trigger_lifecycle_ended(), tone: 'neutral' };
        case 'failed':
            return { label: m.trigger_lifecycle_failed(), tone: 'danger' };
        case 'unknown':
            return { label: raw, tone: 'neutral' };
    }
}

export function lifecycleLabel(lifecycle: Exclude<TriggerLifecycleValue, 'unknown'>): string {
    return lifecycleLook(lifecycle, lifecycle).label;
}

export function lifecycleTone(lifecycle: TriggerLifecycleValue): StatusTone {
    return lifecycleLook(lifecycle, lifecycle).tone;
}

/** The lifecycle in words beside a dot, never colour alone; a newer engine's lifecycle shows as it named it. */
export function TriggerLifecyclePill({
    trigger,
}: {
    readonly trigger: Pick<ReadTrigger, 'lifecycle' | 'rawLifecycle'>;
}) {
    const look = lifecycleLook(trigger.lifecycle, trigger.rawLifecycle);
    return <StatusPill tone={look.tone}>{look.label}</StatusPill>;
}

function outcomeLook(outcome: ReadTriggerFire['outcome']): Look {
    switch (outcome) {
        case 'started':
            return { label: m.trigger_fire_started(), tone: 'success' };
        case 'skipped':
            return { label: m.trigger_fire_skipped(), tone: 'neutral' };
        case 'failed':
            return { label: m.trigger_fire_failed(), tone: 'danger' };
        case 'unknown':
            return { label: m.trigger_value_unknown(), tone: 'neutral' };
    }
}

export function FireOutcomePill({ outcome }: { readonly outcome: ReadTriggerFire['outcome'] }) {
    const look = outcomeLook(outcome);
    return <StatusPill tone={look.tone}>{look.label}</StatusPill>;
}

/** Why an ended trigger ended; `null` while it has not. */
export function endedReasonLabel(reason: ReadTrigger['endedReason']): string | null {
    switch (reason) {
        case null:
            return null;
        case 'completed':
            return m.trigger_ended_completed();
        case 'cancelled':
            return m.trigger_ended_cancelled();
        case 'max-runs':
            return m.trigger_ended_max_runs();
        case 'unknown':
            return m.trigger_value_unknown();
    }
}
