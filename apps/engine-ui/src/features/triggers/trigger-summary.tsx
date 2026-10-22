import type { ReadTrigger } from '@ptbk/engine-api';

import { useAppLocale } from '../../app/locale';
import { m } from '../../paraglide/messages';
import { describeRecurrence } from './schedule/describe';
import { useBrowserTimeZone } from './trigger-time';

/** The schedule in words, an email trigger's address, or what little a newer engine's kind tells. */
export function useTriggerSummary(): (trigger: ReadTrigger) => string {
    const { locale } = useAppLocale();
    const displayTimeZone = useBrowserTimeZone();
    return (trigger) => {
        switch (trigger.kind) {
            case 'email':
                return trigger.config.address;
            case 'schedule':
                return describeRecurrence(trigger.config.recurrence, { locale, displayTimeZone });
            case 'webhook':
                return trigger.config.path;
            case 'unknown':
                return m.trigger_value_none();
        }
    };
}

/** The zone a trigger's times are planned in, when it names one (a cron schedule). */
export function triggerZone(trigger: ReadTrigger): string | undefined {
    return trigger.kind === 'schedule' && trigger.config.recurrence.kind === 'cron'
        ? trigger.config.recurrence.timeZone
        : undefined;
}
