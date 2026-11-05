import { z } from 'zod';

/** The page's state in the URL; a bad value falls back to nothing instead of throwing. */
export const WalletSearch = z.object({
    /** Opens "Add login" over the page, e.g. from the command palette. Opening a form writes nothing. */
    dialog: z.literal('new').optional().catch(undefined),
});
export type WalletSearch = z.output<typeof WalletSearch>;
