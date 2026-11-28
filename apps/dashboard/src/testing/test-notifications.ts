import { createFakeEmailSender } from '../adapters/email/fake-email-sender';
import { createFakeClock } from '../adapters/fake-clock';
import { cryptoRandom } from '../adapters/crypto-random';
import { createMemoryLogger } from '../adapters/memory-logger';
import { newOrgId, newUserId } from '../domain/ids';
import { runNotificationDelivery } from '../domain/notifications/deliver-notifications';
import { createNotifications } from '../domain/notifications/notifications';
import type { UnsubscribeClaims } from '../domain/notifications/unsubscribe-tokens';
import type { EmailMessage, EmailSender } from '../domain/ports/email-sender';
import { createFakeRecipientDirectory, type FakePerson } from './fake-recipient-directory';
import { createMemoryNotificationStore } from './memory-notification-store';
import { createTestEngine } from './test-engine';

export const NOTIFICATION_START_MS = 1_800_000_000_000;

/**
 * One organization with a project and its people, on the in-memory store and fake directory: the owner linked it, the
 * admin and a member have approved access, another member waits, one is outside its team, and one admin has no
 * verified address.
 */
export async function createNotificationScenario() {
    const orgId = newOrgId(cryptoRandom);
    const { engineId } = await createTestEngine();
    const person = (
        orgRole: FakePerson['orgRole'],
        access: 'approved' | 'waiting' | null,
        extra: Partial<FakePerson> = {},
    ): FakePerson => {
        const userId = newUserId(cryptoRandom);
        return {
            userId,
            email: `${userId}@example.test`,
            orgRole,
            ...(access === null ? {} : { projects: { [engineId]: access } }),
            ...extra,
        };
    };
    const owner = person('owner', null, { locale: 'cs' });
    const admin = person('admin', 'approved');
    const member = person('member', 'approved');
    const waiting = person('member', 'waiting');
    const outsider = person('member', null);
    const unverified = person('admin', 'approved', { emailVerified: false });
    const store = createMemoryNotificationStore();
    const directory = createFakeRecipientDirectory();
    directory.setPeople(orgId, [owner, admin, member, waiting, outsider, unverified]);
    directory.setOrgName(orgId, 'Acme');
    directory.setProject(orgId, engineId, {
        label: 'Marketing site',
        hostname: 'm.engines.ptbk.test',
        linker: owner.userId,
    });
    directory.setRequesters(engineId, ['jana@example.test']);
    const clock = createFakeClock(NOTIFICATION_START_MS);
    const notifications = createNotifications({ store, directory, clock, random: cryptoRandom });
    const outbox = createFakeEmailSender();
    const logger = createMemoryLogger();
    const signed: UnsubscribeClaims[] = [];
    const deliver = (at = clock.nowMs(), email: EmailSender = outbox) =>
        runNotificationDelivery(
            {
                store,
                directory,
                email,
                tokens: {
                    sign: (claims) => {
                        signed.push(claims);
                        return Promise.resolve(`tok-${String(signed.length)}`);
                    },
                    verify: () => Promise.resolve(null),
                },
                logger,
                dashboardOrigin: 'https://app.ptbk.test',
            },
            at,
            new AbortController().signal,
        );
    const open = () => store.rows.filter((row) => row.closedAt === null);
    return {
        orgId,
        engineId,
        target: { orgId, engineId },
        owner,
        admin,
        member,
        waiting,
        outsider,
        unverified,
        store,
        directory,
        clock,
        notifications,
        outbox,
        logger,
        signed,
        deliver,
        open,
        rowOf: (userId: string, kind?: string) =>
            open().find((row) => row.userId === userId && (kind === undefined || row.kind === kind)),
        emailsTo: (who: FakePerson) =>
            outbox.sentTo(who.email) as readonly Extract<EmailMessage, { readonly template: 'notifications' }>[],
    };
}
