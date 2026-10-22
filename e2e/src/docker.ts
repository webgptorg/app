// Docker and Compose invocations shared by the e2e driver (cli.ts) and the dev stack (dev-stack.ts). Only node:
// imports, so it runs before (and without) an install.
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { Writable } from 'node:stream';

export interface ComposeTarget {
    readonly project: string;
    readonly e2eDir: string;
    /** `compose.<name>.yaml` files layered over compose.yaml, in order. */
    readonly overlays: readonly string[];
    /** Selects the specs inside the playwright container (playwright.config.ts). */
    readonly scenario: string;
    /** Services `up` only creates; tests start copies of them (`Scenario.onDemand`). */
    readonly onDemand: readonly string[];
}

export function composeArgs(target: ComposeTarget, ...args: readonly string[]): readonly string[] {
    return [
        'compose',
        '--project-name',
        target.project,
        '--project-directory',
        target.e2eDir,
        '--file',
        join(target.e2eDir, 'compose.yaml'),
        ...target.overlays.flatMap((name) => ['--file', join(target.e2eDir, `compose.${name}.yaml`)]),
        ...args,
    ];
}

type Output = 'inherit' | 'ignore' | NodeJS.WritableStream;

export function docker(
    args: readonly string[],
    stdout: Output = 'inherit',
    stderr: 'inherit' | 'ignore' = 'inherit',
): Promise<number> {
    return new Promise((resolve, reject) => {
        const child = spawn('docker', [...args], {
            stdio: ['ignore', typeof stdout === 'string' ? stdout : 'pipe', stderr],
        });
        if (typeof stdout !== 'string') child.stdout?.pipe(stdout, { end: false });
        child.once('error', reject);
        child.once('close', (code) => {
            resolve(code ?? 1);
        });
    });
}

/** Exit code and stdout of a docker command whose stderr goes to the terminal. */
export async function dockerCapture(
    args: readonly string[],
): Promise<{ readonly code: number; readonly stdout: string }> {
    const chunks: Buffer[] = [];
    const sink = new Writable({
        write(chunk: Buffer, _encoding, callback) {
            chunks.push(chunk);
            callback();
        },
    });
    const code = await docker(args, sink);
    return { code, stdout: Buffer.concat(chunks).toString('utf8') };
}

export async function dockerOutput(args: readonly string[]): Promise<string> {
    const { code, stdout } = await dockerCapture(args);
    if (code !== 0) throw new Error(`docker ${args.slice(0, 3).join(' ')} … exited with ${String(code)}`);
    return stdout;
}

export async function must(args: readonly string[]): Promise<void> {
    const code = await docker(args);
    if (code !== 0) throw new Error(`docker ${args.slice(0, 6).join(' ')} … exited with ${String(code)}`);
}
