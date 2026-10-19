import { m } from '../../../paraglide/messages';

export function HomePage() {
    return (
        <section className="space-y-2">
            <h1 className="text-2xl font-semibold">{m.home_title()}</h1>
            <p className="text-neutral-600">{m.home_intro()}</p>
        </section>
    );
}
