import type { ActivityBase, Activity as ActivityRecord, ActivityItem } from '@ptbk/engine-api';
import { CodeText, RelativeTime } from '@ptbk/ui';
import { Activity, CircleHelp, FileText, PlugZap, Server, Users, Zap } from 'lucide-react';
import { Component } from 'react';
import type { ReactNode } from 'react';

import { cx } from '../../../app/cx';
import type { ActivityRendererEntry, FeatureDefinition } from '../../../app/registry/feature';
import { m } from '../../../paraglide/messages';
import { ActivityLine } from '../../entities/activity-line';
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
    /** The visible features, whose `activityRenderers` draw the items they claim. */
    readonly features: readonly FeatureDefinition[];
    /** For a card that just arrived: slides in, or fades under reduced motion. */
    readonly enterClassName?: string;
}

/**
 * One feed item as a table-like row: its area icon, the line its feature's renderer draws (agent and entity chips,
 * outcome, facts) and the time at the end. Everything from the engine is text.
 */
export function ActivityCard({ item, features, enterClassName }: ActivityCardProps) {
    const base = item.kind === 'known' ? item.activity : item.base;
    const kind = activityKind(item);
    const resolved = resolveActivityRenderer(item, features);
    const fallback = <FallbackBody base={base} kind={kind} />;
    return (
        <li
            className={cx(
                'grid min-h-11 grid-cols-[1.25rem_minmax(0,1fr)_auto] items-start gap-x-3 py-2.5 sm:items-center',
                enterClassName,
            )}
        >
            <span className="flex h-6 items-center text-text-muted [&>svg]:size-4">{areaIcon(kind)}</span>
            <div className="min-w-0">
                {resolved.kind === 'renderer' ? (
                    <RendererBoundary fallback={fallback}>
                        <resolved.entry.component activity={resolved.activity} />
                    </RendererBoundary>
                ) : (
                    fallback
                )}
            </div>
            <RelativeTime
                value={new Date(base.at)}
                className="flex h-6 items-center text-xs whitespace-nowrap text-text-muted tabular-nums"
            />
        </li>
    );
}

/** What any item can show, however little the client understands it: its agent and raw kind, never its payload. */
function FallbackBody({ base, kind }: { readonly base: ActivityBase; readonly kind: string }) {
    return (
        <ActivityLine
            activity={base}
            description={
                <span className="text-text-muted">
                    {m.activity_generic()} <CodeText value={kind} />
                </span>
            }
        />
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
export function activitySummary(item: ActivityItem, features: readonly FeatureDefinition[]): string {
    const resolved = resolveActivityRenderer(item, features);
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
