import { describe, expect, it } from 'vitest';

import type { EmailMessage } from '../../domain/ports/email-sender';
import { describeEmailSenderContract, TEST_EMAIL } from '../../testing/email-sender-contract';
import { createCloudflareEmailSender, type SendEmailBinding } from './cloudflare-email-sender';

function stubBinding(behaviour: 'ok' | 'fail' | 'hang' = 'ok') {
    const sent: Parameters<SendEmailBinding['send']>[0][] = [];
    const binding: SendEmailBinding = {
        send(builder) {
            sent.push(builder);
            switch (behaviour) {
                case 'ok':
                    return Promise.resolve({ messageId: 'm-1' });
                case 'fail':
                    return Promise.reject(new Error('provider down'));
                case 'hang':
                    return new Promise(() => undefined);
            }
        },
    };
    return { sent, binding };
}

const render = (message: EmailMessage) => ({ subject: `subject:${message.template}`, text: `text:${message.locale}` });

describeEmailSenderContract('Cloudflare (stub binding)', () =>
    createCloudflareEmailSender({ binding: stubBinding().binding, from: 'no-reply@ptbk.test', render }),
);

describe('Cloudflare EmailSender', () => {
    it('sends the rendered plain-text message from the configured address', async () => {
        const { sent, binding } = stubBinding();
        await createCloudflareEmailSender({ binding, from: 'no-reply@ptbk.test', render }).send(
            TEST_EMAIL,
            new AbortController().signal,
        );
        expect(sent).toEqual([
            { from: 'no-reply@ptbk.test', to: 'person@example.test', subject: 'subject:signup-link', text: 'text:cs' },
        ]);
    });

    it('passes a provider failure on', async () => {
        const sender = createCloudflareEmailSender({ binding: stubBinding('fail').binding, from: 'a@b.test', render });
        await expect(sender.send(TEST_EMAIL, new AbortController().signal)).rejects.toThrow('provider down');
    });

    it('stops waiting when the signal aborts', async () => {
        const controller = new AbortController();
        const sender = createCloudflareEmailSender({ binding: stubBinding('hang').binding, from: 'a@b.test', render });
        const pending = sender.send(TEST_EMAIL, controller.signal);
        controller.abort(new Error('timeout'));
        await expect(pending).rejects.toThrow('timeout');
    });
});
