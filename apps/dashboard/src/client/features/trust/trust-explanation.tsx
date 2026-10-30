import { m } from '../../../paraglide/messages';

const SECTIONS = [
    { id: 'data', title: () => m.trust_data_title(), body: () => m.trust_data_body() },
    { id: 'relay', title: () => m.trust_relay_title(), body: () => m.trust_relay_body() },
    { id: 'app', title: () => m.trust_app_title(), body: () => m.trust_app_body() },
    { id: 'link', title: () => m.trust_link_title(), body: () => m.trust_link_body() },
    { id: 'owner', title: () => m.trust_owner_title(), body: () => m.trust_owner_body() },
    { id: 'account', title: () => m.trust_account_title(), body: () => m.trust_account_body() },
] as const;

/**
 * The precise version of what the other screens only hint at, so they can stay with plain next steps (DASH-14). One
 * text for the public page and for any in-place explanation, so the two never drift apart.
 */
export function TrustExplanation(props: { readonly headingLevel: 2 | 3 }) {
    const Heading = props.headingLevel === 2 ? 'h2' : 'h3';
    return (
        <div className="flex flex-col gap-5">
            <p>{m.trust_intro()}</p>
            {SECTIONS.map((section) => (
                <section key={section.id} className="flex flex-col gap-1" data-trust-section={section.id}>
                    <Heading className="font-semibold">{section.title()}</Heading>
                    <p className="text-sm">{section.body()}</p>
                </section>
            ))}
        </div>
    );
}
