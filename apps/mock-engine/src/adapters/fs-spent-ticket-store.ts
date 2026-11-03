import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';

import type { SpentTicketStore } from '../domain/gateway/spent-tickets';
import { MAX_SPENT_TICKETS, spendIn } from '../domain/gateway/spent-tickets';
import { currentUid, lstatOrNull, privacyProblem, replacePrivateFile } from './private-files';

export const SPENT_TICKETS_FILE = 'spent-tickets.json';

const MAX_FILE_BYTES = 128 * 1024;
const SpentTicketsFile = z.strictObject({
    v: z.literal(1),
    tickets: z
        .array(z.strictObject({ id: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/), until: z.int().min(0) }))
        .max(MAX_SPENT_TICKETS),
});

/** A spent-tickets file that cannot be trusted or read. Messages name the path, never its content. */
export class SpentTicketStoreError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SpentTicketStoreError';
    }
}

/**
 * `<dataDir>/spent-tickets.json`, mode 0600, replaced atomically (temporary file, `fsync`, rename) before `spend`
 * resolves, so a ticket that made a request is still refused after a crash or restart. Expired IDs are dropped on each
 * write.
 */
export function createFsSpentTicketStore(
    dataDir: string,
    options: { readonly uid?: number | null } = {},
): SpentTicketStore {
    const uid = options.uid === undefined ? currentUid() : options.uid;
    const path = join(dataDir, SPENT_TICKETS_FILE);
    let tickets: Map<string, number> | null = null;

    async function load(): Promise<Map<string, number>> {
        if (tickets !== null) return tickets;
        const stats = await lstatOrNull(path);
        if (stats === null) return (tickets = new Map());
        const problem = privacyProblem(stats, { label: SPENT_TICKETS_FILE, path, kind: 'file' }, uid);
        if (problem !== null) throw new SpentTicketStoreError(problem);
        if (stats.size > MAX_FILE_BYTES) throw new SpentTicketStoreError(`${SPENT_TICKETS_FILE} ${path} is too large`);
        let json: unknown;
        try {
            json = JSON.parse(await readFile(path, 'utf8'));
        } catch {
            json = undefined;
        }
        const parsed = SpentTicketsFile.safeParse(json);
        if (!parsed.success) {
            throw new SpentTicketStoreError(`${SPENT_TICKETS_FILE} ${path} is not a spent-ticket list`);
        }
        return (tickets = new Map(parsed.data.tickets.map(({ id, until }) => [id, until])));
    }

    let queue: Promise<unknown> = Promise.resolve();
    const serially = <T>(task: () => Promise<T>): Promise<T> => {
        const result = queue.then(task, task);
        queue = result.catch(() => undefined);
        return result;
    };

    return {
        has: (ticketId, nowMs) => serially(async () => ((await load()).get(ticketId) ?? 0) > nowMs),
        spend: (ticketId, untilMs, nowMs) =>
            serially(async () => {
                // Decided on a copy: a failed write must not leave the ID spent in memory but not on disk.
                const next = new Map(await load());
                const outcome = spendIn(next, ticketId, untilMs, nowMs);
                if (outcome !== 'ok') return outcome;
                const file = { v: 1, tickets: [...next].map(([id, until]) => ({ id, until })) };
                await replacePrivateFile(path, `${JSON.stringify(SpentTicketsFile.parse(file))}\n`);
                tickets = next;
                return outcome;
            }),
    };
}
