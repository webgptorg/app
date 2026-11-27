import type { Config, FeedbackPayload, TextConfig } from 'ucho-js';

import { m } from '../../../paraglide/messages';

// The widget imports this module on demand, so ucho and these texts stay out of the entry bundle.
export { init } from 'ucho-js';

/** Who sent the feedback: identifiers only, so a report can be followed up without carrying anything else. */
export interface FeedbackSender {
    readonly email: string;
    readonly userId: string;
    readonly orgId: string;
}

/**
 * The sender goes after the message, not before: clientcare titles the task with the message's first characters.
 * Locations keep only origin and path: queries and fragments carry one-time codes (`/engines/new?code=…`,
 * `/link#…`). The console buffer is dropped, as nothing filters what reaches it.
 */
export function feedbackPayload(data: FeedbackPayload, sender: FeedbackSender): FeedbackPayload {
    const { locationInfo } = data.metadata;
    return {
        ...data,
        message: `${data.message}\n\n— [dashboard] ${sender.email} · user ${sender.userId} · org ${sender.orgId}`,
        metadata: {
            ...data.metadata,
            locationInfo: {
                ...locationInfo,
                url: `${locationInfo.origin}${locationInfo.pathname}`,
                searchParams: {},
                referrer: originAndPath(locationInfo.referrer),
            },
            console: [],
        },
        customInputs: {
            ...data.customInputs,
            senderEmail: sender.email,
            senderUserId: sender.userId,
            senderOrgId: sender.orgId,
        },
    };
}

function originAndPath(url: string): string {
    if (!URL.canParse(url)) {
        return '';
    }
    const { origin, pathname } = new URL(url);
    return `${origin}${pathname}`;
}

export function feedbackConfig(endpoint: string, sender: () => FeedbackSender): Config {
    return {
        textConfig: feedbackTexts(),
        onSubmit: (data) =>
            fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(feedbackPayload(data, sender())),
            }),
    };
}

function feedbackTexts(): Partial<TextConfig> {
    return {
        welcomeMessage: { text: m.feedback_welcome(), closeAriaLabel: m.feedback_welcome_close() },
        feedbackForm: {
            title: m.feedback_form_title(),
            placeholder: m.feedback_form_placeholder(),
            screenshotAlt: m.feedback_screenshot_alt(),
            submitButton: m.feedback_submit(),
            minimizeTitle: m.feedback_minimize(),
            expandTitle: m.feedback_expand(),
            closeTitle: m.feedback_close(),
            showFormTitle: m.feedback_show_form(),
        },
        notification: {
            successTitle: m.feedback_success(),
            errorTitle: m.feedback_error_title(),
            errorMessage: m.feedback_error_message(),
            hideTitle: m.feedback_hide_notification(),
        },
        drawingTooltip: { text: m.feedback_drawing_tooltip() },
    };
}
