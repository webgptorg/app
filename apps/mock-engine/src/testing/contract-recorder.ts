import type { RouteDefinition } from '@ptbk/engine-api';
import {
    ENGINE_API_PREFIX,
    ENGINE_API_ROUTE_LIST,
    PROBLEM_STATUS,
    ProblemDetails,
    createSseParser,
} from '@ptbk/engine-api';

const ROUTE_PATTERNS = ENGINE_API_ROUTE_LIST.map((route) => ({
    route,
    literals: route.path.split('/').filter((segment) => segment !== '' && !segment.startsWith('{')).length,
    pattern: new RegExp(`^${ENGINE_API_PREFIX}${route.path.replace(/\{\w+\}/g, '[^/]+')}$`),
})).sort((a, b) => b.literals - a.literals);

function routeOf(method: string, path: string): RouteDefinition | undefined {
    return ROUTE_PATTERNS.find(({ route, pattern }) => route.method === method && pattern.test(path))?.route;
}

/**
 * Everything the engine API answered during a test run, checked as it arrives against the strict schemas a server
 * must meet (ADR 0010 §3: clients strip unknown fields, so only a server-side check catches an undeclared one), and
 * kept as raw bytes so a test can search them for secret values.
 */
export interface ContractRecorder {
    /** Wraps a `fetch`; responses pass through unchanged. */
    wrap(base: typeof fetch): typeof fetch;
    /** Operation IDs that answered at least once. */
    readonly answered: ReadonlySet<string>;
    /** Contract violations, as `routeId: what`; a test run expects none. */
    readonly violations: readonly string[];
    /** Every response body byte seen so far, streams included. */
    bytes(): Buffer;
    /** Waits for stream checks still reading. */
    settled(): Promise<void>;
}

export function createContractRecorder(): ContractRecorder {
    const answered = new Set<string>();
    const violations: string[] = [];
    const chunks: Buffer[] = [];
    const pending = new Set<Promise<void>>();
    const violation = (route: RouteDefinition, what: string): void => {
        violations.push(`${route.id}: ${what}`);
    };

    function checkJson(route: RouteDefinition, status: number, text: string): void {
        let body: unknown;
        try {
            body = JSON.parse(text);
        } catch {
            violation(route, `status ${String(status)} body is not JSON`);
            return;
        }
        if (status >= 400) {
            const problem = ProblemDetails.safeParse(body);
            if (!problem.success) violation(route, `problem does not match ProblemDetails strictly`);
            else if (PROBLEM_STATUS[problem.data.code] !== status) violation(route, `problem status ${String(status)}`);
            return;
        }
        const success = route.responses[status as keyof RouteDefinition['responses']];
        if (success?.kind !== 'json') {
            violation(route, `unexpected JSON for status ${String(status)}`);
            return;
        }
        const result = success.schema.safeParse(body);
        if (!result.success) {
            violation(
                route,
                `response does not match its strict schema: ${result.error.issues.map((issue) => `${issue.path.join('.')} ${issue.code}`).join(', ')}`,
            );
        }
    }

    /** Reads the response itself and hands each chunk on, so the client's cancel also ends this reading. */
    function checkStream(route: RouteDefinition, response: Response, body: ReadableStream<Uint8Array>): Response {
        const success = Object.values(route.responses)[0];
        if (success?.kind !== 'sse') violation(route, 'unexpected event stream');
        const parser = createSseParser();
        const reader = body.getReader();
        let finish = (): void => undefined;
        const done = new Promise<void>((resolve) => {
            finish = resolve;
        });
        pending.add(done);
        void done.then(() => pending.delete(done));
        const inspect = (bytes: Uint8Array): void => {
            chunks.push(Buffer.from(bytes));
            if (success?.kind !== 'sse') return;
            for (const message of parser.push(bytes)) {
                if (!success.event.safeParse(JSON.parse(message.data)).success) {
                    violation(route, 'event does not match its strict schema');
                }
            }
        };
        const stream = new ReadableStream<Uint8Array>({
            async pull(controller) {
                try {
                    const next = await reader.read();
                    if (next.done) {
                        finish();
                        controller.close();
                        return;
                    }
                    inspect(next.value);
                    controller.enqueue(next.value);
                } catch (error) {
                    // The client went away or a fault cut the stream; what arrived was still checked.
                    finish();
                    controller.error(error);
                }
            },
            async cancel(reason) {
                finish();
                await reader.cancel(reason);
            },
        });
        return new Response(stream, { status: response.status, headers: response.headers });
    }

    return {
        answered,
        violations,
        bytes: () => Buffer.concat(chunks),
        settled: async () => {
            await Promise.all([...pending]);
        },
        wrap: (base) => async (input, init) => {
            const request = new Request(input, init);
            const response = await base(request);
            const path = new URL(request.url).pathname;
            const route = routeOf(request.method, path);
            if (route === undefined) return response;
            answered.add(route.id);
            const mediaType = response.headers.get('content-type')?.split(';')[0]?.trim();
            if (mediaType === 'text/event-stream' && response.body !== null) {
                return checkStream(route, response, response.body);
            }
            const bytes = Buffer.from(await response.arrayBuffer());
            chunks.push(bytes);
            if (mediaType === 'application/json' || mediaType === 'application/problem+json') {
                checkJson(route, response.status, bytes.toString('utf8'));
            } else if (response.status >= 400) {
                violation(route, `status ${String(response.status)} without problem+json`);
            }
            return new Response(bytes.byteLength === 0 && response.status === 204 ? null : bytes, {
                status: response.status,
                headers: response.headers,
            });
        },
    };
}
