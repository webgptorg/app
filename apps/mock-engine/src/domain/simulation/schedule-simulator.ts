import type { InMemoryEngineController } from '@ptbk/engine-api/in-memory';

import type { Clock } from '../clock';

export interface ScheduleSimulatorDeps {
    readonly controller: InMemoryEngineController;
    readonly clock: Clock;
    readonly onError: (error: unknown) => void;
}

export interface ScheduleSimulator {
    /** Looks at the schedules again, e.g. after one was created, paused, resumed or changed. */
    refresh(): void;
    stop(): void;
}

/**
 * Fires each active schedule at its `nextFireAt` through the core's `fireTrigger`, which decides everything else:
 * the run, the fire record, the next fire and the end of the schedule. Paused and ended triggers have no next fire,
 * so they never come due.
 */
export function createScheduleSimulator(deps: ScheduleSimulatorDeps): ScheduleSimulator {
    const { controller, clock } = deps;
    let cancel: (() => void) | null = null;
    let firing = false;
    let stopped = false;
    /** The fire each schedule was last fired for; one whose next fire does not move never fires twice for it. */
    const attempted = new Map<string, number>();

    function due(): readonly { readonly id: string; readonly atMs: number }[] {
        return controller
            .findTriggers({ kind: 'schedule', lifecycle: 'active' })
            .flatMap((trigger) => {
                const atMs = trigger.nextFireAt === null ? null : Date.parse(trigger.nextFireAt);
                return atMs === null || attempted.get(trigger.id) === atMs ? [] : [{ id: trigger.id, atMs }];
            })
            .sort((a, b) => a.atMs - b.atMs || a.id.localeCompare(b.id));
    }

    function wake(): void {
        cancel = null;
        firing = true;
        try {
            for (let next = due()[0]; next !== undefined && next.atMs <= clock.nowMs(); next = due()[0]) {
                attempted.set(next.id, next.atMs);
                controller.fireTrigger(next.id);
            }
        } catch (error) {
            deps.onError(error);
        } finally {
            firing = false;
        }
        refresh();
    }

    function refresh(): void {
        if (stopped || firing) return;
        cancel?.();
        cancel = null;
        const next = due()[0];
        if (next !== undefined) cancel = clock.setTimeout(wake, Math.max(0, next.atMs - clock.nowMs()));
    }

    return {
        refresh,
        stop() {
            stopped = true;
            cancel?.();
            cancel = null;
        },
    };
}
