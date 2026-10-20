import { describe, expect, it } from 'vitest';

import type { EmailMessage, EmailSender } from '../domain/ports/email-sender';

export const TEST_EMAIL: EmailMessage = {
    template: 'signup-link',
    to: 'person@example.test',
    locale: 'cs',
    link: 'https://app.ptbk.test/signup#token',
};

/** The EmailSender contract every adapter meets. */
export function describeEmailSenderContract(name: string, make: () => EmailSender): void {
    describe(`EmailSender contract: ${name}`, () => {
        it('resolves once the message is accepted', async () => {
            await expect(make().send(TEST_EMAIL, new AbortController().signal)).resolves.toBeUndefined();
        });

        it('rejects when the signal is already aborted', async () => {
            const controller = new AbortController();
            controller.abort(new Error('timeout'));
            await expect(make().send(TEST_EMAIL, controller.signal)).rejects.toThrow('timeout');
        });
    });
}
