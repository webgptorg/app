import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useSession } from './use-session';

describe('useSession', () => {
    it('fails loudly outside the signed-in shell', () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        expect(() => renderHook(() => useSession())).toThrow(/signed-in shell/);
        vi.restoreAllMocks();
    });
});
