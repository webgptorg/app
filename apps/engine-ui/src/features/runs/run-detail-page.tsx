import { KNOWN_CAPABILITIES, RunId } from '@ptbk/engine-api';
import type { ReadRun, ReadRunDetail, TaskId, TriggerId } from '@ptbk/engine-api';
import { Banner, Card, CodeText, EmptyState, ErrorState, RelativeTime, Skeleton, useLocale } from '@ptbk/ui';
import { useQuery } from '@tanstack/react-query';
import { getRouteApi } from '@tanstack/react-router';
import { ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';

import { classifyApiError } from '../../app/api-errors';
import { useEngineApi } from '../../app/engine-api-context';
import { ButtonLink, Link } from '../../app/link';
import { isPageLevelFailure } from '../../app/list-errors';
import { useAllows } from '../../app/registry/use-visible-features';
import { m } from '../../paraglide/messages';
import { BackLink, Page } from '../shell/page';
import { NARROW_QUERY, useMediaQuery } from '../shell/use-media-query';
import { taskQueryOptions } from '../tasks/tasks-queries';
import { triggerQueryOptions } from '../triggers/triggers-queries';
import { DiffView } from './diff-view';
import { RunActions } from './run-actions';
import { finishedDurationMs, NotReported, RunCost, RunDuration, runTitle } from './run-format';
import { runSourceLabel } from './run-source';
import { RunStatusBadge } from './run-status';
import { StepsSection, ToolCallsSection } from './run-timeline';
import { runListQueryOptions, runQueryOptions } from './runs-queries';

const route = getRouteApi('/runs/$runId');

function isNotFound(error: unknown): boolean {
    const failure = classifyApiError(error);
    return failure.kind === 'problem' && failure.problem.status === 404;
}

/** One run: what started it, its steps, tool calls, usage, error and outputs, with cancel and retry where allowed. */
export function RunDetailPage() {
    const runId = RunId.safeParse(route.useParams().runId).data;
    return runId === undefined ? <RunNotFound /> : <LoadedRunDetail runId={runId} />;
}

function LoadedRunDetail({ runId }: { readonly runId: RunId }) {
    const run = useQuery({ ...runQueryOptions(useEngineApi(), runId), throwOnError: isPageLevelFailure });
    if (run.isPending) return <RunDetailSkeleton />;
    if (run.isError) {
        if (isNotFound(run.error)) return <RunNotFound />;
        return (
            <Page title={m.run_title_loading()}>
                <ErrorState
                    message={m.run_load_failed()}
                    onRetry={() => {
                        void run.refetch();
                    }}
                    retrying={run.isFetching}
                />
            </Page>
        );
    }
    return <RunDetail run={run.data} />;
}

function RunDetail({ run }: { readonly run: ReadRunDetail }) {
    const narrow = useMediaQuery(NARROW_QUERY);
    const retry = useRetryOf(run);
    const actions = <RunActions run={run} retried={retry !== null} />;
    const hasOutputs =
        run.outputs.messages.length > 0 || run.outputs.files.length > 0 || run.outputs.projectChanges.length > 0;
    return (
        <Page
            title={runTitle(run)}
            documentTitle={[runTitle(run), m.runs_title()]}
            back={<RunBackLink run={run} />}
            {...(narrow ? {} : { actions })}
        >
            <RunSummary run={run} />
            {run.error === null ? null : (
                <Banner tone="danger" title={runErrorTitle(run.error.code)}>
                    <span className="flex flex-col gap-1">
                        {/* The summary may quote what the agent read: text only. */}
                        <span className="break-words whitespace-pre-wrap">{run.error.summary}</span>
                        <span className="text-xs text-text-muted">
                            {m.run_error_code()} <span className="font-mono">{run.error.code}</span>
                        </span>
                        {retry === null ? null : (
                            <span>
                                {m.run_retried_as()}{' '}
                                <Link to="/runs/$runId" params={{ runId: retry.id }}>
                                    {m.run_retried_open()}
                                </Link>
                            </span>
                        )}
                    </span>
                </Banner>
            )}
            {run.progress === null ? null : <StepsSection run={run} progress={run.progress} />}
            {run.toolCalls.length === 0 ? null : <ToolCallsSection run={run} />}
            {hasOutputs ? <OutputsSection run={run} /> : null}
            {hasTokenUsage(run) ? <UsageSection run={run} /> : null}
            <RunDetails run={run} />
            {narrow ? (
                <div className="sticky bottom-0 z-10 -mx-4 border-t border-divider bg-raised px-4 py-3 empty:hidden">
                    {actions}
                </div>
            ) : null}
        </Page>
    );
}

/** Back to where the member came from: the agent's Runs tab when they opened the run there, else all runs. */
function RunBackLink({ run }: { readonly run: ReadRunDetail }) {
    const { from } = route.useSearch();
    if (from === 'agent') {
        return (
            <BackLink to="/agents/$agentId/runs" params={{ agentId: run.agentId }}>
                {m.run_back_to_agent_runs({ agent: run.agentName ?? run.agentId })}
            </BackLink>
        );
    }
    return <BackLink to="/runs">{m.run_back_to_runs()}</BackLink>;
}

// Codes are open slugs (the engine may add more); known ones get a plain title, the rest a generic one.
function runErrorTitle(code: string): string {
    switch (code) {
        case 'tool-error':
            return m.run_error_tool();
        case 'tool-timeout':
        case 'timeout':
            return m.run_error_timeout();
        case 'agent-unavailable':
            return m.run_error_agent_unavailable();
        default:
            return m.run_error_generic();
    }
}

/** Only the first page after the failed run is searched: a retry is queued right after it, so it is nearly always there. */
const RETRY_LOOKUP_LIMIT = 50;

/** The run that retried this failed one, if any; the contract has no reverse link, so it is looked up among later runs. */
function useRetryOf(run: ReadRunDetail): ReadRun | null {
    const params = { agentId: run.agentId, from: run.queuedAt, sort: 'queuedAt', limit: RETRY_LOOKUP_LIMIT } as const;
    const later = useQuery({ ...runListQueryOptions(useEngineApi(), params), enabled: run.status === 'failed' });
    return later.data?.items.find((candidate) => candidate.retryOf === run.id) ?? null;
}

function SummaryItem({ label, children }: { readonly label: string; readonly children: ReactNode }) {
    return (
        <div className="flex min-w-0 items-center">
            <dt className="sr-only">{label}</dt>
            <dd className="min-w-0 break-words">{children}</dd>
        </div>
    );
}

/** One quiet line under the title: what a member asks first. The rest waits in Details. */
function RunSummary({ run }: { readonly run: ReadRunDetail }) {
    const cost = run.usage?.cost ?? null;
    const showDuration = (run.status === 'running' && run.startedAt !== null) || finishedDurationMs(run) !== null;
    return (
        <dl className="-mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-text-muted">
            <SummaryItem label={m.run_fact_status()}>
                <RunStatusBadge status={run.status} cancelling={run.cancelRequestedAt !== null} />
            </SummaryItem>
            <SummaryItem label={m.run_fact_agent()}>
                <Link to="/agents/$agentId" params={{ agentId: run.agentId }}>
                    {run.agentName ?? run.agentId}
                </Link>
            </SummaryItem>
            <SummaryItem label={m.run_fact_source()}>
                <Source run={run} />
            </SummaryItem>
            <SummaryItem label={m.run_fact_queued()}>
                <RelativeTime value={new Date(run.queuedAt)} />
            </SummaryItem>
            {showDuration ? (
                <SummaryItem label={m.run_usage_duration()}>
                    <RunDuration run={run} />
                </SummaryItem>
            ) : null}
            {cost === null ? null : (
                <SummaryItem label={m.run_usage_cost()}>
                    <RunCost cost={cost} />
                </SummaryItem>
            )}
            {run.taskId === null ? null : (
                <SummaryItem label={m.run_fact_task()}>
                    <RunTask taskId={run.taskId} />
                </SummaryItem>
            )}
            {run.retryOf === null ? null : (
                <SummaryItem label={m.run_fact_retry_of()}>
                    <Link to="/runs/$runId" params={{ runId: run.retryOf }}>
                        {m.run_fact_retry_of_link()}
                    </Link>
                </SummaryItem>
            )}
        </dl>
    );
}

/** The task this run worked on, by name; without `tasks@1` there is nothing to link to. */
function RunTask({ taskId }: { readonly taskId: TaskId }) {
    const allowed = useAllows({ capability: KNOWN_CAPABILITIES.tasks, permission: 'tasks.read' });
    const task = useQuery({ ...taskQueryOptions(useEngineApi(), taskId), enabled: allowed });
    if (!allowed) return null;
    return (
        <Link to="/tasks/$taskId" params={{ taskId }}>
            {task.data?.name ?? m.run_fact_task()}
        </Link>
    );
}

function Source({ run }: { readonly run: ReadRunDetail }) {
    const label = runSourceLabel(run.source);
    if (run.chatId !== null) {
        return (
            <Link to="/agents/$agentId/chat/$chatId" params={{ agentId: run.agentId, chatId: run.chatId }}>
                {run.source === 'web' ? label : m.run_source_chat({ source: label })}
            </Link>
        );
    }
    if (run.triggerId !== null) return <TriggerSource label={label} triggerId={run.triggerId} />;
    return <span>{label}</span>;
}

/** "Schedule · Weekly report", linking the trigger by name; never its ID. */
function TriggerSource({ label, triggerId }: { readonly label: string; readonly triggerId: TriggerId }) {
    const allowed = useAllows({ capability: KNOWN_CAPABILITIES.triggers, permission: 'triggers.read' });
    const trigger = useQuery({ ...triggerQueryOptions(useEngineApi(), triggerId), enabled: allowed });
    let name: ReactNode = null;
    if (trigger.data !== undefined) {
        name = (
            <Link to="/triggers/$triggerId" params={{ triggerId }}>
                {trigger.data.name}
            </Link>
        );
    } else if (trigger.isError && isNotFound(trigger.error)) {
        name = m.run_source_trigger_deleted();
    }
    if (name === null) return <span>{label}</span>;
    return (
        <span>
            {label} · {name}
        </span>
    );
}

function Fact({ label, children }: { readonly label: string; readonly children: ReactNode }) {
    return (
        <div className="flex min-w-0 flex-col gap-0.5">
            <dt className="text-xs text-text-muted">{label}</dt>
            <dd className="min-w-0 break-words">{children}</dd>
        </div>
    );
}

function DateTime({ at }: { readonly at: string | null }) {
    const locale = useLocale();
    if (at === null) return <span className="text-text-muted">{m.run_value_not_yet()}</span>;
    return <time dateTime={at}>{locale.formatDateTime(new Date(at))}</time>;
}

/** Exact times and how the run ran: for whoever investigates, folded away for everyone else. */
function RunDetails({ run }: { readonly run: ReadRunDetail }) {
    return (
        <details className="group rounded-surface border border-divider">
            <summary className="flex cursor-pointer items-center gap-2 rounded-surface px-4 py-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-focus">
                <ChevronRight aria-hidden className="size-4 transition-transform group-open:rotate-90" />
                {m.run_details_title()}
            </summary>
            <dl className="grid grid-cols-2 gap-4 border-t border-divider p-4 text-sm sm:grid-cols-3">
                <Fact label={m.run_fact_queued()}>
                    <DateTime at={run.queuedAt} />
                </Fact>
                <Fact label={m.run_fact_started()}>
                    <DateTime at={run.startedAt} />
                </Fact>
                <Fact label={m.run_fact_completed()}>
                    <DateTime at={run.completedAt} />
                </Fact>
                <Fact label={m.run_fact_attempt()}>{run.attemptCount}</Fact>
                <Fact label={m.run_fact_runner()}>{run.runner ?? <NotReported />}</Fact>
                <Fact label={m.run_fact_model()}>{run.model ?? <NotReported />}</Fact>
            </dl>
        </details>
    );
}

function hasTokenUsage(run: ReadRunDetail): boolean {
    return (
        (run.usage?.inputTokens !== null && run.usage?.inputTokens !== undefined) ||
        (run.usage?.outputTokens !== null && run.usage?.outputTokens !== undefined)
    );
}

/** Tokens only: duration and cost already sit in the summary line. */
function UsageSection({ run }: { readonly run: ReadRunDetail }) {
    const locale = useLocale();
    const tokens = (value: number | null | undefined) =>
        value === null || value === undefined ? (
            <NotReported />
        ) : (
            <span className="tabular-nums">{locale.formatNumber(value)}</span>
        );
    return (
        <Card title={m.run_usage_title()}>
            <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                <Fact label={m.run_usage_input_tokens()}>{tokens(run.usage?.inputTokens)}</Fact>
                <Fact label={m.run_usage_output_tokens()}>{tokens(run.usage?.outputTokens)}</Fact>
            </dl>
        </Card>
    );
}

function OutputsSection({ run }: { readonly run: ReadRunDetail }) {
    const { messages, files, fileNames, projectChanges } = run.outputs;
    const filesLinked = useAllows({ capability: KNOWN_CAPABILITIES.files, permission: 'files.read' });
    return (
        <Card title={m.run_outputs_title()}>
            <div className="flex flex-col gap-6">
                {messages.length === 0 ? null : (
                    <section className="flex flex-col gap-2">
                        <h3 className="font-medium">{m.run_outputs_messages()}</h3>
                        <ul className="flex flex-col gap-1">
                            {messages.map((message) => (
                                <li key={message.messageId}>
                                    <Link
                                        to="/agents/$agentId/chat/$chatId"
                                        params={{ agentId: run.agentId, chatId: message.chatId }}
                                    >
                                        {m.run_outputs_message_link()}
                                    </Link>
                                </li>
                            ))}
                        </ul>
                    </section>
                )}
                {files.length === 0 ? null : (
                    <section className="flex flex-col gap-2">
                        <h3 className="font-medium">{m.run_outputs_files()}</h3>
                        <ul className="flex flex-col gap-1 text-sm">
                            {files.map((fileId, index) => (
                                <li key={fileId} className="break-words">
                                    {filesLinked ? (
                                        <Link to="/files" search={{ file: fileId }}>
                                            {fileNames[index] ?? fileId}
                                        </Link>
                                    ) : (
                                        (fileNames[index] ?? fileId)
                                    )}
                                </li>
                            ))}
                        </ul>
                    </section>
                )}
                {projectChanges.map((change, index) => (
                    <ProjectChangeView key={`${change.commitHash}-${String(index)}`} change={change} />
                ))}
            </div>
        </Card>
    );
}

function ProjectChangeView({ change }: { readonly change: ReadRunDetail['outputs']['projectChanges'][number] }) {
    const locale = useLocale();
    return (
        <section className="flex flex-col gap-3">
            <h3 className="font-medium break-words">{m.run_project_title({ project: change.projectName })}</h3>
            <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="text-text-muted">{m.run_project_commit()}</span>
                <CodeText value={change.commitHash} copyable copyLabel={m.run_project_copy_commit()} />
            </div>
            <div className="overflow-x-auto">
                <table className="w-full text-sm">
                    <caption className="sr-only">
                        {m.run_project_files_caption({ project: change.projectName })}
                    </caption>
                    <thead>
                        <tr className="text-left text-text-muted">
                            <th scope="col" className="py-1 pr-3 font-medium">
                                {m.run_project_file_path()}
                            </th>
                            <th scope="col" className="py-1 pr-3 text-right font-medium">
                                {m.run_project_file_insertions()}
                            </th>
                            <th scope="col" className="py-1 text-right font-medium">
                                {m.run_project_file_deletions()}
                            </th>
                        </tr>
                    </thead>
                    <tbody>
                        {change.changedFiles.map((file) => (
                            <tr key={file.path} className="border-t border-divider">
                                <td className="py-1 pr-3 font-mono text-xs break-all">{file.path}</td>
                                <td className="py-1 pr-3 text-right tabular-nums">
                                    {m.run_project_insertions({ count: locale.formatNumber(file.insertions) })}
                                </td>
                                <td className="py-1 text-right tabular-nums">
                                    {m.run_project_deletions({ count: locale.formatNumber(file.deletions) })}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            <DiffView
                diff={change.diff}
                truncated={change.diffTruncated}
                label={m.run_project_diff_label({ project: change.projectName })}
            />
        </section>
    );
}

function RunNotFound() {
    return (
        <Page title={m.run_not_found_title()}>
            <EmptyState
                title={m.run_not_found_title()}
                description={m.run_not_found_body()}
                action={<ButtonLink to="/runs">{m.run_back_to_runs()}</ButtonLink>}
            />
        </Page>
    );
}

/** Shaped like the header and the sections, so nothing jumps when the run arrives. */
export function RunDetailSkeleton() {
    return (
        <section aria-busy="true" aria-label={m.run_title_loading()} className="flex flex-col gap-6">
            <Skeleton shape="text" className="h-8 w-2/3" />
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
                {Array.from({ length: 8 }, (_, index) => (
                    <Skeleton key={index} shape="text" className="h-10 w-full" />
                ))}
            </div>
            {Array.from({ length: 4 }, (_, index) => (
                <Skeleton key={index} shape="block" className="h-40 w-full" />
            ))}
        </section>
    );
}
