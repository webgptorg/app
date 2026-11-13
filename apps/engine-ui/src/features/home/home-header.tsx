import { Plus } from 'lucide-react';

import { ButtonLink } from '../../app/link';
import { m } from '../../paraglide/messages';
import { useCurrentMember } from '../session/use-current-member';
import { useAllows } from '../../app/registry/use-visible-features';
import { AGENT_WIZARD_REQUIREMENT } from '../agent-wizard/agent-wizard-feature';
import { useDocumentTitle } from '../shell/document-title';

export type DayPart = 'morning' | 'afternoon' | 'evening';

/** Morning from 5:00, afternoon from 12:00, evening from 18:00 until 5:00, in the browser's time zone. */
export function dayPart(hour: number): DayPart {
    if (hour >= 5 && hour < 12) return 'morning';
    if (hour >= 12 && hour < 18) return 'afternoon';
    return 'evening';
}

export function greeting(name: string, part: DayPart): string {
    switch (part) {
        case 'morning':
            return m.home_greeting_morning({ name });
        case 'afternoon':
            return m.home_greeting_afternoon({ name });
        case 'evening':
            return m.home_greeting_evening({ name });
    }
}

/** The home's one heading, greeting the member by name, and a quiet "New agent" for those who may create one. */
export function HomeHeader({ now }: { readonly now: Date }) {
    const { displayName } = useCurrentMember();
    const canCreate = useAllows(AGENT_WIZARD_REQUIREMENT);
    useDocumentTitle(m.nav_home());
    return (
        <header className="flex flex-wrap items-center justify-between gap-3">
            <h1 id="page-title" className="text-2xl font-semibold tracking-display break-words md:text-3xl">
                {greeting(displayName, dayPart(now.getHours()))}
            </h1>
            {canCreate ? (
                <ButtonLink to="/agents/new" variant="ghost" size="sm">
                    <Plus aria-hidden className="size-4" />
                    {m.agents_new()}
                </ButtonLink>
            ) : null}
        </header>
    );
}
