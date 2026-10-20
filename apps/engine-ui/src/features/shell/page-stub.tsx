import { EmptyState } from '@ptbk/ui';
import { Hourglass } from 'lucide-react';

import { m } from '../../paraglide/messages';
import { Page } from './page';

/** A registered section whose screen arrives with its feature task; it is guarded and navigable already. */
export function PageStub({ title }: { readonly title: string }) {
    return (
        <Page title={title}>
            <EmptyState icon={<Hourglass />} title={title} description={m.section_coming()} />
        </Page>
    );
}
