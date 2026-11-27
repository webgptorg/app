import type { EngineId, Hostname } from '@ptbk/protocol';
import { deriveEngineFingerprint } from '@ptbk/protocol';

import type { Logger } from '../domain/logger';
import type { AddressGap } from '../domain/onboarding/address';
import type { Say } from './operator-lines';
import { DONE, WAITING, identityLines } from './operator-lines';
import { ENGINE_COMMAND } from './registration-messages';

export interface StartupProgressDeps {
    readonly logger: Logger;
    /** The operator's terminal when the engine runs in one; null when stdout is a log that others may read. */
    readonly say: Say | null;
    readonly engineId: EngineId;
    readonly hostname: Hostname;
    /**
     * Who shows the setup link once the address first works without an owner, asked at that moment (a `connect` may
     * have claimed it by then): `engine` has `show` print it after "Ready", `connect` leaves it to that command, and
     * `operator` (the default) points at `setup-link`.
     */
    readonly setupLink?: {
        readonly shownBy: () => SetupLinkShownBy;
        readonly show: () => void;
    };
}

export type SetupLinkShownBy = 'engine' | 'connect' | 'operator';

export const NO_OWNER_LINE = `No owner yet. Run \`${ENGINE_COMMAND} setup-link\` on this host to get the setup link.`;
/**
 * Said when the owner came through the pairing tab rather than the printed link, so a claim by compromised dashboard
 * code is never silent on the host (ADR 0023).
 */
export const HANDOFF_SETUP_LINE = `Owner set up from the dashboard tab that paired this engine. If that was not you, run \`${ENGINE_COMMAND} owner --reset\`.`;

/** The engine's state as far as the owner's next step is concerned. */
export interface OnboardingState {
    readonly addressGaps: readonly AddressGap[];
    readonly ownerSetUp: boolean;
}

/**
 * The first-start output contract (installation.md): identity, registration, relays, certificate, UI bundle, owner
 * and ready, each as a log event and, on a terminal, as a line. Registration, certificate and UI bundle already log
 * their own events where they happen; this adds the rest. Nothing said here is secret: the setup link is only ever
 * printed by `setup-link`, `connect` and, on its own terminal, the engine (`setupLink`).
 */
export interface StartupProgress {
    identity(): void;
    /** Linked at start or by `connect`; `already` when the registration was stored. */
    linked(already: boolean): void;
    /** Started without a registration: waiting for `connect`. */
    notLinked(): void;
    relays(connected: number, total: number): void;
    certificate(notAfter: string): void;
    ui(version: string): void;
    /** On every change of the address or the owner: says owner and ready once the address works, then changes. */
    onboarding(state: OnboardingState): void;
}

function day(iso: string): string {
    return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

export function createStartupProgress(deps: StartupProgressDeps): StartupProgress {
    const { logger, hostname } = deps;
    const say = deps.say ?? ((): void => undefined);
    let lastRelays: string | null = null;
    let ready = false;
    let ownerSetUp: boolean | null = null;

    function owner(setUp: boolean, shownBy: SetupLinkShownBy): void {
        if (setUp) {
            logger.info('owner.set-up', {});
            say(`${DONE} Owner set up`);
            return;
        }
        logger.info('owner.none', { command: `${ENGINE_COMMAND} setup-link` });
        switch (shownBy) {
            case 'engine':
                return;
            case 'connect':
                say(
                    `No owner yet. \`${ENGINE_COMMAND} connect\` shows the setup link where it runs; \`${ENGINE_COMMAND} setup-link\` makes a new one.`,
                );
                return;
            case 'operator':
                say(NO_OWNER_LINE);
                return;
        }
    }

    return {
        identity() {
            logger.info('engine.identity', {
                engineId: deps.engineId,
                hostname,
                fingerprint: deriveEngineFingerprint(deps.engineId).formatted,
            });
            say(`${DONE} Engine key ready`);
            for (const line of identityLines(deps.engineId, hostname)) say(line);
        },
        linked(already) {
            say(`${DONE} ${already ? 'Already linked' : 'Linked'} to your Promptbook account`);
        },
        notLinked() {
            logger.warn('engine.not-linked', { command: `${ENGINE_COMMAND} connect --link <code>` });
            say(
                `${WAITING} Not linked. To reach this engine from anywhere, create an account at app.ptbk.io and run \`${ENGINE_COMMAND} connect --link <code>\`.`,
            );
        },
        relays(connected, total) {
            const key = `${String(connected)}/${String(total)}`;
            if (key === lastRelays) return;
            lastRelays = key;
            logger.info('relays.connected', { connected, total });
            say(`${connected > 0 ? DONE : WAITING} Connected to ${String(connected)} of ${String(total)} relays`);
        },
        certificate(notAfter) {
            say(`${DONE} Certificate for ${hostname}, valid until ${day(notAfter)}`);
        },
        ui(version) {
            say(`${DONE} Engine UI ${version} verified`);
        },
        onboarding(state) {
            if (!ready) {
                if (state.addressGaps.length > 0) return;
                ready = true;
                ownerSetUp = state.ownerSetUp;
                const shownBy = deps.setupLink?.shownBy() ?? 'operator';
                owner(state.ownerSetUp, shownBy);
                logger.info('engine.ready', { url: `https://${hostname}/` });
                say(`Ready: https://${hostname}/`);
                if (!state.ownerSetUp && shownBy === 'engine') deps.setupLink?.show();
                return;
            }
            if (state.ownerSetUp !== ownerSetUp) {
                ownerSetUp = state.ownerSetUp;
                // Later changes come from `owner --reset` (which prints its own link) or a new passkey: never re-issue.
                owner(state.ownerSetUp, 'operator');
            }
        },
    };
}
