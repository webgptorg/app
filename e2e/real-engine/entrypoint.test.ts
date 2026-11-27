import { describe, expect, it } from 'vitest';

import { parseOnboardingRecord } from './entrypoint.ts';

describe('parseOnboardingRecord', () => {
    it('reads the step and, once set up, the project folder', () => {
        expect(parseOnboardingRecord('{"version":1,"engineId":"abc","step":"intent"}', 'abc')).toEqual({
            step: 'intent',
            folder: null,
        });
        expect(parseOnboardingRecord('{"engineId":"abc","step":"done","folder":"my-agenda"}', 'abc')).toEqual({
            step: 'done',
            folder: 'my-agenda',
        });
    });

    it('ignores a record of another directory, a malformed one or none', () => {
        expect(parseOnboardingRecord('{"engineId":"other","step":"done"}', 'abc')).toBeNull();
        expect(parseOnboardingRecord('{"engineId":"abc"}', 'abc')).toBeNull();
        expect(parseOnboardingRecord('not json', 'abc')).toBeNull();
        expect(parseOnboardingRecord('null', 'abc')).toBeNull();
    });
});
