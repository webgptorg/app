import { createContext, use } from 'react';
import type { ReactNode } from 'react';

import type { SessionView } from '../../../shared/api/routes';

const SessionContext = createContext<SessionView | null>(null);

/** Provided by the signed-in shell, which renders nothing once the session is gone (sign-out, expiry, revocation). */
export function SessionProvider(props: { readonly session: SessionView; readonly children: ReactNode }) {
    return <SessionContext value={props.session}>{props.children}</SessionContext>;
}

export function useSession(): SessionView {
    const session = use(SessionContext);
    if (session === null) {
        throw new Error('useSession needs the signed-in shell');
    }
    return session;
}
