import type { EngineView } from '../../../shared/api/routes';

/** What needs the owner first: an outage, then a setup to finish, then the working ones; finished ones last. */
const ATTENTION: Readonly<Record<EngineView['status'], number>> = {
    offline: 0,
    unknown: 1,
    'owner-pending': 2,
    online: 3,
    'never-seen': 4,
    suspended: 5,
};

/** Revoked by its owner: it can never come back, so the list keeps it out of the way. */
export function isRevoked(engine: Pick<EngineView, 'suspendedBy'>): boolean {
    return engine.suspendedBy === 'owner';
}

/** Whether the numbers an engine last reported still describe it; otherwise they are history, shown as such. */
export function reportsLive(engine: Pick<EngineView, 'status'>): boolean {
    return engine.status === 'online' || engine.status === 'owner-pending';
}

/** By attention, then in the API's order (oldest first); a stable sort keeps that order within each status. */
export function byAttention(engines: readonly EngineView[]): readonly EngineView[] {
    return [...engines].sort((a, b) => ATTENTION[a.status] - ATTENTION[b.status]);
}
