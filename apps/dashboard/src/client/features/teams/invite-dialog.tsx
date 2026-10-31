import { Button, Checkbox, Dialog, Field, Select, Textarea } from '@ptbk/ui';
import { useQuery } from '@tanstack/react-query';
import { useRef, useState } from 'react';

import { m } from '../../../paraglide/messages';
import { apiRoutes, MAX_INVITE_EMAILS } from '../../../shared/api/routes';
import { useApiClient } from '../../api/api-client-context';
import { dataOrThrow, problemCode } from '../../api/queries';
import { useAppMutation } from '../../core/mutations';
import { useSession } from '../session/use-session';
import { roleLabel, type OrgRole } from './team-labels';
import { teamKeys, teamsQuery } from './team-queries';

/** Commas, semicolons, spaces or new lines between addresses; duplicates count once. */
export function splitEmails(typed: string): readonly string[] {
    return [...new Set(typed.split(/[\s,;]+/u).filter((part) => part !== ''))];
}

const LOOKS_LIKE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

/**
 * "Invite people": addresses, their role in the organization and the teams they join. Someone already in the
 * organization is added to the teams at once; everyone else gets an email.
 */
export function InviteDialog(props: {
    readonly open: boolean;
    readonly onClose: () => void;
    /** Teams ticked when the dialog opens, e.g. the team page it was opened from. */
    readonly teamIds?: readonly string[];
}) {
    return (
        <Dialog open={props.open} onClose={props.onClose} title={m.invite_title()} description={m.invite_body()}>
            <InviteForm {...props} />
        </Dialog>
    );
}

function InviteForm(props: Parameters<typeof InviteDialog>[0]) {
    const api = useApiClient();
    const session = useSession();
    const teams = useQuery(teamsQuery(api));
    const emailsField = useRef<HTMLTextAreaElement>(null);
    const [typed, setTyped] = useState('');
    const [role, setRole] = useState<OrgRole>('member');
    const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set(props.teamIds ?? []));
    const [submitted, setSubmitted] = useState(false);
    const emails = splitEmails(typed);
    const emailsInvalid =
        emails.length === 0 ||
        emails.length > MAX_INVITE_EMAILS ||
        emails.some((email) => !LOOKS_LIKE_EMAIL.test(email));
    const roles: readonly OrgRole[] =
        session.activeOrg.role === 'owner' ? ['member', 'admin', 'owner'] : ['member', 'admin'];
    const invite = useAppMutation({
        mutationFn: async () =>
            dataOrThrow(
                await api.call(apiRoutes.createInvites, { body: { emails: [...emails], role, teamIds: [...chosen] } }),
            ).results,
        invalidates: [teamKeys.all, teamKeys.people, ...[...chosen].map((teamId) => teamKeys.team(teamId))],
        errorMessage: (error) => (problemCode(error) === 'invalid-email' ? m.invite_emails_invalid() : undefined),
        successMessage: (results) =>
            results.every((result) => result.outcome === 'added')
                ? m.invite_added({ count: results.length })
                : m.invite_sent({ count: results.length }),
        onSuccess: props.onClose,
    });
    return (
        <form
            noValidate
            className="flex flex-col gap-4"
            onSubmit={(event) => {
                event.preventDefault();
                setSubmitted(true);
                if (emailsInvalid) {
                    emailsField.current?.focus();
                    return;
                }
                invite.mutate();
            }}
        >
            <Field
                label={m.invite_emails_label()}
                hint={m.invite_emails_hint({ max: MAX_INVITE_EMAILS })}
                {...(submitted && emailsInvalid ? { error: m.invite_emails_invalid() } : {})}
            >
                {(control) => (
                    <Textarea
                        {...control}
                        ref={emailsField}
                        rows={3}
                        value={typed}
                        autoComplete="off"
                        onChange={(event) => {
                            setTyped(event.target.value);
                        }}
                    />
                )}
            </Field>
            <Field label={m.invite_role_label()} hint={m.invite_role_hint()}>
                {(control) => (
                    <Select
                        {...control}
                        value={role}
                        onChange={(event) => {
                            setRole(event.target.value as OrgRole);
                        }}
                    >
                        {roles.map((option) => (
                            <option key={option} value={option}>
                                {roleLabel(option)}
                            </option>
                        ))}
                    </Select>
                )}
            </Field>
            {(teams.data?.length ?? 0) === 0 ? null : (
                <fieldset className="flex flex-col gap-2">
                    <legend className="mb-1 text-sm font-medium">{m.invite_teams_label()}</legend>
                    {teams.data?.map((team) => (
                        <Checkbox
                            key={team.teamId}
                            label={team.name}
                            checked={chosen.has(team.teamId)}
                            onChange={(event) => {
                                const next = new Set(chosen);
                                if (event.target.checked) {
                                    next.add(team.teamId);
                                } else {
                                    next.delete(team.teamId);
                                }
                                setChosen(next);
                            }}
                        />
                    ))}
                </fieldset>
            )}
            <div className="flex flex-wrap justify-end gap-2">
                <Button variant="ghost" onClick={props.onClose}>
                    {m.team_cancel()}
                </Button>
                <Button type="submit" variant="primary" loading={invite.isPending}>
                    {m.invite_submit()}
                </Button>
            </div>
        </form>
    );
}
