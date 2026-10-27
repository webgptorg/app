import type { OperatorStatus } from '../domain/onboarding/operator-api';
import type { ExitCode } from './exit-codes';
import { EXIT_CODE } from './exit-codes';
import type { Say } from './operator-lines';
import { ENGINE_COMMAND } from './registration-messages';

export const STATUS_USAGE = 'usage: status [--json]';

export class StatusUsageError extends Error {
    constructor() {
        super(STATUS_USAGE);
        this.name = 'StatusUsageError';
    }
}

export function parseStatusCommand(args: readonly string[]): { readonly json: boolean } {
    if (args.length === 0) return { json: false };
    if (args.length === 1 && args[0] === '--json') return { json: true };
    throw new StatusUsageError();
}

const GAP_WORDS: Readonly<Record<OperatorStatus['addressGaps'][number], string>> = {
    relay: 'a relay connection',
    certificate: 'a certificate',
    'setup-page': 'the setup page',
};

function minute(iso: string): string {
    return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

function heartbeatLine(heartbeat: OperatorStatus['heartbeat']): string {
    if (heartbeat === null) return 'none sent yet';
    const sent = `last sent ${minute(heartbeat.sentAt)}`;
    const skew = heartbeat.clockSkewS === null ? '' : `; clock ${String(heartbeat.clockSkewS)} s off the platform's`;
    switch (heartbeat.answer) {
        case null:
            return `${sent}, no answer yet`;
        case 'accepted':
            return `${sent}, accepted${skew}`;
        case 'refused':
            return `${sent}, refused (${String(heartbeat.status)})${skew}`;
        case 'unavailable':
            return `${sent}, the platform did not answer`;
    }
}

/** One screen for the operator: everything `status --json` says, as aligned lines. */
export function statusLines(status: OperatorStatus): readonly string[] {
    const connected = status.relays.filter((relay) => relay.state === 'connected').length;
    const lines = [
        `Engine        ${status.engineId}`,
        `Address       https://${status.hostname}`,
        `Fingerprint   ${status.fingerprint}`,
        `Version       ${status.version}`,
        status.mode === 'local'
            ? `Link          not linked: run \`${ENGINE_COMMAND} connect --link <code>\``
            : `Link          ${status.dashboardUrl === null ? 'no dashboard (development)' : `linked to ${status.dashboardUrl}`}`,
        `Relays        ${String(connected)} of ${String(status.relays.length)} connected`,
        ...status.relays.map((relay) => `                ${relay.relay}   ${relay.state}`),
        `Certificate   ${status.certificate === null ? 'none yet' : `valid until ${minute(status.certificate.notAfter)}`}`,
        `UI bundle     ${status.ui === null ? 'none yet' : status.ui.version}`,
        `Updates       ${status.updatePolicy}`,
        `Owner         ${status.ownerSetUp ? 'set up' : `not yet: run \`${ENGINE_COMMAND} setup-link\``}`,
        `Heartbeat     ${heartbeatLine(status.heartbeat)}`,
    ];
    if (status.addressGaps.length > 0) {
        lines.push(`Address       waiting for ${status.addressGaps.map((gap) => GAP_WORDS[gap]).join(' and ')}`);
    }
    return lines;
}

/**
 * `status [--json]`: asks the running engine over its operator channel. Nothing in it is secret, so it may be printed
 * anywhere; an engine that does not answer exits 1 with what to do.
 */
export async function runStatusCommand(
    command: { readonly json: boolean },
    deps: { readonly status: () => Promise<OperatorStatus | null>; readonly out: Say; readonly err: Say },
): Promise<ExitCode> {
    const status = await deps.status();
    if (status === null) {
        if (command.json) deps.out(JSON.stringify({ running: false }));
        deps.err('The engine is not running from this PTBK_DATA_DIR. Start it, then run status again.');
        return EXIT_CODE.failed;
    }
    if (command.json) deps.out(JSON.stringify({ running: true, ...status }));
    else for (const line of statusLines(status)) deps.out(line);
    return EXIT_CODE.ok;
}
