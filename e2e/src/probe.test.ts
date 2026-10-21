import { describe, expect, it } from 'vitest';

import { parseProbeArgs } from './probe.ts';

const noFiles = (): string => {
    throw new Error('no file expected');
};

describe('parseProbeArgs', () => {
    it('reads the addresses, the SNI and the CA', () => {
        expect(
            parseProbeArgs(
                [
                    '--ca',
                    '/pki/ca.pem',
                    '--servername',
                    'relay-a.ptbk.test',
                    '--path',
                    '/healthz',
                    '--address',
                    '127.0.0.1',
                ],
                noFiles,
            ),
        ).toEqual({
            addresses: ['127.0.0.1'],
            port: 443,
            servername: 'relay-a.ptbk.test',
            path: '/healthz',
            caFile: '/pki/ca.pem',
            caUrl: null,
            timeoutMs: 2000,
        });
    });

    it("takes the SNI from a JSON file's hostname field", () => {
        const options = parseProbeArgs(
            ['--ca', 'ca.pem', '--servername-from', 'engine.json', '--address', '10.0.0.1', '--address', '10.0.0.2'],
            (path) => (path === 'engine.json' ? '{"hostname":"x.engine.test"}' : ''),
        );
        expect(options.servername).toBe('x.engine.test');
        expect(options.addresses).toEqual(['10.0.0.1', '10.0.0.2']);
    });

    it('takes the roots from a URL with --ca-from, verifying that fetch with --ca', () => {
        const options = parseProbeArgs(
            ['--ca', 'minica.pem', '--ca-from', 'https://pebble:15000/roots/0', '--servername', 'a', '--address', '1'],
            noFiles,
        );
        expect(options).toMatchObject({ caFile: 'minica.pem', caUrl: 'https://pebble:15000/roots/0' });
        expect(() =>
            parseProbeArgs(
                ['--ca', 'c', '--ca-from', 'http://pebble/roots/0', '--servername', 'a', '--address', '1'],
                noFiles,
            ),
        ).toThrow('--ca-from');
    });

    it('refuses incomplete or contradictory arguments', () => {
        expect(() => parseProbeArgs(['--ca', 'ca.pem', '--servername', 'a.test'], noFiles)).toThrow('--address');
        expect(() => parseProbeArgs(['--servername', 'a.test', '--address', '1.1.1.1'], noFiles)).toThrow('--ca');
        expect(() => parseProbeArgs(['--ca', 'c', '--address', '1.1.1.1'], noFiles)).toThrow('exactly one');
        expect(() =>
            parseProbeArgs(['--ca', 'c', '--servername', 'a', '--servername-from', 'f', '--address', '1'], noFiles),
        ).toThrow('exactly one');
        expect(() =>
            parseProbeArgs(['--ca', 'c', '--servername', 'a', '--address', '1', '--port', '0'], noFiles),
        ).toThrow('--port');
        expect(() =>
            parseProbeArgs(['--ca', 'c', '--servername', 'a', '--address', '1', '--bogus'], noFiles),
        ).toThrow();
        expect(() =>
            parseProbeArgs(['--ca', 'c', '--servername-from', 'f', '--address', '1'], () => '{"host":"a"}'),
        ).toThrow('no hostname field');
    });
});
