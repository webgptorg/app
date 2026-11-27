import { Button, Card } from '@ptbk/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Mail } from 'lucide-react';

import { m } from '../../../paraglide/messages';
import { apiRoutes, type InviteOfferView } from '../../../shared/api/routes';
import { useApiClient } from '../../api/api-client-context';
import { dataOrThrow, problemCode, queryKeys } from '../../api/queries';
import { useAppMutation } from '../../core/mutations';
import { inviteOffersQuery, teamKeys } from './team-queries';

/**
 * Invitations to the signed-in address that wait to be accepted (D-33): whoever signed in or up some other way than
 * the invitation link still finds them, on home and after recovery. Nothing shows while there are none.
 */
export function InviteOffers() {
    const api = useApiClient();
    const offers = useQuery(inviteOffersQuery(api));
    if (offers.data === undefined || offers.data.length === 0) {
        return null;
    }
    return (
        <ul className="flex flex-col gap-2" aria-label={m.invite_offers_label()}>
            {offers.data.map((offer) => (
                <li key={offer.inviteId}>
                    <InviteOffer offer={offer} />
                </li>
            ))}
        </ul>
    );
}

function offerTitle(offer: InviteOfferView): string {
    if (offer.inviterEmail === null) {
        return offer.orgName === null ? m.invite_page_body_unnamed() : m.invite_page_body({ org: offer.orgName });
    }
    return offer.orgName === null
        ? m.invite_offer_title_unnamed({ inviter: offer.inviterEmail })
        : m.invite_offer_title({ org: offer.orgName, inviter: offer.inviterEmail });
}

function InviteOffer(props: { readonly offer: InviteOfferView }) {
    const { offer } = props;
    const api = useApiClient();
    const queryClient = useQueryClient();
    const navigate = useNavigate();
    const accept = useAppMutation({
        mutationFn: async () => {
            const joined = dataOrThrow(
                await api.call(apiRoutes.acceptInviteOffer, { params: { inviteId: offer.inviteId } }),
            );
            queryClient.setQueryData(
                queryKeys.session,
                dataOrThrow(await api.call(apiRoutes.setActiveOrg, { body: { orgId: joined.orgId } })),
            );
            return joined.teamIds;
        },
        errorMessage: (error) => (problemCode(error) === 'invite-invalid' ? m.invite_offer_gone() : undefined),
        invalidates: [teamKeys.offers],
        onSuccess: async (teamIds) => {
            // Now in the invitation's organization: nothing cached about the previous one still holds.
            queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== queryKeys.session[0] });
            await navigate({ to: '/joined', search: { teams: [...teamIds] } });
        },
    });
    return (
        <Card as="div" className="flex-row flex-wrap items-center justify-between gap-3 p-4">
            <div className="flex min-w-0 items-start gap-3">
                <Mail aria-hidden className="mt-0.5 size-4 shrink-0 text-text-muted" />
                <div className="flex min-w-0 flex-col gap-0.5">
                    <p className="font-medium [overflow-wrap:anywhere]">{offerTitle(offer)}</p>
                    {offer.teamNames.length === 0 ? null : (
                        <p className="text-sm text-text-muted">
                            {m.invite_offer_engines({ names: offer.teamNames.join(', ') })}
                        </p>
                    )}
                </div>
            </div>
            <Button
                variant="primary"
                size="sm"
                loading={accept.isPending}
                onClick={() => {
                    accept.mutate();
                }}
            >
                {m.invite_join_action_unnamed()}
            </Button>
        </Card>
    );
}
