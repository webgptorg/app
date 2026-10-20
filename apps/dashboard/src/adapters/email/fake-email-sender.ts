import type { EmailMessage, EmailSender } from '../../domain/ports/email-sender';

export interface FakeEmailSender extends EmailSender {
    /** Every message sent, oldest first. */
    readonly sent: readonly EmailMessage[];
    sentTo(address: string): readonly EmailMessage[];
}

/** Records instead of sending. Dev and tests only: the config refuses `adapters.email = 'fake'` outside dev. */
export function createFakeEmailSender(): FakeEmailSender {
    const sent: EmailMessage[] = [];
    return {
        sent,
        sentTo: (address) => sent.filter((message) => message.to === address),
        send(message, signal) {
            if (signal.aborted) {
                return Promise.reject(signal.reason as Error);
            }
            sent.push(message);
            return Promise.resolve();
        },
    };
}
