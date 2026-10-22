import { Hostname } from '@ptbk/protocol';
import { describe, expect, it } from 'vitest';

import { TEST_ENGINE_DOMAIN } from '../../testing/test-engine';
import { isUnderAny, normaliseCustomHostname, PLATFORM_DOMAIN } from './normalise-hostname';

const label63 = 'a'.repeat(63);
/** Four labels of 63 plus three dots is 255; trimming gives exact lengths. */
function nameOfLength(length: number): string {
    return `${label63}.${label63}.${label63}.${label63}`.slice(-length).replace(/^\./, 'b');
}

describe('normaliseCustomHostname', () => {
    it('lowercases', () => {
        expect(normaliseCustomHostname('Agents.Customer.EXAMPLE')).toBe('agents.customer.example');
    });

    it('drops one trailing dot, not two', () => {
        expect(normaliseCustomHostname('agents.customer.example.')).toBe('agents.customer.example');
        expect(normaliseCustomHostname('agents.customer.example..')).toBeNull();
    });

    it('turns a Unicode IDN into A-labels, uppercase included', () => {
        expect(normaliseCustomHostname('Bücher.Example')).toBe('xn--bcher-kva.example');
        expect(normaliseCustomHostname('agenti.příklad.cz.')).toBe('agenti.xn--pklad-zsa96e.cz');
        expect(normaliseCustomHostname('xn--bcher-kva.example')).toBe('xn--bcher-kva.example');
    });

    it('refuses Unicode that is not a hostname, before or in the URL parser', () => {
        expect(normaliseCustomHostname('bücher.example/path')).toBeNull();
        expect(normaliseCustomHostname('user@bücher.example')).toBeNull();
        expect(normaliseCustomHostname('bücher.example:443')).toBeNull();
        expect(normaliseCustomHostname('xn--ü.example')).toBeNull();
        expect(normaliseCustomHostname('bücher')).toBeNull();
    });

    it.each(['192.0.2.1', '192.0.2.1.', '0x7f.1', 'example.123', '[2001:db8::1]', '2001:db8::1'])(
        'refuses the IP literal %s',
        (input) => {
            expect(normaliseCustomHostname(input)).toBeNull();
        },
    );

    it.each(['*.example.com', '*', 'a*.example.com'])('refuses the wildcard %s', (input) => {
        expect(normaliseCustomHostname(input)).toBeNull();
    });

    it('takes 253 characters and refuses 254', () => {
        expect(normaliseCustomHostname(nameOfLength(253))).toHaveLength(253);
        expect(normaliseCustomHostname(nameOfLength(254))).toBeNull();
        expect(normaliseCustomHostname(`${nameOfLength(253)}.`)).toHaveLength(253);
    });

    it('refuses single labels, empty labels, spaces and oversized input without parsing it', () => {
        expect(normaliseCustomHostname('localhost')).toBeNull();
        expect(normaliseCustomHostname('a..example')).toBeNull();
        expect(normaliseCustomHostname('agents customer.example')).toBeNull();
        expect(normaliseCustomHostname('')).toBeNull();
        expect(normaliseCustomHostname('ü'.repeat(1025))).toBeNull();
    });
});

describe('isUnderAny', () => {
    const reserved = [PLATFORM_DOMAIN, TEST_ENGINE_DOMAIN];

    it('matches a reserved domain itself and every name under it', () => {
        expect(isUnderAny(Hostname.parse('ptbk.io'), reserved)).toBe(true);
        expect(isUnderAny(Hostname.parse('app.ptbk.io'), reserved)).toBe(true);
        expect(isUnderAny(Hostname.parse(`agents.${TEST_ENGINE_DOMAIN}`), reserved)).toBe(true);
        expect(isUnderAny(Hostname.parse(`a.b.${TEST_ENGINE_DOMAIN}`), reserved)).toBe(true);
    });

    it('does not match a name that only ends in the same characters', () => {
        expect(isUnderAny(Hostname.parse('notptbk.io'), reserved)).toBe(false);
        expect(isUnderAny(Hostname.parse('agents.customer.example'), reserved)).toBe(false);
    });
});
