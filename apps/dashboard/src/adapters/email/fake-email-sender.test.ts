import { describe, expect, it } from 'vitest';

import { describeEmailSenderContract, TEST_EMAIL } from '../../testing/email-sender-contract';
import { createFakeEmailSender } from './fake-email-sender';

describeEmailSenderContract('fake', createFakeEmailSender);

describe('fake EmailSender', () => {
    it('records messages per recipient', async () => {
        const fake = createFakeEmailSender();
        await fake.send(TEST_EMAIL, new AbortController().signal);
        await fake.send({ ...TEST_EMAIL, to: 'other@example.test' }, new AbortController().signal);
        expect(fake.sent).toHaveLength(2);
        expect(fake.sentTo('person@example.test')).toEqual([TEST_EMAIL]);
    });
});
