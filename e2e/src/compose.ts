// Control of the running stack from inside the playwright container, through the Docker Engine API on the mounted
// socket: no docker CLI or compose files are needed there. Only containers of this compose project are ever touched.
import { request } from 'node:http';

export const DOCKER_SOCKET = '/var/run/docker.sock';
const API_VERSION = 'v1.43';
const STOP_TIMEOUT_S = 10;
const PROJECT_LABEL = 'com.docker.compose.project';
const SERVICE_LABEL = 'com.docker.compose.service';
const ONE_OFF_LABEL = 'com.docker.compose.oneoff';

export interface DockerResponse {
    readonly status: number;
    readonly body: Buffer;
}

/** One Engine API call; a port so the control logic is tested without a daemon. */
export type DockerTransport = (method: 'GET' | 'POST', path: string) => Promise<DockerResponse>;

export function unixSocketTransport(socketPath: string, timeoutMs = 30_000): DockerTransport {
    return (method, path) =>
        new Promise((resolve, reject) => {
            const req = request({ socketPath, method, path: `/${API_VERSION}${path}`, timeout: timeoutMs }, (res) => {
                const chunks: Buffer[] = [];
                res.on('data', (chunk: Buffer) => chunks.push(chunk));
                res.on('end', () => {
                    resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) });
                });
                res.on('error', reject);
            });
            req.on('timeout', () => req.destroy(new Error(`docker ${method} ${path} timed out`)));
            req.on('error', reject);
            req.end();
        });
}

export type ContainerHealth = 'healthy' | 'unhealthy' | 'starting' | 'none';

export interface ComposeControl {
    readonly project: string;
    /** `docker compose stop`: SIGTERM, then SIGKILL after 10 s. */
    stop(service: string): Promise<void>;
    start(service: string): Promise<void>;
    /** The process is gone and its ports refuse connections (failover tests). */
    kill(service: string, signal?: string): Promise<void>;
    restart(service: string): Promise<void>;
    /** Freezes the container: connections hang instead of being refused (blackhole tests). */
    pause(service: string): Promise<void>;
    unpause(service: string): Promise<void>;
    /** stdout and stderr since the container started, interleaved in order. */
    logs(service: string): Promise<string>;
    health(service: string): Promise<ContainerHealth>;
}

export class DockerApiError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'DockerApiError';
    }
}

/**
 * Splits the Engine API's multiplexed log stream (8-byte frame headers: stream type, three zero bytes, big-endian
 * u32 length) back into text. A container with a TTY sends plain bytes instead, which are returned as they are.
 */
export function demuxDockerLogs(body: Buffer): string {
    if (!isFrameHeader(body, 0)) return body.toString('utf8');
    const parts: Buffer[] = [];
    let offset = 0;
    while (offset < body.length) {
        if (!isFrameHeader(body, offset)) throw new DockerApiError('malformed log stream');
        const end = offset + 8 + body.readUInt32BE(offset + 4);
        if (end > body.length) throw new DockerApiError('truncated log stream');
        parts.push(body.subarray(offset + 8, end));
        offset = end;
    }
    return Buffer.concat(parts).toString('utf8');
}

function isFrameHeader(body: Buffer, offset: number): boolean {
    const kind = body[offset];
    return (
        body.length - offset >= 8 &&
        (kind === 0 || kind === 1 || kind === 2) &&
        body[offset + 1] === 0 &&
        body[offset + 2] === 0 &&
        body[offset + 3] === 0
    );
}

interface ContainerSummary {
    readonly Id: string;
}

function parseJson(response: DockerResponse, what: string): unknown {
    try {
        return JSON.parse(response.body.toString('utf8')) as unknown;
    } catch {
        throw new DockerApiError(`${what}: the Docker API answered with something other than JSON`);
    }
}

function expectStatus(response: DockerResponse, what: string, ok: readonly number[]): void {
    if (!ok.includes(response.status)) {
        throw new DockerApiError(`${what}: Docker API status ${String(response.status)}`);
    }
}

/** The compose project of the container we run in (its hostname is its short ID). */
export async function ownComposeProject(transport: DockerTransport, containerHostname: string): Promise<string> {
    const what = 'inspect own container';
    const response = await transport('GET', `/containers/${encodeURIComponent(containerHostname)}/json`);
    expectStatus(response, what, [200]);
    const project = (parseJson(response, what) as { Config?: { Labels?: Record<string, unknown> } } | null)?.Config
        ?.Labels?.[PROJECT_LABEL];
    if (typeof project !== 'string' || project === '') throw new DockerApiError(`${what}: not a compose container`);
    return project;
}

export function createComposeControl(transport: DockerTransport, project: string): ComposeControl {
    async function containerOf(service: string): Promise<string> {
        const filters = JSON.stringify({
            label: [`${PROJECT_LABEL}=${project}`, `${SERVICE_LABEL}=${service}`, `${ONE_OFF_LABEL}=False`],
        });
        const what = `find ${service}`;
        const response = await transport('GET', `/containers/json?all=true&filters=${encodeURIComponent(filters)}`);
        expectStatus(response, what, [200]);
        const containers = parseJson(response, what);
        if (!Array.isArray(containers) || containers.length !== 1) {
            const count = Array.isArray(containers) ? containers.length : 0;
            throw new DockerApiError(`${what}: expected one container in project ${project}, found ${String(count)}`);
        }
        const [container] = containers as ContainerSummary[];
        if (typeof container?.Id !== 'string') throw new DockerApiError(`${what}: container without an ID`);
        return container.Id;
    }

    async function post(service: string, action: string, query = ''): Promise<void> {
        const id = await containerOf(service);
        // 304: already in the requested state, which is what the caller wanted.
        expectStatus(
            await transport('POST', `/containers/${id}/${action}${query}`),
            `${action} ${service}`,
            [204, 304],
        );
    }

    return {
        project,
        stop: (service) => post(service, 'stop', `?t=${String(STOP_TIMEOUT_S)}`),
        start: (service) => post(service, 'start'),
        kill: (service, signal = 'SIGKILL') => post(service, 'kill', `?signal=${encodeURIComponent(signal)}`),
        restart: (service) => post(service, 'restart', `?t=${String(STOP_TIMEOUT_S)}`),
        pause: (service) => post(service, 'pause'),
        unpause: (service) => post(service, 'unpause'),
        async logs(service) {
            const id = await containerOf(service);
            const response = await transport('GET', `/containers/${id}/logs?stdout=true&stderr=true`);
            expectStatus(response, `logs ${service}`, [200]);
            return demuxDockerLogs(response.body);
        },
        async health(service) {
            const id = await containerOf(service);
            const what = `inspect ${service}`;
            const response = await transport('GET', `/containers/${id}/json`);
            expectStatus(response, what, [200]);
            const status = (parseJson(response, what) as { State?: { Health?: { Status?: unknown } } } | null)?.State
                ?.Health?.Status;
            return status === 'healthy' || status === 'unhealthy' || status === 'starting' ? status : 'none';
        },
    };
}
