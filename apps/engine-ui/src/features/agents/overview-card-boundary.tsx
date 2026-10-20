import { Card, ErrorState, Skeleton } from '@ptbk/ui';
import { Component, Suspense } from 'react';
import type { ReactNode } from 'react';

import { m } from '../../paraglide/messages';

interface BoundaryState {
    readonly failed: boolean;
}

/** One registered overview card: its failure or its loading stays inside its own frame, never blanking the page. */
export class OverviewCardBoundary extends Component<{ readonly children: ReactNode }, BoundaryState> {
    override state: BoundaryState = { failed: false };

    static getDerivedStateFromError(): BoundaryState {
        return { failed: true };
    }

    override render() {
        if (this.state.failed) {
            return (
                <Card>
                    <ErrorState
                        title={m.agent_card_failed_title()}
                        message={m.agent_card_failed_body()}
                        onRetry={() => {
                            this.setState({ failed: false });
                        }}
                    />
                </Card>
            );
        }
        return (
            <Suspense
                fallback={
                    <Card>
                        <Skeleton shape="block" className="h-24 w-full" />
                    </Card>
                }
            >
                {this.props.children}
            </Suspense>
        );
    }
}
