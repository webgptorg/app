/**
 * Access-ticket IDs the join page has spent (teams spec: engines MUST keep them durably until the ticket expires), so a
 * ticket makes one request even across a restart. Calls are serialised: of two racing spends of one ID, one wins.
 */
export interface SpentTicketStore {
    /** Whether `ticketId` was spent and is still kept at `nowMs`. */
    has(ticketId: string, nowMs: number): Promise<boolean>;
    /**
     * Spends `ticketId` until `untilMs`, durably before it resolves; `spent` if it already was. `full` when the store
     * keeps its maximum of unexpired IDs, which a legitimate dashboard does not reach.
     */
    spend(ticketId: string, untilMs: number, nowMs: number): Promise<'ok' | 'spent' | 'full'>;
}

/** Most unexpired IDs kept: tickets live 15 minutes and the join endpoints are rate-limited per IP. */
export const MAX_SPENT_TICKETS = 1_000;

/** The decision both stores share, on a map of ID to the time it may be forgotten. */
export function spendIn(
    tickets: Map<string, number>,
    ticketId: string,
    untilMs: number,
    nowMs: number,
): 'ok' | 'spent' | 'full' {
    for (const [id, until] of tickets) if (until <= nowMs) tickets.delete(id);
    if (tickets.has(ticketId)) return 'spent';
    if (tickets.size >= MAX_SPENT_TICKETS) return 'full';
    tickets.set(ticketId, untilMs);
    return 'ok';
}

/** For tests and engines started without a data directory: a restart forgets every spent ticket. */
export function createInMemorySpentTickets(): SpentTicketStore {
    const tickets = new Map<string, number>();
    return {
        has: (ticketId, nowMs) => Promise.resolve((tickets.get(ticketId) ?? 0) > nowMs),
        spend: (ticketId, untilMs, nowMs) => Promise.resolve(spendIn(tickets, ticketId, untilMs, nowMs)),
    };
}
