import { acceptsFile, FileName } from '@ptbk/engine-api';
import type { AgentId, FileUploadPolicy } from '@ptbk/engine-api';
import { Button, ErrorState, Skeleton, useLocale } from '@ptbk/ui';
import { Upload, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { DragEvent } from 'react';

import { cx } from '../../app/cx';
import { m } from '../../paraglide/messages';
import { formatBytes } from './file-size';
import { useUploadPolicy } from './files-queries';
import { useFileMutations } from './use-file-mutations';

type ItemState =
    | { readonly kind: 'too-large' }
    | { readonly kind: 'wrong-type' }
    | { readonly kind: 'bad-name' }
    | { readonly kind: 'uploading'; readonly loaded: number; readonly total: number }
    | { readonly kind: 'done' }
    | { readonly kind: 'failed'; readonly reason: 'too-large' | 'wrong-type' | 'other' }
    | { readonly kind: 'cancelled' };

interface Item {
    readonly key: number;
    readonly name: string;
    readonly size: number;
    readonly state: ItemState;
}

/** Why the engine refused, by problem code; the policy was checked first, so these mean it changed meanwhile. */
function failureReason(code: string): 'too-large' | 'wrong-type' | 'other' {
    if (code === 'payload-too-large') return 'too-large';
    if (code === 'unsupported-media-type') return 'wrong-type';
    return 'other';
}

/** A file the policy refuses is never sent: the member learns why before any byte leaves the browser. */
function refusalOf(file: File, policy: FileUploadPolicy): ItemState | null {
    if (file.size > policy.maxBytes) return { kind: 'too-large' };
    if (!acceptsFile(policy.accept, file)) return { kind: 'wrong-type' };
    if (!FileName.safeParse(file.name).success) return { kind: 'bad-name' };
    return null;
}

function stateText(state: ItemState, maxSize: string): string {
    switch (state.kind) {
        case 'too-large':
            return m.files_upload_too_large({ max: maxSize });
        case 'wrong-type':
            return m.files_upload_wrong_type();
        case 'bad-name':
            return m.files_upload_bad_name();
        case 'uploading':
            return m.files_upload_uploading();
        case 'done':
            return m.files_upload_done();
        case 'failed':
            switch (state.reason) {
                case 'too-large':
                    return m.files_upload_too_large({ max: maxSize });
                case 'wrong-type':
                    return m.files_upload_wrong_type();
                case 'other':
                    return m.files_upload_failed();
            }
            break;
        case 'cancelled':
            return m.files_upload_cancelled();
    }
}

/** What did not reach the engine, in the danger colour; the words say it too. */
const FAILED: ReadonlySet<ItemState['kind']> = new Set(['too-large', 'wrong-type', 'bad-name', 'failed']);

export interface KnowledgeUploadProps {
    /** The agent the knowledge belongs to. */
    readonly agentId: AgentId;
}

/**
 * Adds knowledge files to an agent: a quiet one-line drop area with a keyboard-operable file picker, the engine's size and type limits
 * checked before anything is sent, and per-file progress with cancel. Only names and sizes are ever shown; file
 * content is never read into the page. Shared with the create-agent wizard (U-04).
 */
export function KnowledgeUpload({ agentId }: KnowledgeUploadProps) {
    const formatters = useLocale();
    const policy = useUploadPolicy('knowledge');
    const { upload } = useFileMutations();
    const inputRef = useRef<HTMLInputElement>(null);
    const hintId = useId();
    const nextKey = useRef(0);
    const controllers = useRef(new Map<number, AbortController>());
    const [items, setItems] = useState<readonly Item[]>([]);
    const [dragging, setDragging] = useState(false);

    useEffect(() => {
        const live = controllers.current;
        return () => {
            for (const controller of live.values()) controller.abort();
        };
    }, []);

    if (policy.isPending) return <Skeleton shape="block" className="h-12 w-full" />;
    if (policy.isError) {
        return (
            <ErrorState
                message={m.files_upload_policy_failed()}
                onRetry={() => {
                    void policy.refetch();
                }}
            />
        );
    }
    const limits = policy.data;
    const maxSize = formatBytes(formatters, limits.maxBytes);

    const setState = (key: number, state: ItemState) => {
        setItems((current) => current.map((item) => (item.key === key ? { ...item, state } : item)));
    };

    const start = (file: File, key: number) => {
        const controller = new AbortController();
        controllers.current.set(key, controller);
        void upload({
            file,
            purpose: 'knowledge',
            agentId,
            signal: controller.signal,
            onProgress: ({ loadedBytes, totalBytes }) => {
                setState(key, { kind: 'uploading', loaded: loadedBytes, total: totalBytes });
            },
        })
            .then((response) => {
                setState(
                    key,
                    response.kind === 'ok'
                        ? { kind: 'done' }
                        : { kind: 'failed', reason: failureReason(response.problem.code) },
                );
            })
            .catch(() => {
                setState(key, controller.signal.aborted ? { kind: 'cancelled' } : { kind: 'failed', reason: 'other' });
            })
            .finally(() => {
                controllers.current.delete(key);
            });
    };

    const add = (files: readonly File[]) => {
        const added = files.map((file) => {
            const key = nextKey.current++;
            const refusal = refusalOf(file, limits);
            return {
                file,
                item: {
                    key,
                    name: file.name,
                    size: file.size,
                    state: refusal ?? { kind: 'uploading', loaded: 0, total: file.size },
                } satisfies Item,
            };
        });
        setItems((current) => [...current, ...added.map(({ item }) => item)]);
        for (const { file, item } of added) if (item.state.kind === 'uploading') start(file, item.key);
    };

    const onDrop = (event: DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        setDragging(false);
        add([...event.dataTransfer.files]);
    };

    const accept = limits.accept.join(',');
    return (
        <div className="flex flex-col gap-2">
            <div
                className={cx(
                    'flex min-h-12 flex-wrap items-center gap-x-3 gap-y-1 rounded-control border border-dashed px-3 py-2 text-sm',
                    'motion-safe:transition-colors motion-safe:duration-(--motion-state)',
                    dragging ? 'border-text-muted bg-selected' : 'border-divider',
                )}
                onDragOver={(event) => {
                    event.preventDefault();
                    setDragging(true);
                }}
                onDragLeave={() => {
                    setDragging(false);
                }}
                onDrop={onDrop}
            >
                <Upload aria-hidden className="size-4 shrink-0 text-text-muted" />
                <p className="text-text-muted">{m.files_upload_drop()}</p>
                <Button
                    size="sm"
                    aria-describedby={hintId}
                    onClick={() => {
                        inputRef.current?.click();
                    }}
                >
                    {m.files_upload_choose()}
                </Button>
                <input
                    ref={inputRef}
                    type="file"
                    multiple
                    hidden
                    {...(accept === '' ? {} : { accept })}
                    onChange={(event) => {
                        add([...(event.target.files ?? [])]);
                        event.target.value = '';
                    }}
                />
                <p id={hintId} className="text-xs text-text-subtle sm:ms-auto">
                    {limits.accept.length === 0
                        ? m.files_upload_limits_any({ max: maxSize })
                        : m.files_upload_limits({ max: maxSize, types: limits.accept.join(', ') })}
                </p>
            </div>
            {items.length === 0 ? null : (
                <ul aria-label={m.files_upload_list()} className="flex flex-col divide-y divide-hairline">
                    {items.map((item) => (
                        <li key={item.key} className="flex flex-col gap-1.5 py-2">
                            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                                <span className="min-w-0 flex-1 font-medium break-all">{item.name}</span>
                                <span className="text-xs text-text-muted tabular-nums">
                                    {formatBytes(formatters, item.size)}
                                </span>
                                <span
                                    role="status"
                                    className={cx(
                                        'text-xs',
                                        FAILED.has(item.state.kind) ? 'text-danger' : 'text-text-muted',
                                    )}
                                >
                                    {stateText(item.state, maxSize)}
                                </span>
                                {item.state.kind === 'uploading' ? (
                                    <Button
                                        size="sm"
                                        variant="ghost"
                                        aria-label={m.files_upload_cancel_named({ name: item.name })}
                                        onClick={() => {
                                            controllers.current.get(item.key)?.abort();
                                        }}
                                    >
                                        <X aria-hidden className="size-4" />
                                        {m.files_upload_cancel()}
                                    </Button>
                                ) : null}
                            </div>
                            {item.state.kind === 'uploading' ? (
                                <progress
                                    className="h-1 w-full"
                                    max={Math.max(item.state.total, 1)}
                                    value={item.state.loaded}
                                    aria-label={m.files_upload_progress_named({ name: item.name })}
                                />
                            ) : null}
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
