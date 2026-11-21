/** Run on the engine host, in the selected project's folder. */
export const ENGINE_STATUS_COMMAND = 'ptbk status';

/** The public connection guide describes heartbeat, relay and TLS failures under this heading. */
export function troubleshootingLink(guideUrl: string): string {
    const url = new URL(guideUrl);
    url.hash =
        url.hostname === 'github.com' && url.pathname.endsWith('/specs/app/connection.md')
            ? 'the-running-connection'
            : 'troubleshooting';
    return url.href;
}
