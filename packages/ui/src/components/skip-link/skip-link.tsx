import { useUiMessages } from '../../i18n/ui-provider';

export interface SkipLinkProps {
    /** The id of the main content, which should be focusable (`tabIndex={-1}`). */
    readonly targetId: string;
}

/** The first stop for keyboard users: hidden until focused, then jumps past the navigation. */
export function SkipLink({ targetId }: SkipLinkProps) {
    const messages = useUiMessages();
    return (
        <a
            href={`#${targetId}`}
            className="sr-only rounded-control bg-(--skip-link-bg) px-4 py-2 text-sm font-medium text-(--skip-link-text) shadow-overlay focus:not-sr-only focus:fixed focus:start-4 focus:top-4 focus:z-50"
        >
            {messages.skipToContent()}
        </a>
    );
}
