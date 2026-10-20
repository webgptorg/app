import { STEP_UP_PATH } from '@ptbk/engine-api';
import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { useStepUp } from './step-up';
import { stepUpUrl } from './step-up-url';

describe('step-up', () => {
    it('returns to the current page after the gateway check', () => {
        const location = { origin: 'https://e.test', pathname: '/settings', search: '?tab=1', hash: '#x' };
        expect(stepUpUrl(location)).toBe(`${STEP_UP_PATH}?returnTo=%2Fsettings%3Ftab%3D1%23x`);
    });

    it('never returns to another origin', () => {
        const location = { origin: 'https://e.test', pathname: '//evil.test/x', search: '', hash: '' };
        expect(stepUpUrl(location)).toBe(`${STEP_UP_PATH}?returnTo=%2F`);
    });

    it('needs its provider', () => {
        expect(() => renderHook(() => useStepUp())).toThrow(/StepUpProvider/);
    });
});
