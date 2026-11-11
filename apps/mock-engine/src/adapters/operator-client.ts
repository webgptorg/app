import { request } from 'node:http';

import type { z } from 'zod';

import { LinkAnswer, OperatorStatus, ResetAnswer, SetupLinkAnswer } from '../domain/onboarding/operator-api';
import { OPERATOR_PATHS, OperatorSocketError, operatorSocketPath, socketDirProblem } from './operator-socket';

const TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

/** The running engine, as the operator's commands reach it; `null` from a call means no engine answered. */
export interface OperatorClient {
    status(): Promise<OperatorStatus | null>;
    /** `showsSetupLink`: this command shows the first setup link, so the engine issues none of its own. */
    link(showsSetupLink: boolean): Promise<LinkAnswer | null>;
    setupLink(): Promise<SetupLinkAnswer | null>;
    resetOwner(): Promise<ResetAnswer | null>;
}

/** The engine answered with something this build does not understand: a bug, never a secret to print. */
export class OperatorAnswerError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'OperatorAnswerError';
    }
}

const NOT_RUNNING: ReadonlySet<string> = new Set(['ENOENT', 'ECONNREFUSED']);

function call<S extends z.ZodType>(socketPath: string, method: 'GET' | 'POST', path: string, schema: S) {
    return new Promise<z.output<S> | null>((resolve, reject) => {
        const outgoing = request({ socketPath, path, method, timeout: TIMEOUT_MS }, (response) => {
            const chunks: Buffer[] = [];
            let size = 0;
            response.on('data', (chunk: Buffer) => {
                size += chunk.byteLength;
                if (size > MAX_RESPONSE_BYTES) {
                    response.destroy();
                    reject(new OperatorAnswerError(`the engine's answer to ${path} is too large`));
                    return;
                }
                chunks.push(chunk);
            });
            response.on('end', () => {
                if (response.statusCode !== 200) {
                    reject(new OperatorAnswerError(`the engine answered ${path} with ${String(response.statusCode)}`));
                    return;
                }
                let json: unknown;
                try {
                    json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                } catch {
                    reject(new OperatorAnswerError(`the engine's answer to ${path} is not JSON`));
                    return;
                }
                const parsed = schema.safeParse(json);
                if (parsed.success) resolve(parsed.data);
                else reject(new OperatorAnswerError(`the engine's answer to ${path} does not match this build`));
            });
        });
        outgoing.on('timeout', () => {
            outgoing.destroy(new OperatorAnswerError(`the engine did not answer ${path} in time`));
        });
        outgoing.on('error', (error: NodeJS.ErrnoException) => {
            if (error.code !== undefined && NOT_RUNNING.has(error.code)) resolve(null);
            else reject(error);
        });
        if (method === 'POST') outgoing.setHeader('Content-Length', 0);
        outgoing.end();
    });
}

/**
 * Talks to the engine running from `dataDir` over its operator socket. The CLI and the engine are one build, so the
 * answers are parsed strictly: a mismatch is a bug to report, not data to guess at.
 */
export function createOperatorClient(dataDir: string): OperatorClient {
    const socketPath = operatorSocketPath(dataDir);
    // Checked before every call: a socket in a directory someone else controls could answer in the engine's name.
    async function guarded<T>(run: () => Promise<T>): Promise<T> {
        const problem = await socketDirProblem(dataDir);
        if (problem !== null) throw new OperatorSocketError(problem);
        return run();
    }
    return {
        status: () => guarded(() => call(socketPath, 'GET', OPERATOR_PATHS.status, OperatorStatus)),
        link: (showsSetupLink) =>
            guarded(() =>
                call(
                    socketPath,
                    'POST',
                    showsSetupLink ? `${OPERATOR_PATHS.link}?setup-link=caller` : OPERATOR_PATHS.link,
                    LinkAnswer,
                ),
            ),
        setupLink: () => guarded(() => call(socketPath, 'POST', OPERATOR_PATHS.setupLink, SetupLinkAnswer)),
        resetOwner: () => guarded(() => call(socketPath, 'POST', OPERATOR_PATHS.resetOwner, ResetAnswer)),
    };
}
