import { applyServerErrors, Banner, Button, Form, FormField, FormSubmit, Input, Textarea, toFieldName } from '@ptbk/ui';
import type { ServerFieldError, ZodForm } from '@ptbk/ui';
import { useEffect } from 'react';
import type { Ref } from 'react';
import { z } from 'zod';

import { m } from '../../paraglide/messages';
import { AgentAvatar } from '../agents/agent-avatar';
import { StepFrame } from './step-frame';

export const MAX_AGENT_NAME_LENGTH = 256;
export const MAX_DESCRIPTION_LENGTH = 4096;

export const BriefSchema = z.object({
    name: z
        .string()
        .trim()
        .min(1, { error: () => m.wizard_name_required() })
        .max(MAX_AGENT_NAME_LENGTH, { error: () => m.wizard_name_too_long() }),
    description: z
        .string()
        .trim()
        .max(MAX_DESCRIPTION_LENGTH, { error: () => m.wizard_description_too_long() }),
});
export type BriefValues = z.input<typeof BriefSchema>;
const BRIEF_FIELDS: ReadonlySet<string> = new Set(Object.keys(BriefSchema.shape));

export interface BriefStepProps {
    readonly form: ZodForm<BriefValues>;
    readonly headingRef: Ref<HTMLHeadingElement>;
    /** Field errors the engine returned for the create call, shown on the fields they name. */
    readonly serverErrors: readonly ServerFieldError[];
    readonly onCancel: () => void;
}

/** Step 1: what the agent is called and what it is for; the book draft is made from this. */
export function BriefStep({ form, headingRef, serverErrors, onCancel }: BriefStepProps) {
    useEffect(() => {
        applyServerErrors(form, serverErrors);
    }, [form, serverErrors]);
    const unmatched = serverErrors.filter((error) => !BRIEF_FIELDS.has(toFieldName(error.path)));

    return (
        <Form form={form} className="flex flex-col">
            <StepFrame
                title={m.wizard_brief_title()}
                description={m.wizard_brief_body()}
                headingRef={headingRef}
                width="form"
                aside={
                    <form.Subscribe selector={(state) => state.values}>
                        {(values) => <AgentPreview name={values.name} description={values.description} />}
                    </form.Subscribe>
                }
                actions={
                    <>
                        <Button variant="ghost" onClick={onCancel}>
                            {m.wizard_cancel()}
                        </Button>
                        <FormSubmit form={form}>{m.wizard_next()}</FormSubmit>
                    </>
                }
            >
                {unmatched.length === 0 ? null : (
                    <Banner tone="danger" title={m.wizard_create_rejected()}>
                        <ul>
                            {unmatched.map((error) => (
                                <li key={`${error.path}:${error.message}`}>{error.message}</li>
                            ))}
                        </ul>
                    </Banner>
                )}
                <FormField form={form} name="name" label={m.wizard_name_label()} hint={m.wizard_name_hint()} required>
                    {(control) => <Input {...control.text} autoComplete="off" maxLength={MAX_AGENT_NAME_LENGTH} />}
                </FormField>
                <FormField
                    form={form}
                    name="description"
                    label={m.wizard_description_label()}
                    hint={m.wizard_description_hint()}
                >
                    {(control) => <Textarea {...control.text} rows={4} maxLength={MAX_DESCRIPTION_LENGTH} />}
                </FormField>
            </StepFrame>
        </Form>
    );
}

/**
 * The agent as the brief describes it so far, the way it will look in lists and chats: its picture, name and role.
 * The text is the member's own and renders as text.
 */
function AgentPreview({ name, description }: { readonly name: string; readonly description: string }) {
    const shownName = name.trim();
    const shownRole = description.trim();
    return (
        <div className="sticky top-24 flex flex-col gap-4">
            <p className="text-xs font-medium text-text-muted">{m.wizard_preview_title()}</p>
            <div className="flex flex-col items-start gap-3 rounded-surface border border-hairline p-5">
                <AgentAvatar
                    name={shownName}
                    profile={{ avatarUrl: null, color: null, description: shownRole }}
                    size="xl"
                />
                <div className="flex min-w-0 flex-col gap-1">
                    <p
                        className={
                            shownName === ''
                                ? 'text-base font-semibold text-text-subtle'
                                : 'text-base font-semibold break-words'
                        }
                    >
                        {shownName === '' ? m.wizard_preview_name() : shownName}
                    </p>
                    <p className="line-clamp-3 text-sm break-words text-text-muted">
                        {shownRole === '' ? m.wizard_preview_role() : shownRole}
                    </p>
                </div>
            </div>
            <p className="text-xs text-text-muted">{m.wizard_preview_next()}</p>
        </div>
    );
}
