import { describe, expect, it } from 'vitest';

import {
    ConformanceSessionUsageError,
    parseConformanceSessionCommand,
    runConformanceSessionCommand,
} from './conformance-session-command';

describe('parseConformanceSessionCommand', () => {
    it('reads the owner and member subjects the harness asks for', () => {
        expect(parseConformanceSessionCommand(['--subject', 'owner'])).toEqual({ kind: 'owner' });
        expect(
            parseConformanceSessionCommand(['--subject', 'member', '--permissions', 'agents.read,chats.read']),
        ).toEqual({
            kind: 'member',
            permissions: ['agents.read', 'chats.read'],
        });
        expect(parseConformanceSessionCommand(['--subject', 'member', '--permissions', ''])).toEqual({
            kind: 'member',
            permissions: [],
        });
    });

    it.each([
        [[]],
        [['--subject', 'admin']],
        [['--subject', 'owner', '--permissions', 'x']],
        [['--subject', 'member']],
    ])('refuses %j', (args) => {
        expect(() => parseConformanceSessionCommand(args)).toThrow(ConformanceSessionUsageError);
    });

    it('refuses an unknown permission', () => {
        expect(() => parseConformanceSessionCommand(['--subject', 'member', '--permissions', 'root'])).toThrow(
            'unknown permission',
        );
    });
});

describe('runConformanceSessionCommand', () => {
    it('signs in through the control listener and prints the cookie', async () => {
        const requests: Request[] = [];
        const fetch: typeof globalThis.fetch = (input, init) => {
            requests.push(new Request(input, init));
            return Promise.resolve(
                Response.json({ memberId: 'm', cookie: { name: 'c', value: 'v' } }, { status: 201 }),
            );
        };
        const credential = await runConformanceSessionCommand(
            { kind: 'owner' },
            { control: { host: '::1', port: 4480 } },
            fetch,
        );
        expect(credential).toEqual({ cookie: 'c=v' });
        expect(requests[0]?.url).toBe('http://[::1]:4480/__mock/sessions');
        expect(await requests[0]?.json()).toEqual({ subject: { kind: 'owner' } });
    });

    it('needs the dev-only control listener, and reports its refusals', async () => {
        const never: typeof globalThis.fetch = () => Promise.reject(new Error('no call expected'));
        await expect(runConformanceSessionCommand({ kind: 'owner' }, { control: null }, never)).rejects.toThrow(
            'needs MOCK_CONTROL=enabled',
        );
        const refusing: typeof globalThis.fetch = () => Promise.resolve(new Response('no', { status: 429 }));
        await expect(
            runConformanceSessionCommand({ kind: 'owner' }, { control: { host: '127.0.0.1', port: 1 } }, refusing),
        ).rejects.toThrow('answered 429');
    });
});
