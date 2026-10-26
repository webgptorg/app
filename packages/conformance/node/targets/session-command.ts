import { spawn } from 'node:child_process';

import type { SessionCredential, SessionSubject } from '../../src/index';
import type { EngineCommand } from '../harness/engine-process';
import type { EngineTargetFactory } from '../harness/platform';

/** RFC 6265 token characters, so nothing the command prints can break out of the `Cookie` header. */
const COOKIE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,256}=[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,4096}$/;
const BEARER = /^[A-Za-z0-9\-._~+/]{1,4096}=*$/;
const SESSION_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_CHARS = 64 * 1024;

export class SessionCommandError extends Error {
    override readonly name = 'SessionCommandError';
}

function argumentsFor(subject: SessionSubject): string {
    if (subject.kind === 'owner') return ' --subject owner';
    // Permission names are a closed list of `a.b` tokens, so they need no quoting beyond this check.
    for (const permission of subject.permissions) {
        if (!/^[a-z][a-z.-]*$/.test(permission)) throw new SessionCommandError('unexpected permission name');
    }
    return ` --subject member --permissions ${subject.permissions.length === 0 ? "''" : subject.permissions.join(',')}`;
}

/** Strict on what the engine prints: one JSON value, a cookie or bearer credential, or `null` for "cannot". */
export function parseSessionOutput(stdout: string): SessionCredential | null {
    let value: unknown;
    try {
        value = JSON.parse(stdout);
    } catch {
        throw new SessionCommandError('the session command did not print JSON');
    }
    if (value === null) return null;
    if (typeof value === 'object' && !Array.isArray(value)) {
        const entries = Object.entries(value as Record<string, unknown>);
        const [entry] = entries;
        if (entries.length === 1 && entry !== undefined && typeof entry[1] === 'string') {
            const [kind, credential] = entry;
            if (kind === 'cookie' && COOKIE.test(credential)) return { cookie: credential };
            if (kind === 'bearer' && BEARER.test(credential)) return { bearer: credential };
        }
    }
    throw new SessionCommandError('the session command printed neither {"cookie"}, {"bearer"} nor null');
}

/**
 * Sessions on an engine that has no HTTP way to hand them out (ENG-99): the engine's own conformance build ships a
 * `conformance-session` command, run here next to the engine with the same environment, so it reaches the same data
 * directory. It prints `{"cookie":"name=value"}`, `{"bearer":"…"}` or `null` (that subject cannot be had, so the checks
 * that need it skip).
 */
export function createSessionCommandTargetFactory(command: EngineCommand): EngineTargetFactory {
    return {
        engineEnv: () => Promise.resolve({}),
        target(engine, endpoint) {
            return {
                baseUrl: endpoint.baseUrl,
                fetch: endpoint.fetch,
                session: (subject) =>
                    new Promise<SessionCredential | null>((resolve, reject) => {
                        const child = spawn('/bin/sh', ['-c', `${command.command}${argumentsFor(subject)}`], {
                            cwd: command.cwd,
                            env: engine.env,
                            detached: true,
                            stdio: ['ignore', 'pipe', 'pipe'],
                        });
                        let stdout = '';
                        child.stdout.on('data', (chunk: Buffer) => {
                            if (stdout.length < MAX_OUTPUT_CHARS) stdout += chunk.toString('utf8');
                        });
                        child.stderr.resume();
                        const timer = setTimeout(() => {
                            if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
                        }, SESSION_TIMEOUT_MS);
                        child.once('error', (error) => {
                            clearTimeout(timer);
                            reject(error);
                        });
                        child.once('close', (code, signal) => {
                            clearTimeout(timer);
                            if (code !== 0) {
                                const how = signal ?? `status ${String(code)}`;
                                reject(new SessionCommandError(`the session command exited with ${how}`));
                                return;
                            }
                            try {
                                resolve(parseSessionOutput(stdout));
                            } catch (error) {
                                reject(error instanceof Error ? error : new SessionCommandError('unreadable output'));
                            }
                        });
                    }),
            };
        },
    };
}
