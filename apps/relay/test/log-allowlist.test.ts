import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { LOG_EVENTS } from '../src/domain/log-events';

const SRC = join(import.meta.dirname, '../src');

/** Field names that could carry a browser's address, a ClientHello's SNI, a hostname, a secret or content. */
const FORBIDDEN_FIELD =
    /browser|client|remote|address|^ip$|sni|server.?name|host|domain|token|key|secret|cookie|header|body|payload|nonce|signature|email|account|org|user/i;

function sourceFiles(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) return entry.name === 'testing' ? [] : sourceFiles(path);
        return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
    });
}

describe('relay log events (spec, Metadata we still see)', () => {
    const events = Object.entries(LOG_EVENTS) as [string, readonly string[]][];

    it('give every event a fixed field allowlist without a browser IP, SNI, hostname, secret or content field', () => {
        for (const [event, fields] of events) {
            expect(new Set(fields).size, event).toBe(fields.length);
            for (const field of fields) expect(field, `${event}.${field}`).not.toMatch(FORBIDDEN_FIELD);
        }
    });

    it('log the engine IP only on tunnel events, which journald keeps 7 days', () => {
        const withIp = events.filter(([, fields]) => fields.includes('engineIp')).map(([event]) => event);
        expect(withIp.sort()).toEqual(['tunnel.connected', 'tunnel.disconnected', 'tunnel.rejected']);
    });

    it('are all logged somewhere, and nothing logs an event outside the list', () => {
        const source = sourceFiles(SRC)
            .map((path) => readFileSync(path, 'utf8'))
            .join('\n');
        const logged = new Set(
            [...source.matchAll(/(?:logger|Logger)\.(?:info|warn|error)\(\s*'([^']+)'/g)].map((match) => match[1]),
        );
        logged.add('relay.crashed');
        expect([...logged].sort()).toEqual(Object.keys(LOG_EVENTS).sort());
    });
});
