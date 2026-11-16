import { Anchor, Section, SkipLink } from '@ptbk/ui';

import { m } from '../../../paraglide/messages';
import { Page } from '../shell/page';
import { PublicFooter, PublicHeader } from '../shell/public-frame';
import { AbuseContactLink } from './abuse-contact';

const MAIN_ID = 'main-content';
const SECURITY_TXT = '/.well-known/security.txt';
const PROSE = 'flex max-w-[65ch] flex-col gap-3 text-sm leading-relaxed';

/**
 * `/abuse` (I-05): public, signed in or not. How to report an engine, and what we can and cannot see and do, so the
 * report carries what we need and nobody expects us to read engine traffic.
 */
export function AbusePage() {
    return (
        <div className="flex min-h-dvh flex-col bg-surface text-text">
            <SkipLink targetId={MAIN_ID} />
            <PublicHeader width="narrow" />
            <main id={MAIN_ID} tabIndex={-1} className="mx-auto w-full max-w-3xl px-4 py-8 outline-none">
                <Page title={m.abuse_title()} description={m.abuse_intro()}>
                    <Section title={m.abuse_report_title()} divided={false}>
                        <div className={PROSE}>
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
                    </Section>
                    <Section title={m.abuse_see_title()}>
                        <div className={PROSE}>
                            <p>{m.abuse_see_can()}</p>
                            <p>{m.abuse_see_cannot()}</p>
                        </div>
                    </Section>
                    <Section title={m.abuse_act_title()}>
                        <p className={PROSE}>{m.abuse_act_body()}</p>
                    </Section>
                    <p className="max-w-[65ch] text-sm text-text-muted">
                        {m.abuse_security()} <Anchor href={SECURITY_TXT}>{m.abuse_security_link()}</Anchor>.
                    </p>
                </Page>
            </main>
            <PublicFooter width="narrow" />
        </div>
    );
}
