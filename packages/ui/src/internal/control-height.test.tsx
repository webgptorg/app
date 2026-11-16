import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Button } from '../components/button/button';
import { Combobox } from '../components/combobox/combobox';
import { DateInput } from '../components/date-input/date-input';
import { Input } from '../components/input/input';
import { Select } from '../components/select/select';
import { Textarea } from '../components/textarea/textarea';
import { renderUi } from '../testing/render';
import { CONTROL_HEIGHT } from './control';

describe('control height', () => {
    it('is one min-height for every control that shares a line', () => {
        renderUi(
            <>
                <Input aria-label="input" />
                <Select aria-label="select">
                    <option>{'One'}</option>
                </Select>
                <Textarea aria-label="textarea" rows={1} />
                <Combobox
                    aria-label="combobox"
                    options={[{ value: 'a', label: 'A' }]}
                    value="a"
                    onChange={() => undefined}
                />
                <DateInput aria-label="date" />
                <Button>{'button'}</Button>
            </>,
        );
        const controls = [
            screen.getByRole('textbox', { name: 'input' }),
            screen.getByRole('combobox', { name: 'select' }),
            screen.getByRole('textbox', { name: 'textarea' }),
            screen.getByRole('combobox', { name: 'combobox' }),
            screen.getByLabelText('date'),
            screen.getByRole('button', { name: 'button' }),
        ];
        for (const control of controls) expect(control.className.split(' ')).toContain(CONTROL_HEIGHT.md);
        expect(CONTROL_HEIGHT.md).toBe('min-h-9');
    });
});
