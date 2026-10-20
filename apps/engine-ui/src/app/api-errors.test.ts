import { createProblem, EngineApiContractError } from '@ptbk/engine-api';
import { describe, expect, it } from 'vitest';

import { classifyApiError, EngineApiProblemError, isUnauthenticated, shouldRetryQuery, unwrap } from './api-errors';

const problemError = (code: Parameters<typeof createProblem>[0]) => new EngineApiProblemError(createProblem(code));
const domError = (name: string) => new DOMException('failed', name);

describe('unwrap', () => {
    it('returns the data of an ok response', () => {
        expect(unwrap({ kind: 'ok', data: 42 })).toBe(42);
    });

    it('throws a problem as EngineApiProblemError, naming only the code', () => {
        const problem = createProblem('not-found', { detail: 'agent ada' });
        const error = (() => {
            try {
                unwrap({ kind: 'problem', problem });
            } catch (caught) {
                return caught;
            }
            return undefined;
        })();
        expect(error).toBeInstanceOf(EngineApiProblemError);
        expect((error as EngineApiProblemError).problem).toBe(problem);
        expect((error as Error).message).toBe('Engine API problem: not-found');
    });
});

describe('classifyApiError', () => {
    it.each([
        [problemError('forbidden'), 'problem'],
        [new EngineApiContractError('getEngine', 'bad'), 'contract'],
        [new TypeError('Failed to fetch'), 'network'],
        [domError('TimeoutError'), 'timeout'],
        [domError('AbortError'), 'aborted'],
        [new Error('boom'), 'unexpected'],
        ['a string', 'unexpected'],
        [null, 'unexpected'],
    ])('classifies %s as %s', (error, kind) => {
        expect(classifyApiError(error).kind).toBe(kind);
    });
});

describe('isUnauthenticated', () => {
    it('is true only for the unauthenticated problem', () => {
        expect(isUnauthenticated(problemError('unauthenticated'))).toBe(true);
        expect(isUnauthenticated(problemError('step-up-required'))).toBe(false);
        expect(isUnauthenticated(problemError('forbidden'))).toBe(false);
        expect(isUnauthenticated(new TypeError('Failed to fetch'))).toBe(false);
    });
});

describe('shouldRetryQuery', () => {
    it.each([
        [problemError('internal-error'), true],
        [problemError('unavailable'), true],
        [problemError('reply-failed'), true],
        [new TypeError('Failed to fetch'), true],
        [domError('TimeoutError'), true],
        [problemError('validation-failed'), false],
        [problemError('unauthenticated'), false],
        [problemError('not-found'), false],
        [problemError('rate-limited'), false],
        [new EngineApiContractError('getEngine', 'bad'), false],
        [domError('AbortError'), false],
        [new Error('bug'), false],
    ])('retries %s: %s', (error, expected) => {
        expect(shouldRetryQuery(0, error)).toBe(expected);
    });

    it('retries at most twice', () => {
        const error = problemError('unavailable');
        expect(shouldRetryQuery(1, error)).toBe(true);
        expect(shouldRetryQuery(2, error)).toBe(false);
    });
});
