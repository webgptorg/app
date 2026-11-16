import { m } from '../../../paraglide/messages';

const SECTIONS = [
    { id: 'data', title: () => m.trust_data_title(), body: () => m.trust_data_body() },
    { id: 'relay', title: () => m.trust_relay_title(), body: () => m.trust_relay_body() },
    { id: 'app', title: () => m.trust_app_title(), body: () => m.trust_app_body() },
    { id: 'link', title: () => m.trust_link_title(), body: () => m.trust_link_body() },
    { id: 'owner', title: () => m.trust_owner_title(), body: () => m.trust_owner_body() },
    { id: 'fingerprint', title: () => m.trust_fingerprint_title(), body: () => m.trust_fingerprint_body() },
    { id: 'account', title: () => m.trust_account_title(), body: () => m.trust_account_body() },
] as const;

/**
 * The precise version of what the other screens only hint at, so they can stay with plain next steps (DASH-14).
 */
export function TrustExplanation() {
    return (
        <div className="flex flex-col gap-5">
            <p className="text-base text-text-muted">{m.trust_intro()}</p>
            {SECTIONS.map((section) => (
                <section key={section.id} className="flex flex-col gap-1" data-trust-section={section.id}>
                    <h2 className="font-semibold">{section.title()}</h2>
                    <p className="text-sm">{section.body()}</p>
                </section>
            ))}
        </div>
    );
}
