import { describe, expect, it } from 'vitest';

import { certificateNameCovers, isWithinDomain } from './engine-domain';

describe('isWithinDomain', () => {
    it.each([
        ['engine.test', true],
        ['abc.engine.test', true],
        ['a.b.engine.test', true],
        ['xengine.test', false],
        ['engine.test.example', false],
        ['test', false],
    ])('%s within engine.test: %s', (name, within) => {
        expect(isWithinDomain(name, 'engine.test')).toBe(within);
    });
});

describe('certificateNameCovers', () => {
    it.each([
        ['engine.test', true],
        ['ENGINE.test.', true],
        ['abc.engine.test', true],
        ['*.engine.test', true],
        ['*.test', true],
        ['e*.test', true],
        ['*', true],
        ['relay-a.ptbk.test', false],
        ['*.ptbk.test', false],
        ['*.example', false],
        ['*.sub.engine2.test', false],
        ['localhost', false],
        ['test', false],
    ])('%s covers engine.test or a name under it: %s', (name, covers) => {
        expect(certificateNameCovers(name, 'engine.test')).toBe(covers);
    });

    it('does not let a wildcard reach more than one label down', () => {
        expect(certificateNameCovers('*.test', 'engine.zone.test')).toBe(false);
        expect(certificateNameCovers('*.zone.test', 'engine.zone.test')).toBe(true);
    });
});
