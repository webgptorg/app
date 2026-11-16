import {
    File as AnyFile,
    FileArchive,
    FileCode,
    FileImage,
    FileMusic,
    FileSpreadsheet,
    FileText,
    FileVideoCamera,
} from 'lucide-react';

import { cx } from '../../app/cx';

const ARCHIVES = /(zip|gzip|x-tar|x-7z|x-rar|x-bzip)/;
const SHEETS = /(csv|spreadsheet|excel)/;
const CODE = /(json|xml|javascript|typescript|yaml|x-sh|x-python|html|css)/;
const DOCUMENTS = /(pdf|msword|wordprocessing|rtf|opendocument\.text)/;

type Family = 'image' | 'audio' | 'video' | 'archive' | 'sheet' | 'code' | 'text' | 'other';

/** A broad family from the content type the engine reports; anything unrecognised is a plain file. */
function familyOf(contentType: string): Family {
    const type = contentType.toLowerCase();
    if (type.startsWith('image/')) return 'image';
    if (type.startsWith('audio/')) return 'audio';
    if (type.startsWith('video/')) return 'video';
    if (ARCHIVES.test(type)) return 'archive';
    if (SHEETS.test(type)) return 'sheet';
    if (CODE.test(type)) return 'code';
    if (type.startsWith('text/') || DOCUMENTS.test(type)) return 'text';
    return 'other';
}

/** Decorative: the name and the type column say what the file is. */
export function FileTypeIcon({
    contentType,
    className,
}: {
    readonly contentType: string;
    readonly className?: string;
}) {
    const props = { 'aria-hidden': true, className: cx('size-4 shrink-0 text-text-muted', className) } as const;
    switch (familyOf(contentType)) {
        case 'image':
            return <FileImage {...props} />;
        case 'audio':
            return <FileMusic {...props} />;
        case 'video':
            return <FileVideoCamera {...props} />;
        case 'archive':
            return <FileArchive {...props} />;
        case 'sheet':
            return <FileSpreadsheet {...props} />;
        case 'code':
            return <FileCode {...props} />;
        case 'text':
            return <FileText {...props} />;
        case 'other':
            return <AnyFile {...props} />;
    }
}
