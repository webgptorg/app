import { FILE_PURPOSES } from '@ptbk/engine-api';
import type { AgentId } from '@ptbk/engine-api';
import { Card, RelativeTime, useLocale } from '@ptbk/ui';
import { useSuspenseQuery } from '@tanstack/react-query';
import { ShieldAlert } from 'lucide-react';

import { useEngineApi } from '../../app/engine-api-context';
import { Link } from '../../app/link';
import { m } from '../../paraglide/messages';
import { usePermissions } from '../session/use-permissions';
import { purposeLabel } from './file-labels';
import { fileListQueryOptions, fileStatsQueryOptions } from './files-queries';
import { SCAN_PROBLEMS } from './files-search';

const LATEST_OUTPUTS = 3;

/**
 * "Knowledge at a glance" on the agent overview: counts by purpose, scan problems and the newest outputs. An agent
 * without files gets one line that says what files are for, instead of a grid of zeros.
 */
export function KnowledgeCard({ agentId }: { readonly agentId: AgentId }) {
    const engineApi = useEngineApi();
    const formatters = useLocale();
    const { data: stats } = useSuspenseQuery(fileStatsQueryOptions(engineApi, { agentId }));
    const { data: outputs } = useSuspenseQuery(
        fileListQueryOptions(engineApi, { agentId, purpose: 'output', sort: '-createdAt', limit: LATEST_OUTPUTS }),
    );
    const canAdd = usePermissions().can('files.write');
    const problems = stats.byScan.infected + stats.byScan.failed;
    const purposes = FILE_PURPOSES.filter((purpose) => stats.byPurpose[purpose] > 0);
    if (purposes.length === 0) {
        return (
            <Card title={m.files_card_title()}>
                <p className="text-sm text-text-muted">
                    {m.files_card_empty()}{' '}
                    {canAdd ? (
                        <Link to="/agents/$agentId/files" params={{ agentId }}>
                            {m.files_card_add()}
                        </Link>
                    ) : null}
                </p>
            </Card>
        );
    }
    return (
        <Card
            title={m.files_card_title()}
            actions={
                <Link to="/agents/$agentId/files" params={{ agentId }}>
                    {m.files_card_all()}
                </Link>
            }
        >
            <div className="flex flex-col gap-4">
                <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                    {purposes.map((purpose) => (
                        <div key={purpose} className="flex flex-col gap-1">
                            <dt className="text-xs font-medium text-text-muted">{purposeLabel(purpose)}</dt>
                            <dd className="text-xl font-semibold">
                                {formatters.formatNumber(stats.byPurpose[purpose])}
                            </dd>
                        </div>
                    ))}
                </dl>
                {problems === 0 ? (
                    <p className="text-sm text-text-muted">{m.files_card_no_problems()}</p>
                ) : (
                    <p className="flex items-center gap-2 text-sm">
                        <ShieldAlert aria-hidden className="size-4 text-danger" />
                        <Link to="/files" search={{ agentId, scan: SCAN_PROBLEMS }} variant="standalone">
                            {m.files_card_problems({ count: problems })}
                        </Link>
                    </p>
                )}
                {outputs.items.length === 0 ? null : (
                    <div className="flex flex-col gap-2">
                        <h3 className="text-sm font-semibold">{m.files_card_latest_outputs()}</h3>
                        <ul className="flex flex-col gap-2">
                            {outputs.items.map((file) => (
                                <li key={file.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                                    <Link
                                        to="/agents/$agentId/files"
                                        params={{ agentId }}
                                        search={{ file: file.id }}
                                        variant="standalone"
                                        className="min-w-0 break-all"
                                    >
                                        {file.name}
                                    </Link>
                                    <RelativeTime value={new Date(file.createdAt)} />
                                </li>
                            ))}
                        </ul>
                    </div>
                )}
            </div>
        </Card>
    );
}
