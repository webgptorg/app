import type { Activity as ActivityRecord, ActivityItem } from '@ptbk/engine-api';
import { CodeText, RelativeTime } from '@ptbk/ui';
import { Activity, CircleHelp, FileText, PlugZap, Server, Users, Zap } from 'lucide-react';
import { Component } from 'react';
import type { ReactNode } from 'react';

import { cx } from '../../../app/cx';
import { Link } from '../../../app/link';
import type { ActivityRendererEntry } from '../../../app/registry/feature';
import { m } from '../../../paraglide/messages';
import { activityKind } from './activity-feed-cache';
import { resolveActivityRenderer } from './resolve-activity-renderer';

/** A switch, not a lookup object: an engine's `constructor.x` must not find `Object.prototype.constructor`. */
function areaIcon(kind: string): ReactNode {
    const className = 'size-4';
    switch (kind.slice(0, kind.indexOf('.'))) {
        case 'run':
            return <Activity aria-hidden className={className} />;
        case 'file':
            return <FileText aria-hidden className={className} />;
        case 'trigger':
            return <Zap aria-hidden className={className} />;
        case 'integration':
            return <PlugZap aria-hidden className={className} />;
        case 'member':
            return <Users aria-hidden className={className} />;
        case 'engine':
            return <Server aria-hidden className={className} />;
        default:
            return <CircleHelp aria-hidden className={className} />;
    }
}

export interface ActivityCardProps {
    readonly item: ActivityItem;
    readonly renderers: readonly ActivityRendererEntry[];
    /** For a card that just arrived: slides in, or fades under reduced motion. */
    readonly enterClassName?: string;
}

/**
 * One feed item: its area icon, time and agent around the body its renderer draws. Everything from the engine is
 * text, and the only link out is built from the agent ID by the typed router.
 */
export function ActivityCard({ item, renderers, enterClassName }: ActivityCardProps) {
    const base = item.kind === 'known' ? item.activity : item.base;
    const kind = activityKind(item);
    const resolved = resolveActivityRenderer(item, renderers);
    const fallback = <FallbackBody kind={kind} />;
    return (
        <li className={cx('flex gap-3 py-3', enterClassName)}>
            <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-sunken text-text-muted">
                {areaIcon(kind)}
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-1">
                <p className="flex flex-wrap items-baseline gap-x-2 text-xs text-text-muted">
                    <RelativeTime value={new Date(base.at)} />
                    {base.agentId === null ? null : (
                        <Link to="/agents/$agentId" params={{ agentId: base.agentId }} className="break-all">
                            {base.agentName ?? m.activity_agent_unnamed()}
                        </Link>
                    )}
                </p>
                {resolved.kind === 'renderer' ? (
                    <RendererBoundary fallback={fallback}>
                        <resolved.entry.component activity={resolved.activity} />
                    </RendererBoundary>
                ) : (
                    fallback
                )}
            </div>
        </li>
    );
}

/** What any item can show, however little the client understands it: its raw kind, never its payload. */
function FallbackBody({ kind }: { readonly kind: string }) {
    return (
        <p className="text-sm">
            {m.activity_generic()} <CodeText value={kind} />
        </p>
    );
}

interface BoundaryState {
    readonly failed: boolean;
}

/** A renderer that throws costs its own card its body, not the feed. */
class RendererBoundary extends Component<
    { readonly fallback: ReactNode; readonly children: ReactNode },
    BoundaryState
> {
    override state: BoundaryState = { failed: false };

    static getDerivedStateFromError(): BoundaryState {
        return { failed: true };
    }

    override render() {
        return this.state.failed ? this.props.fallback : this.props.children;
    }
}

/** One line for an item, for the live region: the renderer's summary, or the raw kind. */
export function activitySummary(item: ActivityItem, renderers: readonly ActivityRendererEntry[]): string {
    const resolved = resolveActivityRenderer(item, renderers);
    const agent = (item.kind === 'known' ? item.activity : item.base).agentName;
    const line = resolved.kind === 'renderer' ? safeSummary(resolved.entry, resolved.activity) : activityKind(item);
    return agent === null ? line : m.activity_summary_with_agent({ agent, summary: line });
}

function safeSummary(entry: ActivityRendererEntry, activity: ActivityRecord): string {
    try {
        return entry.summary(activity);
    } catch {
        return activity.kind;
    }
}
