import { EngineId, Hostname } from '@ptbk/protocol';
import { z } from 'zod';

import { notificationChannelSchema } from '../notifications/notification-kind';
import { notificationKindSchema } from '../notifications/registry';
import { defineRoute, NO_CONTENT, NO_INPUT } from './contract';

const idSchema = z.string().regex(/^[a-z2-7]{26}$/);
const timestampSchema = z.number().int().nonnegative();

/** The bell takes at most this many rows; marking seen takes no more than it showed. */
export const MAX_NOTIFICATIONS = 50;

/** One open notification: a kind, a closed variant, a count and times, and the project's own label and hostname. */
export const notificationViewSchema = z.strictObject({
    id: idSchema,
    kind: notificationKindSchema,
    variant: z
        .string()
        .regex(/^[a-z-]{1,40}$/)
        .nullable(),
    count: z.number().int().min(1),
    openedAt: timestampSchema,
    updatedAt: timestampSchema,
    seen: z.boolean(),
    project: z.strictObject({ engineId: EngineId, label: z.string().min(1).max(80), hostname: Hostname }).nullable(),
});
export type NotificationView = z.infer<typeof notificationViewSchema>;

export const notificationPreferenceViewSchema = z.strictObject({
    kind: notificationKindSchema,
    channel: notificationChannelSchema,
    /** The person's role's default, which choosing it again restores. */
    defaultChannel: notificationChannelSchema,
});
export type NotificationPreferenceView = z.infer<typeof notificationPreferenceViewSchema>;

const preferencesOutput = z.strictObject({ preferences: z.array(notificationPreferenceViewSchema) });

/** RFC 8058's one-click target, and the SPA's after a person confirmed: the token is the whole authority. */
export const UNSUBSCRIBE_PATH = '/email/unsubscribe';
export const UNSUBSCRIBE_MOUNT = '/email';
const unsubscribeTokenSchema = z.string().min(1).max(400);

export const notificationRoutes = {
    listNotifications: defineRoute({
        method: 'GET',
        path: '/api/notifications',
        auth: 'session',
        permission: 'notification.read',
        rateLimit: null,
        input: NO_INPUT,
        output: z.strictObject({
            notifications: z.array(notificationViewSchema).max(MAX_NOTIFICATIONS),
            /** Other organizations of the person with something unseen, for the org switcher's dot. */
            otherOrgsWithUnseen: z.array(idSchema).max(100),
        }),
        errorCodes: [],
    }),
    markNotificationsSeen: defineRoute({
        method: 'POST',
        path: '/api/notifications/seen',
        auth: 'session',
        permission: 'notification.manage',
        rateLimit: null,
        input: {
            ...NO_INPUT,
            body: z.strictObject({ ids: z.array(idSchema).min(1).max(MAX_NOTIFICATIONS) }),
            maxBodyBytes: 4096,
        },
        output: NO_CONTENT,
        errorCodes: [],
    }),
    listNotificationPreferences: defineRoute({
        method: 'GET',
        path: '/api/notification-preferences',
        auth: 'session',
        permission: 'notification.read',
        rateLimit: null,
        input: NO_INPUT,
        output: preferencesOutput,
        errorCodes: [],
    }),
    setNotificationPreference: defineRoute({
        method: 'PUT',
        path: '/api/notification-preferences/:kind',
        auth: 'session',
        permission: 'notification.manage',
        rateLimit: null,
        input: {
            ...NO_INPUT,
            params: z.strictObject({ kind: notificationKindSchema }),
            body: z.strictObject({ channel: notificationChannelSchema }),
            maxBodyBytes: 256,
        },
        output: preferencesOutput,
        errorCodes: [],
    }),
    /**
     * Public, outside `/api` and its same-origin guard: mail providers post it from their own servers (RFC 8058, whose
     * form body it never reads). It only ever turns email off, and only for what the token names.
     */
    unsubscribe: defineRoute({
        method: 'POST',
        path: UNSUBSCRIBE_PATH,
        auth: 'public',
        permission: null,
        rateLimit: 'unsubscribe-ip',
        input: { ...NO_INPUT, query: z.strictObject({ token: unsubscribeTokenSchema }) },
        output: NO_CONTENT,
        errorCodes: ['invalid-token'],
    }),
} as const;
