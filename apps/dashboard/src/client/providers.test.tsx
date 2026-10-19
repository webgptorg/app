import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { useApiClient } from './api/api-client-context';
import { useLocale } from './i18n/locale';

describe('client providers', () => {
    it('fail loudly when a hook is used outside its provider', () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        expect(() => renderHook(() => useApiClient())).toThrow(/ApiClientProvider/);
        expect(() => renderHook(() => useLocale())).toThrow(/LocaleProvider/);
        vi.restoreAllMocks();
    });

    it('turn off zod’s eval probe before any schema exists', async () => {
        await import('./zod-jitless');
        expect(z.config().jitless).toBe(true);
    });
});
