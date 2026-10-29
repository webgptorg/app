import { Anchor, Card, SkipLink } from '@ptbk/ui';

import { m } from '../../../paraglide/messages';
import { PublicFooter, PublicHeader } from '../shell/public-frame';
import { AbuseContactLink } from './abuse-contact';

const MAIN_ID = 'main-content';
const SECURITY_TXT = '/.well-known/security.txt';

/**
 * `/abuse` (I-05): public, signed in or not. How to report an engine, and what we can and cannot see and do, so the
 * report carries what we need and nobody expects us to read engine traffic.
 */
export function AbusePage() {
    return (
        <div className="flex min-h-dvh flex-col bg-surface text-text">
            <SkipLink targetId={MAIN_ID} />
            <PublicHeader width="narrow" />
            <main
                id={MAIN_ID}
                tabIndex={-1}
                className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-8 outline-none"
            >
                <h1 className="font-display text-2xl font-semibold">{m.abuse_title()}</h1>
                <p>{m.abuse_intro()}</p>
                <Card title={m.abuse_report_title()}>
                    <div className="flex flex-col gap-3 text-sm">
                        <p>
                            {m.abuse_report_lead()} <AbuseContactLink />:
                        </p>
                        <ul className="list-disc pl-6">
                            <li>{m.abuse_report_item_address()}</li>
                            <li>{m.abuse_report_item_what()}</li>
                            <li>{m.abuse_report_item_evidence()}</li>
                        </ul>
                        <p>{m.abuse_report_response()}</p>
                    </div>
                </Card>
                <Card title={m.abuse_see_title()}>
                    <div className="flex flex-col gap-3 text-sm">
                        <p>{m.abuse_see_can()}</p>
                        <p>{m.abuse_see_cannot()}</p>
                    </div>
                </Card>
                <Card title={m.abuse_act_title()}>
                    <p className="text-sm">{m.abuse_act_body()}</p>
                </Card>
                <p className="text-sm text-text-muted">
                    {m.abuse_security()} <Anchor href={SECURITY_TXT}>{m.abuse_security_link()}</Anchor>.
                </p>
            </main>
            <PublicFooter width="narrow" />
        </div>
    );
}
