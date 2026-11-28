import type { AgentSource } from '@ptbk/engine-api';
import { Banner, Button, ErrorState, Section, Skeleton } from '@ptbk/ui';
import { useQuery } from '@tanstack/react-query';

import { useEngineApi } from '../../app/engine-api-context';
import { m } from '../../paraglide/messages';
import { useAgentIdParam } from '../agents/agent-detail-route';
import { agentSourceQueryOptions } from './book-queries';
import { ModelSettings } from './model-settings';
import { useBookWorkspace } from './use-book-workspace';

function ModelForm({ initial }: { initial: AgentSource }) {
    const { draft, change, canWrite, dirty, save, saveDraft, conflict, reload } = useBookWorkspace(initial);
    return (
        <div className="grid gap-3">
            <ModelSettings source={draft} editable={canWrite} onChange={change} />
            {conflict !== null && (
                <Banner
                    tone="warning"
                    title={m.book_conflict_title()}
                    action={
                        <Button size="sm" onClick={reload}>
                            {m.book_conflict_reload()}
                        </Button>
                    }
                >
                    {m.book_conflict_body()}
                </Banner>
            )}
            {canWrite ? (
                <div className="flex items-center gap-3">
                    <Button
                        size="sm"
                        variant="primary"
                        disabled={!dirty}
                        loading={save.isPending}
                        onClick={() => void saveDraft()}
                    >
                        {m.book_save()}
                    </Button>
                    <span role="status" className="text-xs text-text-muted">
                        {dirty ? m.book_unsaved() : m.book_all_saved()}
                    </span>
                </div>
            ) : (
                <p className="text-xs text-text-muted">{m.book_read_only()}</p>
            )}
        </div>
    );
}

export function AgentBookModelSettings() {
    const agentId = useAgentIdParam();
    const source = useQuery(agentSourceQueryOptions(useEngineApi(), agentId));
    return (
        <Section title={m.model_settings_title()}>
            {source.isPending ? (
                <Skeleton shape="block" className="h-12 w-full" />
            ) : source.isError ? (
                <ErrorState
                    message={m.book_load_error()}
                    onRetry={() => void source.refetch()}
                    retrying={source.isFetching}
                />
            ) : (
                <ModelForm key={agentId} initial={source.data} />
            )}
        </Section>
    );
}
