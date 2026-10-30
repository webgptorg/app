import { createFileRoute, redirect } from '@tanstack/react-router';

// Passkeys moved under Security; old bookmarks and links still land there.
export const Route = createFileRoute('/settings_/passkeys')({
    beforeLoad: () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- TanStack Router's redirect is thrown by design.
        throw redirect({ to: '/security/passkeys', replace: true });
    },
});
