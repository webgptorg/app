/** What a violation report keeps: where and what was blocked, never the sample of the offending code. */
export interface CspViolation {
    readonly directive: string;
    readonly blockedUri: string;
    readonly sourceFile: string;
    readonly line: number;
    readonly column: number;
}

declare global {
    interface Window {
        /** Defined by the test harness (Vitest, `test:csp`) before the bundle loads; absent in production. */
        __ptbkCspViolations?: CspViolation[];
    }
}

export type CspViolationSink = (violation: CspViolation) => void;

export interface CspViolationSinkOptions {
    readonly dev: boolean;
    readonly scope: Pick<Window, '__ptbkCspViolations'>;
    readonly logError: (message: string, violation: CspViolation) => void;
}

/**
 * Dev logs loudly, because the dev server sends no CSP and the engine would block what triggered it. Tests record into
 * `__ptbkCspViolations` so they fail. Production does neither: nothing is collected and nothing leaves the page.
 */
export function createCspViolationSink(options: CspViolationSinkOptions): CspViolationSink {
    return (violation) => {
        if (options.dev) {
            options.logError('CSP violation: the engine will block this', violation);
        }
        options.scope.__ptbkCspViolations?.push(violation);
    };
}

export function installCspViolationListener(
    target: Pick<Document, 'addEventListener' | 'removeEventListener'>,
    sink: CspViolationSink,
): () => void {
    const listener = (event: SecurityPolicyViolationEvent): void => {
        sink({
            directive: event.effectiveDirective,
            blockedUri: event.blockedURI,
            sourceFile: event.sourceFile,
            line: event.lineNumber,
            column: event.columnNumber,
        });
    };
    target.addEventListener('securitypolicyviolation', listener);
    return () => {
        target.removeEventListener('securitypolicyviolation', listener);
    };
}
