import { Component, Suspense } from 'react';
import type { ReactNode } from 'react';

import { m } from '../../paraglide/messages';
import { OverviewFailed, OverviewLoading } from './overview-parts';

interface BoundaryState {
    readonly failed: boolean;
}

interface BoundaryProps {
    /** Clears failed queries under the section (`QueryErrorResetBoundary`), so a retry fetches again. */
    readonly onReset: () => void;
    readonly children: ReactNode;
}

/** One registered overview section: its failure or its loading stays a quiet line of its own, never blanking the page. */
export class OverviewCardBoundary extends Component<BoundaryProps, BoundaryState> {
    override state: BoundaryState = { failed: false };

    static getDerivedStateFromError(): BoundaryState {
        return { failed: true };
    }

    override render() {
        if (this.state.failed) {
            return (
                <OverviewFailed
                    message={m.agent_card_failed_title()}
                    onRetry={() => {
                        this.props.onReset();
                        this.setState({ failed: false });
                    }}
                />
            );
        }
        return <Suspense fallback={<OverviewLoading label={m.loading()} rows={2} />}>{this.props.children}</Suspense>;
    }
}
