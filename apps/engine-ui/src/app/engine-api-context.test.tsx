import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { createTestEngineApi } from '../test/test-engine-api';
import { EngineApiProvider, useEngineApi } from './engine-api-context';

describe('useEngineApi', () => {
    it('returns the injected client', () => {
        const client = createTestEngineApi();
        const { result } = renderHook(useEngineApi, {
            wrapper: ({ children }) => <EngineApiProvider client={client}>{children}</EngineApiProvider>,
        });
        expect(result.current).toBe(client);
    });

    it('fails loudly outside a provider', () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        expect(() => renderHook(useEngineApi)).toThrow(/EngineApiProvider/);
    });
});
