import type { EmailMessage, EmailSender } from '../../domain/ports/email-sender';

export interface RenderedEmail {
    readonly subject: string;
    readonly text: string;
    /** Extra headers, only `List-Unsubscribe` and `List-Unsubscribe-Post` (RFC 8058) so far. */
    readonly headers?: Readonly<Record<string, string>>;
}

/** The part of the `send_email` binding this adapter uses, so tests can pass a stub. */
export interface SendEmailBinding {
    send(builder: {
        from: string;
        to: string;
        subject: string;
        text: string;
        headers?: Record<string, string>;
    }): Promise<unknown>;
}

/** Cloudflare Email Service through the Worker's `send_email` binding. */
export function createCloudflareEmailSender(deps: {
    readonly binding: SendEmailBinding;
    readonly from: string;
    readonly render: (message: EmailMessage) => RenderedEmail;
}): EmailSender {
    return {
        async send(message, signal) {
            signal.throwIfAborted();
            const { subject, text, headers } = deps.render(message);
            // The binding takes no signal, so an abort stops the wait, not the provider call.
            const aborted = new Promise<never>((_, reject) => {
                signal.addEventListener('abort', () => {
                    reject(signal.reason as Error);
                });
            });
            const builder = { from: deps.from, to: message.to, subject, text };
            await Promise.race([
                deps.binding.send(headers === undefined ? builder : { ...builder, headers: { ...headers } }),
                aborted,
            ]);
        },
    };
}
