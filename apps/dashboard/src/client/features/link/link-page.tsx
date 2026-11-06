import { CopyButton, SkipLink } from '@ptbk/ui';
import { LinkCode, formatLinkUrl } from '@ptbk/protocol';
import { useLocation } from '@tanstack/react-router';

import { m } from '../../../paraglide/messages';
import { useBrowser } from '../../core/browser';
import { PublicFooter, PublicHeader } from '../shell/public-frame';

const MAIN_ID = 'main-content';

/** The command for this address, or null when it carries no valid code (or the dashboard runs on plain http). */
function connectCommand(origin: string, hash: string): string | null {
    const code = LinkCode.safeParse(hash.startsWith('#') ? hash.slice(1) : hash);
    if (!code.success || !origin.startsWith('https://')) {
        return null;
    }
    return `ptbk connect --link '${formatLinkUrl(origin, code.data)}'`;
}

/**
 * `/link#<code>`: a link URL opened in a browser instead of given to an engine. Public, and it sends nothing: the
 * browser never sends a fragment, and the code is read here only to fill in the command.
 */
export function LinkPage() {
    const { origin } = useBrowser();
    const hash = useLocation({ select: (location) => location.hash });
    const command = connectCommand(origin, hash);
    return (
        <div className="flex min-h-dvh flex-col bg-surface text-text">
            <SkipLink targetId={MAIN_ID} />
            <PublicHeader width="narrow" />
            <main
                id={MAIN_ID}
                tabIndex={-1}
                className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-8 outline-none"
            >
                <h1 className="font-display text-2xl font-semibold">{m.link_page_title()}</h1>
                {command === null ? (
                    <p>{m.link_page_no_code()}</p>
                ) : (
                    <>
                        <p>{m.link_page_body()}</p>
                        <div className="overflow-hidden rounded-control bg-(--code-text-bg) text-(--code-text-text)">
                            <div className="flex justify-end px-2 pt-2">
                                <CopyButton
                                    value={command}
                                    label={m.engines_new_copy()}
                                    variant="secondary"
                                    showLabel
                                />
                            </div>
                            <pre className="px-3 pt-1 pb-3 font-mono text-sm wrap-anywhere whitespace-pre-wrap">
                                <code>{command}</code>
                            </pre>
                        </div>
                    </>
                )}
            </main>
            <PublicFooter width="narrow" />
        </div>
    );
}
