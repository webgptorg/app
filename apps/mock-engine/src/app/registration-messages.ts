import type { RegistrationOutcome, UnavailableReason } from '../domain/registration/register';
import type { RegistrationRetry } from '../domain/registration/register-with-retry';
import type { ExitCode } from './exit-codes';
import { EXIT_CODE } from './exit-codes';

/** How the operator runs this engine's commands; the real engine's guide writes `promptbook-engine`. */
export const ENGINE_COMMAND = 'mock-engine';

export function registrationExitCode(outcome: RegistrationOutcome): ExitCode {
    switch (outcome.kind) {
        case 'registered':
        case 'already-registered':
            return EXIT_CODE.ok;
        case 'unavailable':
            return EXIT_CODE.unreachable;
        case 'refused-response':
            return EXIT_CODE.answerRefused;
        case 'rejected':
            switch (outcome.reason) {
                case 'invalid-link-code':
                    return EXIT_CODE.linkCodeRefused;
                case 'engine-exists':
                case 'engine-suspended':
                    return EXIT_CODE.identityRefused;
                case 'engine-limit':
                case 'not-entitled':
                    return EXIT_CODE.plan;
                case 'bad-signature':
                    return EXIT_CODE.answerRefused;
            }
    }
}

const UNAVAILABLE_KIND: Readonly<Record<UnavailableReason, string>> = {
    'no-answer': 'no answer',
    'error-status': 'error answer',
    'rate-limited': 'too many attempts',
    'unknown-code': 'unexpected answer',
};

const ANSWER_REFUSED =
    "The platform's answer did not match this engine. Not linked. This is a bug or an attack; report it with the time.";

/**
 * The sentence the terminal shows for an outcome: what happened and the one next step (installation.md's table).
 * The mock has no `reset --identity`, so a refused identity points to an empty data directory instead.
 */
export function registrationSentence(outcome: RegistrationOutcome): string {
    switch (outcome.kind) {
        case 'registered':
            return 'Linked to your Promptbook account';
        case 'already-registered':
            return 'Already linked to your Promptbook account';
        case 'unavailable':
            return `Cannot reach the Promptbook platform (${UNAVAILABLE_KIND[outcome.reason]}). Check the network and any proxy, then run \`${ENGINE_COMMAND} connect --link\` again with the same link; it stays valid for 30 days.`;
        case 'refused-response':
            return ANSWER_REFUSED;
        case 'rejected':
            switch (outcome.reason) {
                case 'invalid-link-code':
                    return `The link code was not accepted. Codes work once and expire after 30 days. Create a new one at app.ptbk.io, then run \`${ENGINE_COMMAND} connect --link <new code>\`.`;
                case 'engine-exists':
                    return 'This engine is already linked to another Promptbook organisation. Sign in to that account, or give this engine a new identity by starting it with an empty PTBK_DATA_DIR.';
                case 'engine-suspended':
                    return 'This engine identity was revoked or suspended and cannot be linked again. Give it a new identity by starting it with an empty PTBK_DATA_DIR.';
                case 'engine-limit':
                case 'not-entitled':
                    return 'Your Promptbook plan does not allow another engine. Check Billing at app.ptbk.io.';
                case 'bad-signature':
                    return ANSWER_REFUSED;
            }
    }
}

export function formatDelay(ms: number): string {
    const seconds = Math.max(1, Math.round(ms / 1000));
    return seconds < 90 ? `${String(seconds)} s` : `${String(Math.round(seconds / 60))} min`;
}

export function retrySentence(retry: RegistrationRetry): string {
    if (retry.reason === 'rate-limited') return `The platform is busy; retrying in ${formatDelay(retry.delayMs)}.`;
    return `Cannot reach the Promptbook platform (${UNAVAILABLE_KIND[retry.reason]}). Retrying in ${formatDelay(retry.delayMs)}; check outbound HTTPS and proxy settings if this persists.`;
}
