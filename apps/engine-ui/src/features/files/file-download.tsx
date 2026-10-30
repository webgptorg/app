import type { FileId, FileMetadata, FileVersionId } from '@ptbk/engine-api';
import { Button, buttonClassName } from '@ptbk/ui';
import type { ButtonSize } from '@ptbk/ui';
import { useQueryClient } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { useRef, useState } from 'react';
import type { MouseEvent } from 'react';

import { useEngineApi } from '../../app/engine-api-context';
import { m } from '../../paraglide/messages';
import { fileContentPath } from './file-content';
import { fileKeys } from './files-keys';

const CHECK_TIMEOUT_MS = 15_000;

type Refusal = 'infected' | 'gone' | 'failed';

function refusalMessage(refusal: Refusal): string {
    switch (refusal) {
        case 'infected':
            return m.files_download_infected();
        case 'gone':
            return m.files_download_gone();
        case 'failed':
            return m.files_download_check_failed();
    }
}

/**
 * The download decision, kept in one place: the file is fetched as plain metadata first, and only a file that is not
 * infected now is downloaded. A scan can finish between loading the page and clicking, and the content route would
 * then answer 409, which a plain link cannot show; this check is what turns that into a message.
 */
function useDownloadCheck() {
    const engineApi = useEngineApi();
    const queryClient = useQueryClient();
    return async (fileId: FileId): Promise<Refusal | null> => {
        try {
            const response = await engineApi.files.get(fileId, AbortSignal.timeout(CHECK_TIMEOUT_MS));
            if (response.kind === 'problem') return response.problem.status === 404 ? 'gone' : 'failed';
            queryClient.setQueryData(fileKeys.detail(fileId), response.data);
            return response.data.scan?.status === 'infected' ? 'infected' : null;
        } catch {
            return 'failed';
        }
    };
}

export interface FileDownloadProps {
    readonly file: Pick<FileMetadata, 'id' | 'name' | 'scan'>;
    readonly versionId?: FileVersionId;
    /** The accessible name; defaults to "Download <file name>". */
    readonly label?: string;
    readonly size?: ButtonSize;
}

/**
 * A plain same-origin link to the content route, which the engine serves as an attachment, so the browser saves the
 * file and nothing of it reaches this page. The engine's `Content-Disposition` carries no name, so the link names the
 * file; without it every download would be saved as "content" (browsers sanitise the name). Disabled with the reason for an infected file.
 */
export function FileDownload({ file, versionId, label, size = 'sm' }: FileDownloadProps) {
    const check = useDownloadCheck();
    const confirmed = useRef(false);
    const [checking, setChecking] = useState(false);
    const [refusal, setRefusal] = useState<Refusal | null>(null);
    const name = label ?? m.files_download_named({ name: file.name });

    if (file.scan?.status === 'infected') {
        return (
            <span className="flex flex-col items-start gap-1">
                <Button size={size} disabled disabledReason={m.files_download_infected()} aria-label={name}>
                    <Download aria-hidden className="size-4" />
                    {m.files_download()}
                </Button>
                <span className="text-sm text-text-muted">{m.files_download_infected()}</span>
            </span>
        );
    }

    const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
        if (confirmed.current) {
            confirmed.current = false;
            return;
        }
        event.preventDefault();
        if (checking) return;
        const anchor = event.currentTarget;
        setChecking(true);
        setRefusal(null);
        void check(file.id).then((outcome) => {
            setChecking(false);
            setRefusal(outcome);
            if (outcome !== null) return;
            confirmed.current = true;
            anchor.click();
        });
    };

    return (
        <span className="flex flex-col items-start gap-1">
            <a
                href={fileContentPath(file.id, versionId)}
                download={file.name}
                aria-label={name}
                aria-busy={checking || undefined}
                className={buttonClassName('secondary', size)}
                onClick={onClick}
            >
                <Download aria-hidden className="size-4" />
                {m.files_download()}
            </a>
            <span role="status" className="text-sm text-danger empty:hidden">
                {refusal === null ? null : refusalMessage(refusal)}
            </span>
        </span>
    );
}
