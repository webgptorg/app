import { Card } from '@ptbk/ui';

import { m } from '../../../paraglide/messages';
import { useBrowser } from '../../core/browser';
import { useSession } from '../session/use-session';
import { CooldownBanner } from './cooldown-banner';
import { PasskeysCard } from './passkeys-card';
import { SessionsCard } from './sessions-card';

/** `/account`: the email, passkeys and sessions of the signed-in person. */
export function AccountPage() {
    const session = useSession();
    const { now } = useBrowser();
    return (
        <div className="flex flex-col gap-6">
            <h1 className="font-display text-2xl font-semibold">{m.account_title()}</h1>
            <CooldownBanner endsAt={session.user.recoveryCooldownEndsAt} now={now()} />
            <Card title={m.account_email_title()}>
                <p className="font-medium break-all">{session.user.email}</p>
                <p className="text-sm text-text-muted">{m.account_email_body()}</p>
            </Card>
            <PasskeysCard />
            <SessionsCard />
        </div>
    );
}
