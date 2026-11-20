import type { EngineDay } from '../domain/usage/engine-activity';
import { dayStartMs, nextDay } from '../domain/usage/usage-day';
import type { UsageEventRow } from '../domain/usage/usage-event';
import type { ActiveEngine, UsageStore } from '../domain/usage/usage-store';

export interface MemoryUsageState {
    readonly events: UsageEventRow[];
    /** By `day|engineId`. */
    readonly engineDays: Map<string, EngineDay & ActiveEngine>;
    /** `day|orgId|userId`. */
    readonly people: Set<string>;
}

export interface MemoryUsageStore extends UsageStore {
    readonly state: MemoryUsageState;
}

interface SessionSource {
    readonly userId: string;
    readonly activeOrgId: string;
    readonly lastSeenAt: number;
}

/** The D1 store's rules over arrays; engines and sessions are read from whatever state the test keeps them in. */
export function createMemoryUsageStore(
    sources: {
        readonly engines?: () => readonly ActiveEngine[];
        readonly sessions?: () => Iterable<SessionSource>;
    } = {},
): MemoryUsageStore {
    const state: MemoryUsageState = { events: [], engineDays: new Map(), people: new Set() };
    return {
        state,
        insertEvents(rows) {
            for (const row of rows) {
                if (!state.events.some((event) => event.id === row.id)) {
                    state.events.push({ ...row });
                }
            }
            return Promise.resolve();
        },
        listActiveEngines: () => Promise.resolve([...(sources.engines?.() ?? [])]),
        upsertEngineDays(rows) {
            for (const row of rows) {
                state.engineDays.set(`${row.day}|${row.engineId}`, { ...row });
            }
            return Promise.resolve();
        },
        rollUpPeople(day) {
            const from = dayStartMs(day);
            const to = dayStartMs(nextDay(day));
            for (const session of sources.sessions?.() ?? []) {
                if (session.lastSeenAt >= from && session.lastSeenAt < to) {
                    state.people.add(`${day}|${session.activeOrgId}|${session.userId}`);
                }
            }
            return Promise.resolve();
        },
        prune({ eventsBefore, daysBefore }) {
            state.events.splice(
                0,
                state.events.length,
                ...state.events.filter((event) => event.occurredAt >= eventsBefore),
            );
            for (const [key, row] of state.engineDays) {
                if (row.day < daysBefore) {
                    state.engineDays.delete(key);
                }
            }
            for (const key of state.people) {
                if ((key.split('|')[0] ?? '') < daysBefore) {
                    state.people.delete(key);
                }
            }
            return Promise.resolve();
        },
    };
}
