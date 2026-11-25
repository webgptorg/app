import { Button, Dialog, Field, Input, Select } from '@ptbk/ui';
import { Book } from 'ptbk';
import type { ModelRow } from 'ptbk';
import { useId, useState } from 'react';

import { m } from '../../paraglide/messages';

const harnessNames = {
    OPENAI_CODEX: 'OpenAI Codex',
    CLAUDE_CODE: 'Claude Code',
    GITHUB_COPILOT: 'GitHub Copilot',
    OPENCODE: 'OpenCode',
    GEMINI: 'Gemini',
    QWEN_CODE: 'Qwen Code',
} satisfies Record<NonNullable<ModelRow['harness']>, string>;
const thinkingLevels = ['low', 'medium', 'high', 'xhigh', 'max'] as const satisfies readonly ModelRow['thinking'][];

// Examples follow the harness defaults in this version of ptbk. Any model ID can be entered.
const suggestedModels = {
    OPENAI_CODEX: 'gpt-5-codex',
    CLAUDE_CODE: 'sonnet',
    GITHUB_COPILOT: 'claude-sonnet-5.5',
    OPENCODE: 'anthropic/claude-sonnet-4-5',
    GEMINI: 'gemini-2.5-pro',
    QWEN_CODE: 'qwen3-coder-plus',
} satisfies Record<NonNullable<ModelRow['harness']>, string>;

function rowLabel(row: ModelRow): string {
    const parts = [
        row.harness && harnessNames[row.harness],
        row.model,
        row.thinking,
        row.provider,
        row.origin,
        row.runtime,
    ];
    return parts.filter(Boolean).join(' · ') || m.model_any();
}

function RowDialog({
    row,
    onApply,
    onClose,
}: {
    row: ModelRow;
    onApply: (next: ModelRow) => void;
    onClose: () => void;
}) {
    const [harness, setHarness] = useState<NonNullable<ModelRow['harness']> | ''>(row.harness ?? '');
    const [model, setModel] = useState(row.model ?? '');
    const [thinking, setThinking] = useState<NonNullable<ModelRow['thinking']> | ''>(row.thinking ?? '');
    const [invalid, setInvalid] = useState(false);
    const modelList = useId();
    const suggestions = harness ? [suggestedModels[harness]] : Object.values(suggestedModels);
    return (
        <Dialog
            open
            onClose={onClose}
            title={m.model_combination()}
            footer={
                <>
                    <Button onClick={onClose}>{m.ui_cancel()}</Button>
                    <Button type="submit" form="agent-model-row" variant="primary">
                        {m.model_apply()}
                    </Button>
                </>
            }
        >
            <form
                id="agent-model-row"
                className="grid gap-4"
                onSubmit={(event) => {
                    event.preventDefault();
                    const next = { ...row };
                    delete next.harness;
                    delete next.model;
                    delete next.thinking;
                    try {
                        onApply({
                            ...next,
                            ...(harness && { harness }),
                            ...(model.trim() && { model: model.trim() }),
                            ...(thinking && { thinking }),
                        });
                    } catch {
                        setInvalid(true);
                    }
                }}
            >
                <Field label={m.model_harness()}>
                    {(control) => (
                        <Select
                            {...control}
                            value={harness}
                            onChange={(event) => {
                                const chosen = Object.keys(harnessNames).find(
                                    (key) => key === event.target.value,
                                ) as ModelRow['harness'];
                                setHarness(chosen ?? '');
                            }}
                        >
                            <option value="">{m.model_any_harness()}</option>
                            {Object.entries(harnessNames).map(([id, label]) => (
                                <option key={id} value={id}>
                                    {label}
                                </option>
                            ))}
                        </Select>
                    )}
                </Field>
                <Field label={m.model_id()} {...(invalid ? { error: m.model_invalid_id() } : {})}>
                    {(control) => (
                        <>
                            <Input
                                list={modelList}
                                {...control}
                                value={model}
                                placeholder={m.model_any()}
                                autoComplete="off"
                                onChange={(event) => {
                                    setModel(event.target.value);
                                    setInvalid(false);
                                }}
                            />
                            <datalist id={modelList}>
                                {suggestions.map((id) => (
                                    <option key={id} value={id} />
                                ))}
                            </datalist>
                        </>
                    )}
                </Field>
                <Field label={m.model_thinking()}>
                    {(control) => (
                        <Select
                            {...control}
                            value={thinking}
                            onChange={(event) => {
                                setThinking(thinkingLevels.find((level) => level === event.target.value) ?? '');
                            }}
                        >
                            <option value="">{m.model_any_thinking()}</option>
                            {thinkingLevels.map((level) => (
                                <option key={level} value={level}>
                                    {level}
                                </option>
                            ))}
                        </Select>
                    )}
                </Field>
            </form>
        </Dialog>
    );
}

export function ModelSettings({
    source,
    editable,
    onChange,
}: {
    source: string;
    editable: boolean;
    onChange: (source: string) => void;
}) {
    const [editing, setEditing] = useState<number | null>(null);
    const agent = Book.parse(source);
    const rows = agent.model.constraint.rows;
    // Old agents may have a bare name. A temporary declaration lets the shared writer change MODEL while preserving the original header byte-for-byte.
    const legacy =
        agent.document.legacy?.plainHeader &&
        (!agent.document.legacy.entity || agent.document.legacy.entity === 'agent');
    const canChange = editable && (agent.kind === 'agent' || legacy) && agent.model.diagnostics.length === 0;
    const replace = (next: readonly ModelRow[]) => {
        const prefix = legacy ? 'AGENT Legacy\n' : '';
        const updated = Book.parse(prefix + source)
            .setModel(next)
            .toString();
        onChange(updated.slice(prefix.length));
        setEditing(null);
    };
    if (agent.model.diagnostics.length > 0 || (agent.kind !== 'agent' && !legacy)) {
        return <p className="text-sm text-text-muted">{m.model_repair_book()}</p>;
    }
    return (
        <div className="grid gap-3">
            <ul className="grid gap-2">
                {rows.map((row, index) => (
                    <li key={index} className="flex flex-wrap items-center gap-2">
                        <span className="me-auto break-all text-sm">{rowLabel(row)}</span>
                        {canChange && (
                            <Button
                                size="sm"
                                onClick={() => {
                                    setEditing(index);
                                }}
                            >
                                {m.model_edit()}
                            </Button>
                        )}
                        {canChange && rows.length > 1 && (
                            <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => {
                                    replace(rows.filter((_, position) => index !== position));
                                }}
                            >
                                {m.model_remove()}
                            </Button>
                        )}
                    </li>
                ))}
            </ul>
            {canChange && (
                <div className="flex flex-wrap gap-2">
                    <Button
                        size="sm"
                        onClick={() => {
                            setEditing(rows.length);
                        }}
                    >
                        {m.model_add()}
                    </Button>
                    {rows.some((row) => Object.keys(row).length > 0) && (
                        <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                                replace([{}]);
                            }}
                        >
                            {m.model_use_any()}
                        </Button>
                    )}
                </div>
            )}
            {canChange && editing !== null && (
                <RowDialog
                    row={rows[editing] ?? {}}
                    onClose={() => {
                        setEditing(null);
                    }}
                    onApply={(next) => {
                        if (editing < rows.length) replace(rows.map((row, index) => (index === editing ? next : row)));
                        else if (rows.length === 1 && Object.keys(rows[0] ?? {}).length === 0) replace([next]);
                        else replace([...rows, next]);
                    }}
                />
            )}
        </div>
    );
}
