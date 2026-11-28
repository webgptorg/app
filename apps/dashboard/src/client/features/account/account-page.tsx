import { Section } from '@ptbk/ui';
import { lazy, Suspense } from 'react';

import { m } from '../../../paraglide/messages';
import { useBrowser } from '../../core/browser';
import { useSession } from '../session/use-session';
import { Page } from '../shell/page';
import { CooldownBanner } from './cooldown-banner';
import { PasskeysCard } from './passkeys-card';
import { SessionsCard } from './sessions-card';

/** Its own chunk: every kind's copy and the Combobox would push the account route past its budget. */
const NotificationSettings = lazy(async () => ({
    default: (await import('../notifications/notification-settings')).NotificationSettings,
}));

/** `/account`: the email, passkeys, sessions and notification settings of the signed-in person. */
export function AccountPage() {
    const session = useSession();
    const { now } = useBrowser();
    return (
        <Page title={m.account_title()}>
            <CooldownBanner endsAt={session.user.recoveryCooldownEndsAt} now={now()} />
            <Section title={m.account_email_title()} description={m.account_email_body()} divided={false}>
                <p className="font-medium break-all">{session.user.email}</p>
            </Section>
            <PasskeysCard />
            <SessionsCard />
            <Suspense fallback={null}>
                <NotificationSettings />
            </Suspense>
        </Page>
    );
}
