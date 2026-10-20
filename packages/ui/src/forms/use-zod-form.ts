import { revalidateLogic, useForm } from '@tanstack/react-form';
import type { FormValidateOrFn, ReactFormExtendedApi } from '@tanstack/react-form';
import type { z } from 'zod';

/** A TanStack form whose single validator is a zod schema (through Standard Schema), as `useZodForm` creates it. */
export type ZodForm<Values> = ReactFormExtendedApi<
    Values,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    FormValidateOrFn<Values>,
    undefined,
    undefined,
    never
>;

export interface UseZodFormOptions<Schema extends z.ZodType<unknown, Record<string, unknown>>> {
    readonly schema: Schema;
    readonly defaultValues: z.input<Schema>;
    /** Called with the parsed values once the schema accepts them; awaited, so the submit button stays busy. */
    readonly onSubmit: (values: z.output<Schema>, form: ZodForm<z.input<Schema>>) => void | Promise<void>;
}

/**
 * A form validated by one zod schema. It validates on submit only, so nobody is told off while still typing; after
 * the first submit it revalidates on every change, so an error disappears as soon as it is fixed.
 */
export function useZodForm<Schema extends z.ZodType<unknown, Record<string, unknown>>>(
    options: UseZodFormOptions<Schema>,
): ZodForm<z.input<Schema>> {
    const form: ZodForm<z.input<Schema>> = useForm({
        defaultValues: options.defaultValues,
        validationLogic: revalidateLogic({ mode: 'submit', modeAfterSubmission: 'change' }),
        validators: { onDynamic: options.schema as FormValidateOrFn<z.input<Schema>> },
        onSubmit: async ({ value }) => {
            await options.onSubmit(options.schema.parse(value), form);
        },
    });
    return form;
}
