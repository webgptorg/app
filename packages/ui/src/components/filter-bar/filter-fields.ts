import type { ReactNode } from 'react';

export interface FilterBarOption<V extends string = string> {
    readonly value: V;
    /** Untrusted text is fine: it renders as a text node. */
    readonly label: string;
    /** A decorative lead in the list and on the chip, e.g. an agent's avatar or a status dot. */
    readonly icon?: ReactNode;
}

interface FieldBase {
    readonly id: string;
    /** The field's name, e.g. "Status"; the field list and the chip use it. */
    readonly label: string;
    /** A small monochrome icon beside the name in the field list. */
    readonly icon?: ReactNode;
}

/** One value or none, e.g. a run's source. */
export interface FilterBarEnumField<V extends string = string> extends FieldBase {
    readonly kind: 'enum';
    readonly options: readonly FilterBarOption<V>[];
    readonly value: V | undefined;
    readonly onChange: (value: V | undefined) => void;
}

/** Any number of values; none means no filter. The kind for statuses. */
export interface FilterBarMultiEnumField<V extends string = string> extends FieldBase {
    readonly kind: 'multi-enum';
    readonly options: readonly FilterBarOption<V>[];
    readonly value: readonly V[];
    readonly onChange: (value: readonly V[]) => void;
}

/**
 * Agents, members and other things with a name and a face: the value list has a search, and each option's `icon` (an
 * avatar) also leads the chip.
 */
export interface FilterBarEntityField<V extends string = string> extends FieldBase {
    readonly kind: 'entity';
    readonly options: readonly FilterBarOption<V>[];
    /** `false` picks one and closes; the default picks several. */
    readonly multiple?: boolean;
    readonly value: readonly V[];
    readonly onChange: (value: readonly V[]) => void;
}

/** Calendar days as `YYYY-MM-DD`; either end may be open. */
export interface FilterBarDateRange {
    readonly from: string | undefined;
    readonly to: string | undefined;
}

export interface FilterBarDateRangeField extends FieldBase {
    readonly kind: 'date-range';
    readonly value: FilterBarDateRange;
    readonly onChange: (value: FilterBarDateRange) => void;
    readonly min?: string;
    readonly max?: string;
    /** Shown under the two dates, e.g. the time zone days are counted in. */
    readonly hint?: string;
}

export type FilterBarField =
    FilterBarEnumField | FilterBarMultiEnumField | FilterBarEntityField | FilterBarDateRangeField;

function known<V extends string>(options: readonly FilterBarOption<V>[], value: string): V | undefined {
    return options.find((option) => option.value === value)?.value;
}

function knownList<V extends string>(options: readonly FilterBarOption<V>[], values: readonly string[]): V[] {
    return values.flatMap((value) => {
        const match = known(options, value);
        return match === undefined ? [] : [match];
    });
}

/**
 * Typed field constructors: options, value and `onChange` share one value type, e.g. `RunStatus`, and `onChange` only
 * ever receives values from `options`, so the consumer never narrows strings itself.
 */
export const filterField = {
    enum: <V extends string>(field: Omit<FilterBarEnumField<V>, 'kind'>): FilterBarField => ({
        ...field,
        kind: 'enum',
        onChange: (value) => {
            field.onChange(value === undefined ? undefined : known(field.options, value));
        },
    }),
    multiEnum: <V extends string>(field: Omit<FilterBarMultiEnumField<V>, 'kind'>): FilterBarField => ({
        ...field,
        kind: 'multi-enum',
        onChange: (value) => {
            field.onChange(knownList(field.options, value));
        },
    }),
    entity: <V extends string>(field: Omit<FilterBarEntityField<V>, 'kind'>): FilterBarField => ({
        ...field,
        kind: 'entity',
        onChange: (value) => {
            field.onChange(knownList(field.options, value));
        },
    }),
    dateRange: (field: Omit<FilterBarDateRangeField, 'kind'>): FilterBarField => ({ ...field, kind: 'date-range' }),
} as const;

export function isMultiple(field: FilterBarField): boolean {
    return field.kind === 'multi-enum' || (field.kind === 'entity' && field.multiple !== false);
}

/** The chosen values of a list field, in the options' order, as the chip shows them. */
export function selectedOptions(field: Exclude<FilterBarField, FilterBarDateRangeField>): readonly FilterBarOption[] {
    const values: readonly string[] =
        field.kind === 'enum' ? (field.value === undefined ? [] : [field.value]) : field.value;
    const options: readonly FilterBarOption[] = field.options;
    const listed = options.filter((option) => values.includes(option.value));
    // A value the options do not list (e.g. an agent beyond the first page) still shows, by its raw value.
    const unlisted = values
        .filter((value) => !options.some((option) => option.value === value))
        .map((value) => ({ value, label: value }));
    return [...listed, ...unlisted];
}

export function isFieldActive(field: FilterBarField): boolean {
    if (field.kind === 'date-range') return field.value.from !== undefined || field.value.to !== undefined;
    return selectedOptions(field).length > 0;
}

/** The empty value of a field: what its chip's remove button and "Clear filters" set. */
export function clearField(field: FilterBarField): void {
    switch (field.kind) {
        case 'enum':
            field.onChange(undefined);
            return;
        case 'multi-enum':
        case 'entity':
            field.onChange([]);
            return;
        case 'date-range':
            field.onChange({ from: undefined, to: undefined });
            return;
    }
}

/** Matches typed text against an option, ignoring case and accents, so "zdenek" finds "Zdeněk". */
export function matchesQuery(label: string, query: string): boolean {
    const fold = (text: string) =>
        text
            .normalize('NFD')
            .replace(/\p{Diacritic}/gu, '')
            .toLocaleLowerCase();
    return fold(label).includes(fold(query.trim()));
}
