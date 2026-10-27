import type { OperatorClient } from '../adapters/operator-client';
import type { AddressGap } from '../domain/onboarding/address';
import type { SetupLinkAnswer } from '../domain/onboarding/operator-api';
import type { ExitCode } from './exit-codes';
import { EXIT_CODE } from './exit-codes';
import type { Say } from './operator-lines';
import { DONE, FAILED, WAITING } from './operator-lines';
import { ENGINE_COMMAND } from './registration-messages';

export const SETUP_LINK_USAGE = 'usage: setup-link [--no-wait] [--json]';
export const OWNER_USAGE = 'usage: owner --reset [--yes] [--no-wait] [--json]';
/** How long `setup-link` waits for the address; the certificate usually takes under 30 s, a slow CA a few minutes. */
export const SETUP_LINK_WAIT_MS = 10 * 60_000;
const POLL_MS = 1_000;

export class SetupLinkUsageError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SetupLinkUsageError';
    }
}

export interface SetupLinkCommand {
    /** Wait until the address works; `--no-wait` says what is missing instead. */
    readonly wait: boolean;
    /** Print one JSON object, even when stdout is not a terminal: the operator asked for the link explicitly. */
    readonly json: boolean;
}

export interface OwnerResetCommand extends SetupLinkCommand {
    /** Skip the typed confirmation, for scripts and tests. */
    readonly yes: boolean;
}

function flags(args: readonly string[], allowed: readonly string[], usage: string): ReadonlySet<string> {
    const seen = new Set<string>();
    for (const arg of args) {
        if (!allowed.includes(arg) || seen.has(arg)) throw new SetupLinkUsageError(usage);
        seen.add(arg);
    }
    return seen;
}

export function parseSetupLinkCommand(args: readonly string[]): SetupLinkCommand {
    const set = flags(args, ['--no-wait', '--json'], SETUP_LINK_USAGE);
    return { wait: !set.has('--no-wait'), json: set.has('--json') };
}

export function parseOwnerCommand(args: readonly string[]): OwnerResetCommand {
    const [action, ...rest] = args;
    if (action !== '--reset') throw new SetupLinkUsageError(OWNER_USAGE);
    const set = flags(rest, ['--yes', '--no-wait', '--json'], OWNER_USAGE);
    return { yes: set.has('--yes'), wait: !set.has('--no-wait'), json: set.has('--json') };
}

export interface SetupLinkDeps {
    readonly client: Pick<OperatorClient, 'status' | 'setupLink' | 'resetOwner'>;
    /** Stdout: the link, and nothing else that could be mistaken for it. */
    readonly out: Say;
    /** Stderr: progress and problems. */
    readonly err: Say;
    /** Whether stdout is an interactive terminal. */
    readonly terminal: boolean;
    readonly sleep: (ms: number) => Promise<void>;
    readonly nowMs: () => number;
    /** The expiry as the operator reads a clock, e.g. `14:32`. */
    readonly clockTime: (iso: string) => string;
    /** Reads one line typed on an interactive stdin; `null` when stdin is not a terminal. */
    readonly ask: (prompt: string) => Promise<string | null>;
}

const GAP_WORDS: Readonly<Record<AddressGap, string>> = {
    relay: 'a relay connection',
    certificate: 'a certificate',
    'setup-page': 'the setup page',
};

function gaps(missing: readonly AddressGap[]): string {
    return missing.map((gap) => GAP_WORDS[gap]).join(' and ');
}

const NOT_RUNNING = 'The engine is not running from this PTBK_DATA_DIR. Start it, then try again.';
const TERMINAL_ONLY = `The setup link is printed only to an interactive terminal: whoever opens it first becomes the owner, and output that is not a terminal tends to end up in logs. Run \`${ENGINE_COMMAND} setup-link\` in a terminal, or pass --json to print it anyway.`;

type Obtained = { readonly answer: SetupLinkAnswer; readonly exitCode: ExitCode } | null;

/** Asks for a link until the address works (or once with `--no-wait`), narrating the wait on stderr. */
async function obtain(wait: boolean, deps: SetupLinkDeps): Promise<Obtained> {
    const deadline = deps.nowMs() + SETUP_LINK_WAIT_MS;
    let said = '';
    for (;;) {
        const answer = await deps.client.setupLink();
        if (answer === null) return null;
        if (answer.outcome === 'created') return { answer, exitCode: EXIT_CODE.ok };
        if (answer.outcome === 'owner-exists') return { answer, exitCode: EXIT_CODE.ownerExists };
        if (!wait || deps.nowMs() >= deadline) return { answer, exitCode: EXIT_CODE.notReady };
        const line = `${WAITING} Waiting for ${gaps(answer.missing)} before printing the setup link`;
        if (line !== said) deps.err(line);
        said = line;
        await deps.sleep(POLL_MS);
    }
}

function report(obtained: NonNullable<Obtained>, json: boolean, deps: SetupLinkDeps): void {
    const { answer } = obtained;
    if (json) {
        deps.out(JSON.stringify(answer));
        return;
    }
    switch (answer.outcome) {
        case 'created':
            deps.out('Make yourself the owner of this engine in your browser:');
            deps.out('');
            deps.out(`  ${answer.url}`);
            deps.out('');
            deps.out(
                `This link makes whoever opens it the owner. It works once, until ${deps.clockTime(answer.expiresAt)} (30 minutes).`,
            );
            deps.out(`Do not paste it into chats or tickets. A new link: ${ENGINE_COMMAND} setup-link`);
            return;
        case 'owner-exists':
            deps.err(
                `${FAILED} This engine already has an owner. If you are the owner and lost every passkey, run \`${ENGINE_COMMAND} owner --reset\`.`,
            );
            return;
        case 'not-ready':
            deps.err(
                `${FAILED} Not ready for the setup link yet: waiting for ${gaps(answer.missing)}. \`${ENGINE_COMMAND} status\` shows each part.`,
            );
            return;
    }
}

/**
 * `setup-link [--no-wait] [--json]`: a fresh setup link that replaces the previous one, printed only when the address
 * works, and only to an interactive terminal unless `--json` asks for it. The link never goes to the log stream.
 */
export async function runSetupLinkCommand(command: SetupLinkCommand, deps: SetupLinkDeps): Promise<ExitCode> {
    if (!command.json && !deps.terminal) {
        deps.err(TERMINAL_ONLY);
        return EXIT_CODE.usage;
    }
    const obtained = await obtain(command.wait, deps);
    if (obtained === null) {
        deps.err(NOT_RUNNING);
        return EXIT_CODE.failed;
    }
    report(obtained, command.json, deps);
    return obtained.exitCode;
}

/**
 * `owner --reset`: after the operator types the first 8 characters of the engine ID (or passes `--yes`), every passkey
 * and session ends, agents and data stay, and a fresh setup link is printed under the same rules as `setup-link`.
 */
export async function runOwnerResetCommand(command: OwnerResetCommand, deps: SetupLinkDeps): Promise<ExitCode> {
    if (!command.json && !deps.terminal) {
        deps.err(TERMINAL_ONLY);
        return EXIT_CODE.usage;
    }
    const status = await deps.client.status();
    if (status === null) {
        deps.err(NOT_RUNNING);
        return EXIT_CODE.failed;
    }
    if (!command.yes) {
        deps.err(`Engine https://${status.hostname}`);
        const typed = await deps.ask(
            'This removes every passkey and signs out every session. Agents and data stay. Type the first 8 characters of the engine ID to continue: ',
        );
        if (typed === null) {
            deps.err('No terminal to confirm on: pass --yes to reset without the prompt.');
            return EXIT_CODE.usage;
        }
        if (typed.trim() !== status.engineId.slice(0, 8)) {
            deps.err(`${FAILED} Not confirmed; nothing changed.`);
            return EXIT_CODE.failed;
        }
    }
    const reset = await deps.client.resetOwner();
    if (reset === null) {
        deps.err(NOT_RUNNING);
        return EXIT_CODE.failed;
    }
    deps.err(
        `${DONE} Removed ${String(reset.passkeys)} passkeys and ended ${String(reset.sessions)} sessions. Agents and data stay.`,
    );
    return runSetupLinkCommand(command, deps);
}

/** `14:32` in the host's time zone, as the operator reads the clock next to the terminal. */
export function localClockTime(iso: string): string {
    const date = new Date(iso);
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}
