import { Button, Dialog, Field, Input } from '@ptbk/ui';
import { useRef, useState } from 'react';

import { m } from '../../../paraglide/messages';
import { normalizeTeamName, teamNameSchema, type TeamName } from '../../../shared/team-name';

/** Naming a new team or renaming one: one field, checked on submit and then on every change. */
export function TeamNameDialog(props: {
    readonly open: boolean;
    readonly title: string;
    readonly submitLabel: string;
    readonly initial?: string;
    readonly placeholder?: string | undefined;
    readonly pending: boolean;
    readonly onSubmit: (name: TeamName) => void;
    readonly onClose: () => void;
}) {
    return (
        <Dialog open={props.open} onClose={props.onClose} title={props.title} size="sm">
            <NameForm {...props} />
        </Dialog>
    );
}

function NameForm(props: Parameters<typeof TeamNameDialog>[0]) {
    const input = useRef<HTMLInputElement>(null);
    const [typed, setTyped] = useState(props.initial ?? '');
    const [submitted, setSubmitted] = useState(false);
    const parsed = teamNameSchema.safeParse(normalizeTeamName(typed));
    return (
        <form
            noValidate
            className="flex flex-col gap-3"
            onSubmit={(event) => {
                event.preventDefault();
                setSubmitted(true);
                if (parsed.success) {
                    props.onSubmit(parsed.data);
                } else {
                    input.current?.focus();
                }
            }}
        >
            <Field
                label={m.team_name_label()}
                hint={m.team_name_hint()}
                {...(submitted && !parsed.success ? { error: m.team_name_invalid() } : {})}
            >
                {(control) => (
                    <Input
                        {...control}
                        ref={input}
                        value={typed}
                        placeholder={props.placeholder}
                        autoComplete="off"
                        onChange={(event) => {
                            setTyped(event.target.value);
                        }}
                    />
                )}
            </Field>
            <div className="flex flex-wrap justify-end gap-2">
                <Button variant="ghost" onClick={props.onClose}>
                    {m.team_cancel()}
                </Button>
                <Button type="submit" variant="primary" loading={props.pending}>
                    {props.submitLabel}
                </Button>
            </div>
        </form>
    );
}
