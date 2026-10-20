import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { expectedCnameTarget } from './custom-hostname';
import { defaultHostname } from './engine-id';
import { EngineId, Hostname } from './ids';

const engineIds = fc.stringMatching(/^[a-z2-7]{26}$/).map((value) => EngineId.parse(value));
const engineDomains = fc
    .array(fc.stringMatching(/^[a-z](?:[a-z0-9-]{0,20}[a-z0-9])?$/), { minLength: 1, maxLength: 4 })
    .map((labels) => Hostname.parse([...labels, 'example'].join('.')));

describe('expectedCnameTarget', () => {
    it('is the default hostname', () => {
        const engineId = EngineId.parse('eh7ddx5bksrgcytl7bkai36se4');
        const domain = Hostname.parse('engines.example');
        expect(expectedCnameTarget(engineId, domain)).toBe('eh7ddx5bksrgcytl7bkai36se4.engines.example');
    });

    it('equals defaultHostname for the same inputs and always parses as a Hostname', () => {
        fc.assert(
            fc.property(engineIds, engineDomains, (engineId, domain) => {
                const target = expectedCnameTarget(engineId, domain);
                expect(target).toBe(defaultHostname(engineId, domain));
                expect(Hostname.parse(target)).toBe(target);
            }),
        );
    });
});
