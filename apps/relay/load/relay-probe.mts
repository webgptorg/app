/**
 * Preloaded into the relay under test only (`NODE_OPTIONS=--import`), never part of the production bundle. Appends one
 * CSV row every LOAD_SAMPLE_INTERVAL_MS: the process's memory and CPU, its event loop, and the container's cgroup and
 * network counters, so heap, off-heap and kernel socket memory can be told apart. Node strips the types itself; this
 * file imports nothing but node:*.
 */
import { appendFileSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { availableParallelism, release } from 'node:os';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

const COLUMNS = [
    'time_ms',
    'pid',
    'uptime_s',
    'rss_bytes',
    'heap_total_bytes',
    'heap_used_bytes',
    'external_bytes',
    'array_buffers_bytes',
    'process_cpu_us',
    'cgroup_cpu_us',
    'cgroup_memory_bytes',
    'cgroup_anon_bytes',
    'cgroup_file_bytes',
    'cgroup_sock_bytes',
    'cgroup_slab_bytes',
    'net_rx_bytes',
    'net_tx_bytes',
    'open_fds',
    'tcp_sockets',
    'tcp_tx_queue_bytes',
    'tcp_rx_queue_bytes',
    'event_loop_utilization',
    'loop_delay_p99_ms',
    'loop_delay_max_ms',
];

function readText(path: string): string {
    try {
        return readFileSync(path, 'utf8');
    } catch {
        return '';
    }
}

function keyed(text: string): Map<string, number> {
    const values = new Map<string, number>();
    for (const line of text.split('\n')) {
        const [key, value] = line.trim().split(/\s+/);
        if (key !== undefined && value !== undefined) values.set(key, Number(value));
    }
    return values;
}

function network(): { rx: number; tx: number } {
    let rx = 0;
    let tx = 0;
    for (const line of readText('/proc/net/dev').split('\n').slice(2)) {
        const [name, rest] = line.split(':');
        if (name === undefined || rest === undefined || name.trim() === 'lo') continue;
        const fields = rest.trim().split(/\s+/).map(Number);
        rx += fields[0] ?? 0;
        tx += fields[8] ?? 0;
    }
    return { rx, tx };
}

/**
 * Bytes queued in the kernel on the relay's TCP sockets (this network namespace only), from /proc/net/tcp{,6}. Docker
 * on OrbStack boots with `cgroup.memory=nosocket`, so the cgroup never sees socket buffers; on a VPS they are RAM all
 * the same. Read off the event loop, so a large table does not stall the relay.
 */
async function tcpQueues(): Promise<{ sockets: number; tx: number; rx: number }> {
    let sockets = 0;
    let tx = 0;
    let rx = 0;
    for (const path of ['/proc/net/tcp', '/proc/net/tcp6']) {
        const text = await readFile(path, 'utf8').catch(() => '');
        for (const line of text.split('\n').slice(1)) {
            const queues = line.trim().split(/\s+/)[4];
            if (queues === undefined) continue;
            const [sent = '0', received = '0'] = queues.split(':');
            sockets++;
            tx += Number.parseInt(sent, 16);
            rx += Number.parseInt(received, 16);
        }
    }
    return { sockets, tx, rx };
}

function start(file: string, intervalMs: number): void {
    if (!existsSync(file) || statSync(file).size === 0) writeFileSync(file, `${COLUMNS.join(',')}\n`);
    const metaFile = process.env['LOAD_META_FILE'];
    if (metaFile !== undefined) {
        writeFileSync(
            metaFile,
            JSON.stringify(
                {
                    node: process.version,
                    kernel: release(),
                    availableParallelism: availableParallelism(),
                    cgroupCpuMax: readText('/sys/fs/cgroup/cpu.max').trim(),
                    cgroupMemoryMax: readText('/sys/fs/cgroup/memory.max').trim(),
                    tcpWmem: readText('/proc/sys/net/ipv4/tcp_wmem').trim(),
                    tcpRmem: readText('/proc/sys/net/ipv4/tcp_rmem').trim(),
                },
                null,
                2,
            ),
        );
    }
    const delay = monitorEventLoopDelay({ resolution: 10 });
    delay.enable();
    let lastUtilization = performance.eventLoopUtilization();
    const sample = async (): Promise<void> => {
        try {
            const tcp = await tcpQueues();
            const memory = process.memoryUsage();
            const cpu = process.cpuUsage();
            const stat = keyed(readText('/sys/fs/cgroup/memory.stat'));
            const cgroupCpu = keyed(readText('/sys/fs/cgroup/cpu.stat'));
            const utilization = performance.eventLoopUtilization(lastUtilization);
            lastUtilization = performance.eventLoopUtilization();
            const { rx, tx } = network();
            const row = [
                Date.now(),
                process.pid,
                process.uptime().toFixed(1),
                memory.rss,
                memory.heapTotal,
                memory.heapUsed,
                memory.external,
                memory.arrayBuffers,
                cpu.user + cpu.system,
                cgroupCpu.get('usage_usec') ?? '',
                readText('/sys/fs/cgroup/memory.current').trim(),
                stat.get('anon') ?? '',
                stat.get('file') ?? '',
                stat.get('sock') ?? '',
                stat.get('slab') ?? '',
                rx,
                tx,
                readdirSync('/proc/self/fd').length,
                tcp.sockets,
                tcp.tx,
                tcp.rx,
                utilization.utilization.toFixed(4),
                (delay.percentile(99) / 1e6).toFixed(2),
                (delay.max / 1e6).toFixed(2),
            ];
            delay.reset();
            appendFileSync(file, `${row.join(',')}\n`);
        } catch {
            // Sampling must never take the relay down; a missed row shows up as a gap.
        }
    };
    setInterval(() => void sample(), intervalMs).unref();
    void sample();
}

const samplesFile = process.env['LOAD_SAMPLES_FILE'];
// NODE_OPTIONS reaches every node process in the container, the healthcheck too; only the relay is sampled.
const isRelay = process.argv[1] === '/app/main.mjs';
if (isRelay && samplesFile !== undefined && samplesFile !== '') {
    start(samplesFile, Number(process.env['LOAD_SAMPLE_INTERVAL_MS'] ?? '5000'));
}
