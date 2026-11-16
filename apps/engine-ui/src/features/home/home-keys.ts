export const homeKeys = {
    all: ['home'] as const,
    /** An update the engine announced as activity since `GET /security` was read; written by the event sync only. */
    updateNotice: () => [...homeKeys.all, 'update-notice'] as const,
};
