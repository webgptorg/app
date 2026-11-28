import { createFileRoute } from '@tanstack/react-router';

import { takeFragment } from '../../features/auth/take-fragment';
import { useFragmentArrivals } from '../../features/auth/use-fragment-token';
import { UnsubscribePage } from '../../features/notifications/unsubscribe-page';

/** Public, signed in or not: an email's unsubscribe link carries its signed token in the fragment (D-41). */
export const Route = createFileRoute('/_auth/unsubscribe')({
    beforeLoad: ({ context, location }) => {
        takeFragment(context, location, 'unsubscribe', '/unsubscribe');
    },
    component: function Unsubscribe() {
        return <UnsubscribePage key={useFragmentArrivals()} />;
    },
});
