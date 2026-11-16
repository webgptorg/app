import { FileName } from '@ptbk/engine-api';
import type { FileId } from '@ptbk/engine-api';
import { Button, IconButton, Spinner } from '@ptbk/ui';
import { FileText, Paperclip, X } from 'lucide-react';
import { useId, useRef, useState } from 'react';

import { useEngineApi } from '../../app/engine-api-context';
import { m } from '../../paraglide/messages';

export interface UploadedFile {
    readonly id: FileId;
    readonly name: string;
}

interface OnboardingUploadProps {
    readonly maxFiles: number;
    readonly files: readonly UploadedFile[];
    readonly onChange: (files: readonly UploadedFile[]) => void;
    readonly onBusyChange: (busy: boolean) => void;
}

const UPLOAD_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Files for the engine during setup, uploaded through `files@1` (purpose `upload`) before the answer names them. The
 * engine enforces its limits; a file it refuses is reported by name and left out.
 */
export function OnboardingUpload({ maxFiles, files, onChange, onBusyChange }: OnboardingUploadProps) {
    const engineApi = useEngineApi();
    const input = useRef<HTMLInputElement>(null);
    const inputId = useId();
    const [uploading, setUploading] = useState(0);
    const [refused, setRefused] = useState<readonly string[]>([]);

    const add = async (chosen: readonly File[]) => {
        const room = Math.max(0, maxFiles - files.length);
        const batch = chosen.slice(0, room);
        setRefused(chosen.slice(room).map(({ name }) => name));
        setUploading(batch.length);
        onBusyChange(batch.length > 0);
        const uploaded: UploadedFile[] = [];
        const failed: string[] = [];
        for (const file of batch) {
            const name = FileName.safeParse(file.name);
            const response = name.success
                ? await engineApi.files
                      .upload({ file, name: name.data, purpose: 'upload' }, AbortSignal.timeout(UPLOAD_TIMEOUT_MS))
                      .catch(() => null)
                : null;
            if (response?.kind === 'ok') uploaded.push({ id: response.data.id, name: response.data.name });
            else failed.push(file.name);
            setUploading((count) => count - 1);
        }
        setRefused((earlier) => [...earlier, ...failed]);
        onChange([...files, ...uploaded]);
        onBusyChange(false);
    };

    return (
        <div className="flex flex-col gap-2">
            <input
                ref={input}
                id={inputId}
                type="file"
                multiple
                className="sr-only"
                tabIndex={-1}
                aria-hidden
                onChange={(event) => {
                    const chosen = [...(event.target.files ?? [])];
                    event.target.value = '';
                    void add(chosen);
                }}
            />
            <div className="flex flex-wrap items-center gap-3">
                <Button
                    size="sm"
                    disabled={uploading > 0 || files.length >= maxFiles}
                    onClick={() => {
                        input.current?.click();
                    }}
                >
                    <Paperclip aria-hidden className="size-4" />
                    {m.onboarding_files_add()}
                </Button>
                {uploading > 0 ? (
                    <span className="flex items-center gap-2 text-sm text-text-muted" role="status">
                        <Spinner size="sm" announce={false} />
                        {m.onboarding_files_uploading({ count: uploading })}
                    </span>
                ) : null}
            </div>
            {files.length === 0 ? null : (
                // Added files as quiet chips, like attachments waiting in a composer.
                <ul aria-label={m.onboarding_files_list()} className="flex flex-wrap gap-1.5">
                    {files.map((file) => (
                        <li
                            key={file.id}
                            className="flex max-w-full min-w-0 items-center gap-1.5 rounded-control bg-neutral-soft py-0.5 ps-2 pe-0.5 text-sm"
                        >
                            <FileText aria-hidden className="size-3.5 shrink-0 text-text-muted" />
                            {/* File names are the member's own, but still text nodes. */}
                            <span className="min-w-0 truncate font-mono text-xs">{file.name}</span>
                            <IconButton
                                variant="ghost"
                                size="sm"
                                label={m.onboarding_files_remove({ name: file.name })}
                                icon={<X aria-hidden className="size-3.5" />}
                                onClick={() => {
                                    onChange(files.filter(({ id }) => id !== file.id));
                                }}
                            />
                        </li>
                    ))}
                </ul>
            )}
            {refused.length === 0 ? null : (
                <p className="text-xs text-danger">{m.onboarding_files_refused({ names: refused.join(', ') })}</p>
            )}
        </div>
    );
}
