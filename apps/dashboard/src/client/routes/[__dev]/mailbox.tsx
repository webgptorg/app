import { createFileRoute, notFound } from '@tanstack/react-router';

import { devEmailsQuery, hasProblem } from '../../api/queries';
import { DevMailboxPage } from '../../features/dev-mailbox/dev-mailbox-page';

/**
 * Dev only (X-06). The outbox API is mounted only with the fake email adapter (dev alone), so everywhere else it answers
 * 404 and this path is as unknown as any other: the page exists exactly where its data does.
 */
export const Route = createFileRoute('/__dev/mailbox')({
    loader: async ({ context }) => {
        try {
            await context.queryClient.query(devEmailsQuery(context.apiClient));
        } catch (error) {
            if (hasProblem(error, 'not-found')) throw notFound();
            throw error;
        }
    },
    component: DevMailboxPage,
});
