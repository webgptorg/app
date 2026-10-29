import { KNOWN_CAPABILITIES } from '@ptbk/engine-api';
import type { AgentId } from '@ptbk/engine-api';
import { Skeleton } from '@ptbk/ui';
import { Files } from 'lucide-react';
import { lazy, Suspense } from 'react';

import { AGENT_TABS, defineFeature } from '../../app/registry/feature';
import type { Attention } from '../../app/registry/feature';
import { m } from '../../paraglide/messages';
import { FileActivityItem, fileActivitySummary } from './file-activity';
import { useFileStats } from './files-queries';
import { SCAN_PROBLEMS } from './files-search';
import { useFileEventSync } from './use-file-event-sync';

const LazyKnowledgeCard = lazy(() => import('./knowledge-card').then((module) => ({ default: module.KnowledgeCard })));

/** The card's code loads with the agent page that shows it, not with the app. */
function KnowledgeOverviewCard({ agentId }: { readonly agentId: AgentId }) {
    return (
        <Suspense fallback={<Skeleton shape="block" className="h-48 w-full" />}>
            <LazyKnowledgeCard agentId={agentId} />
        </Suspense>
    );
}

function useScanProblemsAttention(): Attention {
    const stats = useFileStats({});
    const count = stats.data === undefined ? 0 : stats.data.byScan.infected + stats.data.byScan.failed;
    return { count, to: '/files', search: { scan: SCAN_PROBLEMS }, pending: stats.data === undefined };
}

/**
 * Files (`files@1`): every agent's knowledge and the files agents produce, with scan status and versions (U-10).
 * Content is never shown, only metadata and, for clean raster images, a preview.
 */
export const filesFeature = defineFeature({
    id: 'files',
    requires: { capability: KNOWN_CAPABILITIES.files, permission: 'files.read' },
    nav: { group: 'resources', order: 10, label: m.nav_files, icon: Files, to: '/files' },
    agentTabs: [{ ...AGENT_TABS.files, label: m.agent_tab_files, to: '/agents/$agentId/files' }],
    agentOverviewCards: [{ id: 'files.knowledge', order: 20, component: KnowledgeOverviewCard }],
    activityRenderers: [{ kind: 'file.*', versions: [1], component: FileActivityItem, summary: fileActivitySummary }],
    attention: {
        id: 'files.scan-problems',
        useAttention: useScanProblemsAttention,
        label: (count) => m.files_attention_scan({ count }),
    },
    eventSync: { useEventSync: useFileEventSync },
    commands: [
        { id: 'files.open', label: m.command_go_to_files, keywords: () => [m.nav_files()], to: '/files' },
        {
            id: 'files.upload-knowledge',
            label: m.files_upload_knowledge,
            keywords: () => [m.nav_files(), m.files_section_knowledge()],
            to: '/files',
            requires: { permission: 'files.write' },
        },
    ],
});
