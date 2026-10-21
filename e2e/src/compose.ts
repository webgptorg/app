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
export type DockerTransport = (method: 'GET' | 'POST', path: string, body?: unknown) => Promise<DockerResponse>;

/** A GET whose body is streamed (container filesystem exports run to hundreds of megabytes). */
export type DockerStreamTransport = (path: string) => Promise<{ status: number; body: AsyncIterable<Uint8Array> }>;

export function unixSocketTransport(socketPath: string, timeoutMs = 30_000): DockerTransport {
    return (method, path, body) =>
        new Promise((resolve, reject) => {
            const payload = body === undefined ? undefined : JSON.stringify(body);
            const req = request(
                {
                    socketPath,
                    method,
                    path: `/${API_VERSION}${path}`,
                    timeout: timeoutMs,
                    headers: payload === undefined ? {} : { 'Content-Type': 'application/json' },
                },
                (res) => {
                    const chunks: Buffer[] = [];
                    res.on('data', (chunk: Buffer) => chunks.push(chunk));
                    res.on('end', () => {
                        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) });
                    });
                    res.on('error', reject);
                },
            );
            req.on('timeout', () => req.destroy(new Error(`docker ${method} ${path} timed out`)));
            req.on('error', reject);
            req.end(payload);
        });
}

export function unixSocketStreamTransport(socketPath: string, timeoutMs = 60_000): DockerStreamTransport {
    return (path) =>
        new Promise((resolve, reject) => {
            const req = request(
                { socketPath, method: 'GET', path: `/${API_VERSION}${path}`, timeout: timeoutMs },
                (res) => {
                    resolve({ status: res.statusCode ?? 0, body: res });
                },
            );
            req.on('timeout', () => req.destroy(new Error(`docker GET ${path} timed out`)));
            req.on('error', reject);
            req.end();
        });
}

export type ContainerHealth = 'healthy' | 'unhealthy' | 'starting' | 'none';

export interface ExecResult {
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
}

export interface ContainerInspection {
    /** `NAME=value` as the container was created with them. */
    readonly env: readonly string[];
    /** Every volume and bind mount, by its path inside the container. */
    readonly mounts: readonly { readonly destination: string; readonly type: string }[];
    readonly cmd: readonly string[];
    readonly entrypoint: readonly string[];
    readonly labels: Readonly<Record<string, string>>;
}

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
    /** `docker compose exec`, without a TTY or stdin; `user` defaults to the container's own. */
    exec(service: string, command: readonly string[], options?: { readonly user?: string }): Promise<ExecResult>;
    /** The parts of `docker inspect` the key scan reads. */
    inspect(service: string): Promise<ContainerInspection>;
    /** The container's root filesystem as a tar stream, without its mounts (`docker export`). */
    exportFilesystem(service: string): Promise<AsyncIterable<Uint8Array>>;
    /** One path, mounts included, as a tar stream (`docker cp` out). */
    archive(service: string, path: string): Promise<AsyncIterable<Uint8Array>>;
    /**
     * Takes the service off a network of this project, as if its cable were pulled; returns its address there so
     * `connectNetwork` can put it back exactly.
     */
    disconnectNetwork(service: string, network: string): Promise<string>;
    connectNetwork(service: string, network: string, ipv4Address: string): Promise<void>;
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

/** The same frames, kept apart by stream (1 stdout, 2 stderr), as `exec` returns them. */
export function demuxDockerStreams(body: Buffer): { stdout: string; stderr: string } {
    const parts: Record<'stdout' | 'stderr', Buffer[]> = { stdout: [], stderr: [] };
    let offset = 0;
    while (offset < body.length) {
        if (!isFrameHeader(body, offset)) throw new DockerApiError('malformed exec stream');
        const end = offset + 8 + body.readUInt32BE(offset + 4);
        if (end > body.length) throw new DockerApiError('truncated exec stream');
        parts[body[offset] === 2 ? 'stderr' : 'stdout'].push(body.subarray(offset + 8, end));
        offset = end;
    }
    return {
        stdout: Buffer.concat(parts.stdout).toString('utf8'),
        stderr: Buffer.concat(parts.stderr).toString('utf8'),
    };
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

function stringList(value: unknown): readonly string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function parseInspection(value: unknown): ContainerInspection {
    const raw = (value ?? {}) as {
        Config?: { Env?: unknown; Cmd?: unknown; Entrypoint?: unknown; Labels?: unknown };
        Mounts?: unknown;
    };
    const mounts = Array.isArray(raw.Mounts) ? (raw.Mounts as { Destination?: unknown; Type?: unknown }[]) : [];
    const labels = typeof raw.Config?.Labels === 'object' && raw.Config.Labels !== null ? raw.Config.Labels : {};
    return {
        env: stringList(raw.Config?.Env),
        cmd: stringList(raw.Config?.Cmd),
        entrypoint: stringList(raw.Config?.Entrypoint),
        mounts: mounts.flatMap((mount) =>
            typeof mount.Destination === 'string'
                ? [{ destination: mount.Destination, type: typeof mount.Type === 'string' ? mount.Type : 'unknown' }]
                : [],
        ),
        labels: Object.fromEntries(
            Object.entries(labels).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
        ),
    };
}

export function createComposeControl(
    transport: DockerTransport,
    project: string,
    streamTransport?: DockerStreamTransport,
): ComposeControl {
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

    async function inspectRaw(service: string): Promise<unknown> {
        const id = await containerOf(service);
        const what = `inspect ${service}`;
        const response = await transport('GET', `/containers/${id}/json`);
        expectStatus(response, what, [200]);
        return parseJson(response, what);
    }

    async function streamOf(what: string, path: string): Promise<AsyncIterable<Uint8Array>> {
        if (streamTransport === undefined) throw new DockerApiError(`${what}: no streaming transport`);
        const response = await streamTransport(path);
        if (response.status !== 200) {
            // Drain so the socket is released; the body is an error message, not needed here.
            const drain = response.body[Symbol.asyncIterator]();
            while (!(await drain.next()).done);
            throw new DockerApiError(`${what}: Docker API status ${String(response.status)}`);
        }
        return response.body;
    }

    const networkName = (network: string): string => `${project}_${network}`;

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
        async exec(service, command, options = {}) {
            const id = await containerOf(service);
            const what = `exec in ${service}`;
            const created = await transport('POST', `/containers/${id}/exec`, {
                AttachStdout: true,
                AttachStderr: true,
                Cmd: command,
                ...(options.user === undefined ? {} : { User: options.user }),
            });
            expectStatus(created, what, [201]);
            const execId = (parseJson(created, what) as { Id?: unknown } | null)?.Id;
            if (typeof execId !== 'string') throw new DockerApiError(`${what}: no exec ID`);
            const started = await transport('POST', `/exec/${execId}/start`, { Detach: false, Tty: false });
            expectStatus(started, what, [200]);
            const output = demuxDockerStreams(started.body);
            const inspected = await transport('GET', `/exec/${execId}/json`);
            expectStatus(inspected, what, [200]);
            const exitCode = (parseJson(inspected, what) as { ExitCode?: unknown } | null)?.ExitCode;
            if (typeof exitCode !== 'number') throw new DockerApiError(`${what}: no exit code`);
            return { exitCode, ...output };
        },
        async inspect(service) {
            return parseInspection(await inspectRaw(service));
        },
        async exportFilesystem(service) {
            return streamOf(`export ${service}`, `/containers/${await containerOf(service)}/export`);
        },
        async archive(service, path) {
            const id = await containerOf(service);
            return streamOf(`archive ${service}:${path}`, `/containers/${id}/archive?path=${encodeURIComponent(path)}`);
        },
        async disconnectNetwork(service, network) {
            const name = networkName(network);
            const raw = (await inspectRaw(service)) as {
                Id?: unknown;
                NetworkSettings?: { Networks?: Record<string, { IPAMConfig?: { IPv4Address?: unknown } | null }> };
            } | null;
            const address = raw?.NetworkSettings?.Networks?.[name]?.IPAMConfig?.IPv4Address;
            if (typeof raw?.Id !== 'string' || typeof address !== 'string') {
                throw new DockerApiError(`disconnect ${service}: no fixed address on ${name}`);
            }
            expectStatus(
                await transport('POST', `/networks/${encodeURIComponent(name)}/disconnect`, {
                    Container: raw.Id,
                    Force: true,
                }),
                `disconnect ${service}`,
                [200],
            );
            return address;
        },
        async connectNetwork(service, network, ipv4Address) {
            const name = networkName(network);
            expectStatus(
                await transport('POST', `/networks/${encodeURIComponent(name)}/connect`, {
                    Container: await containerOf(service),
                    EndpointConfig: { IPAMConfig: { IPv4Address: ipv4Address } },
                }),
                `connect ${service}`,
                [200],
            );
        },
    };
}
