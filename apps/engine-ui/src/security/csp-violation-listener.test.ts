import { describe, expect, it, vi } from 'vitest';

import { createCspViolationSink, installCspViolationListener } from './csp-violation-listener';
import type { CspViolation } from './csp-violation-listener';

const violation: CspViolation = {
    directive: 'style-src-elem',
    blockedUri: 'inline',
    sourceFile: 'https://engine.example/agents',
    line: 3,
    column: 7,
};

function violationEvent(): Event {
    return Object.assign(new Event('securitypolicyviolation'), {
        effectiveDirective: violation.directive,
        blockedURI: violation.blockedUri,
        sourceFile: violation.sourceFile,
        lineNumber: violation.line,
        columnNumber: violation.column,
        sample: 'body { color: red }',
    });
}

describe('installCspViolationListener', () => {
    it('passes each violation to the sink without its code sample, until removed', () => {
        const sink = vi.fn();
        const remove = installCspViolationListener(document, sink);

        document.dispatchEvent(violationEvent());
        remove();
        document.dispatchEvent(violationEvent());

        expect(sink).toHaveBeenCalledExactlyOnceWith(violation);
    });
});

describe('createCspViolationSink', () => {
    it('records into the harness array in tests', () => {
        const scope = { __ptbkCspViolations: [] as CspViolation[] };
        const logError = vi.fn();

        createCspViolationSink({ dev: false, scope, logError })(violation);

        expect(scope.__ptbkCspViolations).toEqual([violation]);
        expect(logError).not.toHaveBeenCalled();
    });

    it('logs loudly in dev', () => {
        const logError = vi.fn();

        createCspViolationSink({ dev: true, scope: {}, logError })(violation);

        expect(logError).toHaveBeenCalledWith(expect.stringContaining('CSP violation'), violation);
    });

    it('keeps nothing in production, where no harness defined the array', () => {
        const scope: { __ptbkCspViolations?: CspViolation[] } = {};
        const logError = vi.fn();

        createCspViolationSink({ dev: false, scope, logError })(violation);

        expect(scope).toEqual({});
        expect(logError).not.toHaveBeenCalled();
    });
});
