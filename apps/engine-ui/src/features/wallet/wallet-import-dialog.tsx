import type { ReadWalletRecord } from '@ptbk/engine-api';
import { Button, Checkbox, Dialog, Field, Input } from '@ptbk/ui';
import { useEffect, useRef, useState } from 'react';

import { classifyApiError } from '../../app/api-errors';
import { isStepUpRequired } from '../../app/mutations';
import { m } from '../../paraglide/messages';
import { hasImportConflict, importLoginKey, MAX_IMPORT_BYTES, parsePasswordImport } from './password-import';
import type { ImportFailure, ImportPasswords, ImportPreview } from './password-import';
import { useWalletImport } from './use-wallet-import';
import { WalletImportBatch } from './wallet-import-batch';
import type { ImportProgress } from './wallet-import-batch';

function importError(failure: ImportFailure | 'read'): string {
    switch (failure) {
        case 'invalid':
            return m.wallet_import_invalid();
        case 'encrypted':
            return m.wallet_import_encrypted();
        case 'too-large':
            return m.wallet_import_too_large();
        case 'too-many':
            return m.wallet_import_too_many();
        case 'read':
            return m.wallet_import_read_failed();
    }
}

type Phase = 'preview' | 'saving' | 'waiting' | 'done' | 'failed';

/** Only nonsecret metadata is rendered; file text and password holders never enter component state. */
export function WalletImportDialog({
    records,
    onClose,
}: {
    readonly records: readonly ReadWalletRecord[];
    readonly onClose: () => void;
}) {
    const [preview, setPreview] = useState<ImportPreview | null>(null);
    const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
    const [existing, setExisting] = useState<ReadonlySet<string>>(new Set());
    const [error, setError] = useState<string | undefined>(undefined);
    const [reading, setReading] = useState(false);
    const [phase, setPhase] = useState<Phase>('preview');
    const [progress, setProgress] = useState<ImportProgress>({ saved: 0, skipped: 0 });
    const pending = useRef<{ passwords: ImportPasswords | null; batch: WalletImportBatch | null }>({
        passwords: null,
        batch: null,
    });
    const readAttempt = useRef(0);
    const mutation = useWalletImport(setProgress);

    useEffect(() => {
        const holders = pending.current;
        return () => {
            readAttempt.current += 1;
            holders.passwords?.clear();
            holders.batch?.cancel();
        };
    }, []);

    const close = () => {
        readAttempt.current += 1;
        pending.current.passwords?.clear();
        pending.current.batch?.cancel();
        onClose();
    };

    const readFile = async (file: File | undefined) => {
        const attempt = ++readAttempt.current;
        pending.current.passwords?.clear();
        pending.current.passwords = null;
        pending.current.batch?.cancel();
        pending.current.batch = null;
        setPreview(null);
        setSelected(new Set());
        setError(undefined);
        setProgress({ saved: 0, skipped: 0 });
        setPhase('preview');
        mutation.reset();
        if (file === undefined) return;
        if (file.size > MAX_IMPORT_BYTES) {
            setError(importError('too-large'));
            return;
        }
        setReading(true);
        try {
            const text = await file.text();
            if (readAttempt.current !== attempt) return;
            const result = parsePasswordImport(text);
            if (result.kind !== 'parsed') setError(importError(result.kind));
            else {
                const known = new Set(records.map(importLoginKey));
                pending.current.passwords = result.passwords;
                setExisting(known);
                setPreview(result.preview);
                setSelected(
                    new Set(
                        result.preview.logins.filter((login) => !hasImportConflict(known, login)).map(({ id }) => id),
                    ),
                );
            }
        } catch {
            if (readAttempt.current === attempt) setError(importError('read'));
        } finally {
            if (readAttempt.current === attempt) setReading(false);
        }
    };

    const start = () => {
        const passwords = pending.current.passwords;
        if (preview === null || passwords === null || selected.size === 0 || phase !== 'preview') return;
        const batch = new WalletImportBatch(
            preview.logins
                .filter(({ id }) => selected.has(id))
                .map((login) => ({
                    ...login,
                    password: passwords.take(login.id),
                    replace: hasImportConflict(existing, login),
                })),
        );
        passwords.clear();
        pending.current.passwords = null;
        pending.current.batch = batch;
        setPhase('saving');
        mutation.mutate(batch, {
            onSuccess: () => {
                setPhase('done');
            },
            onError: (failure) => {
                setPhase(isStepUpRequired(classifyApiError(failure)) ? 'waiting' : 'failed');
            },
        });
    };

    const editable = phase === 'preview';
    const newLogins = preview?.logins.filter((login) => !hasImportConflict(existing, login)) ?? [];
    return (
        <Dialog
            open
            size="lg"
            title={m.wallet_import_title()}
            description={m.wallet_import_description()}
            onClose={close}
            footer={
                <>
                    <Button variant="ghost" onClick={close}>
                        {phase === 'done' || phase === 'failed' ? m.wallet_import_close() : m.wallet_cancel()}
                    </Button>
                    {editable ? (
                        <Button variant="primary" disabled={reading || selected.size === 0} onClick={start}>
                            {m.wallet_import_selected({ count: String(selected.size) })}
                        </Button>
                    ) : null}
                </>
            }
        >
            <p className="text-sm text-text-muted">{m.wallet_import_scope()}</p>
            <p className="text-sm text-text-muted">{m.wallet_import_plaintext()}</p>
            {editable ? (
                <Field label={m.wallet_import_file()} error={error} hint={m.wallet_import_formats()}>
                    {(control) => (
                        <Input
                            {...control}
                            type="file"
                            accept=".json,.csv,application/json,text/csv"
                            disabled={reading}
                            onChange={(event) => {
                                const file = event.currentTarget.files?.[0];
                                // Do not retain the file (or its name) in the DOM after reading it.
                                event.currentTarget.value = '';
                                void readFile(file);
                            }}
                        />
                    )}
                </Field>
            ) : null}
            {reading ? <p role="status">{m.wallet_import_reading()}</p> : null}
            {preview === null || !editable ? null : (
                <>
                    <p className="text-sm">{m.wallet_import_existing_hint()}</p>
                    {preview.skipped > 0 ? (
                        <p className="text-sm text-text-muted">
                            {m.wallet_import_skipped({ count: String(preview.skipped) })}
                        </p>
                    ) : null}
                    {preview.logins.length === 0 ? (
                        <p role="status">{m.wallet_import_empty()}</p>
                    ) : (
                        <>
                            <Checkbox
                                label={m.wallet_import_select_new()}
                                checked={newLogins.length > 0 && newLogins.every(({ id }) => selected.has(id))}
                                indeterminate={
                                    newLogins.some(({ id }) => selected.has(id)) &&
                                    !newLogins.every(({ id }) => selected.has(id))
                                }
                                onChange={(event) => {
                                    setSelected(
                                        event.currentTarget.checked
                                            ? new Set(newLogins.map(({ id }) => id))
                                            : new Set(),
                                    );
                                }}
                            />
                            <ul className="flex max-h-72 flex-col gap-3 overflow-auto py-1">
                                {preview.logins.map((login) => (
                                    <li key={login.id} className="[overflow-wrap:anywhere]">
                                        <Checkbox
                                            label={`${login.label || login.origin} · ${login.username}`}
                                            description={`${login.origin}${hasImportConflict(existing, login) ? ` · ${m.wallet_import_replaces()}` : ''}`}
                                            checked={selected.has(login.id)}
                                            onChange={(event) => {
                                                const next = new Set(selected);
                                                if (event.currentTarget.checked) next.add(login.id);
                                                else next.delete(login.id);
                                                setSelected(next);
                                            }}
                                        />
                                    </li>
                                ))}
                            </ul>
                        </>
                    )}
                </>
            )}
            {editable ? null : (
                <div role="status" className="flex flex-col gap-2 text-sm">
                    <p>{m.wallet_import_progress({ count: String(progress.saved), total: String(selected.size) })}</p>
                    {progress.skipped === 0 ? null : (
                        <p>{m.wallet_import_new_conflicts({ count: String(progress.skipped) })}</p>
                    )}
                    {phase === 'waiting' ? <p>{m.wallet_import_step_up()}</p> : null}
                    {phase === 'failed' ? <p>{m.wallet_import_partial()}</p> : null}
                    {phase === 'done' ? <p>{m.wallet_import_done()}</p> : null}
                    {phase === 'saving' ? <p>{m.wallet_import_cancel_hint()}</p> : null}
                </div>
            )}
        </Dialog>
    );
}
