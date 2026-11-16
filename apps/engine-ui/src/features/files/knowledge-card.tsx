import { FILE_PURPOSES } from '@ptbk/engine-api';
import type { AgentId } from '@ptbk/engine-api';
import { STATUS_TINT_CLASSES, useLocale } from '@ptbk/ui';
import { useSuspenseQuery } from '@tanstack/react-query';
import { FileText, ShieldAlert } from 'lucide-react';

import { cx } from '../../app/cx';
import { useEngineApi } from '../../app/engine-api-context';
import { Link } from '../../app/link';
import { m } from '../../paraglide/messages';
import { OverviewRow, OverviewRows, OverviewSection, overviewLinkClassName } from '../agents/overview-parts';
import { EntityChip } from '../entities/entity-chip';
import { purposeLabel } from './file-labels';
import { fileListQueryOptions, fileStatsQueryOptions } from './files-queries';
import { SCAN_PROBLEMS } from './files-search';
import { useFileScanning } from './use-file-scanning';

const LATEST_OUTPUTS = 3;

/**
 * The agent's files at a glance on its overview: counts by purpose, scan problems on a soft surface (they need
 * someone) and the newest outputs as rows. An agent with no files at all has no section.
 */
export function KnowledgeCard({ agentId }: { readonly agentId: AgentId }) {
    const engineApi = useEngineApi();
    const formatters = useLocale();
    const { data: stats } = useSuspenseQuery(fileStatsQueryOptions(engineApi, { agentId }));
    const { data: outputs } = useSuspenseQuery(
        fileListQueryOptions(engineApi, { agentId, purpose: 'output', sort: '-createdAt', limit: LATEST_OUTPUTS }),
    );
    const scanning = useFileScanning();
    const problems = scanning ? stats.byScan.infected + stats.byScan.failed : 0;
    const total = FILE_PURPOSES.reduce((sum, purpose) => sum + stats.byPurpose[purpose], 0);
    if (total === 0 && problems === 0) return null;
    return (
        <OverviewSection
            title={m.files_card_title()}
            all={
                <Link
                    to="/agents/$agentId/files"
                    params={{ agentId }}
                    variant="standalone"
                    className={overviewLinkClassName}
                >
                    {m.files_card_all()}
                </Link>
            }
        >
            <dl className="flex flex-wrap gap-x-8 gap-y-3">
                {FILE_PURPOSES.map((purpose) => (
                    <div key={purpose} className="flex flex-col gap-0.5">
                        <dt className="text-xs text-text-muted">{purposeLabel(purpose)}</dt>
                        <dd
                            className={cx(
                                'text-lg font-semibold tabular-nums',
                                stats.byPurpose[purpose] === 0 && 'text-text-muted',
                            )}
                        >
                            {formatters.formatNumber(stats.byPurpose[purpose])}
                        </dd>
                    </div>
                ))}
            </dl>
            {problems === 0 ? null : (
                <p className={cx('soft-surface flex items-center gap-2 px-3 py-2 text-sm', STATUS_TINT_CLASSES.danger)}>
                    <ShieldAlert aria-hidden className="size-4 shrink-0 text-danger" />
                    <Link to="/files" search={{ agentId, scan: SCAN_PROBLEMS }} variant="standalone">
                        {m.files_card_problems({ count: problems })}
                    </Link>
                </p>
            )}
            {outputs.items.length === 0 ? null : (
                <div className="flex flex-col gap-1">
                    <h3 className="text-xs font-medium text-text-muted">{m.files_card_latest_outputs()}</h3>
                    <OverviewRows>
                        {outputs.items.map((file) => (
                            <OverviewRow key={file.id} lead={<FileText aria-hidden />} at={file.createdAt}>
                                <EntityChip kind="file" id={file.id} name={file.name} />
                            </OverviewRow>
                        ))}
                    </OverviewRows>
                </div>
            )}
        </OverviewSection>
    );
}
