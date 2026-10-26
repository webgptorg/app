export {
    applyTheme,
    persistThemePreference,
    readThemePreference,
    resolveTheme,
    THEME_PREFERENCES,
    THEME_STORAGE_KEY,
} from './theme/preference';
export type { MatchMedia, PreferenceStorage, ResolvedTheme, ThemePreference } from './theme/preference';

export { canUseViewTransitions, withViewTransition } from './motion/view-transition';
export type { ViewTransitionDocument } from './motion/view-transition';
export { prefersReducedMotion, useReducedMotion } from './motion/reduced-motion';
export type { MotionMatchMedia } from './motion/reduced-motion';
export { loadMotion, useMotion } from './motion/lazy-motion';
export type { MotionModule } from './motion/lazy-motion';

export { createFormatters } from './i18n/formatters';
export type { Formatters } from './i18n/formatters';
export { UiProvider, useLocale, useUiMessages } from './i18n/ui-provider';
export type { UiProviderProps } from './i18n/ui-provider';
export type { UiMessages } from './i18n/ui-messages';

export { Button, buttonClassName } from './components/button/button';
export type { ButtonProps, ButtonSize, ButtonVariant } from './components/button/button';
export { IconButton } from './components/icon-button/icon-button';
export type { IconButtonProps } from './components/icon-button/icon-button';
export { Field } from './components/field/field';
export type { FieldControlProps, FieldProps } from './components/field/field';
export { Input } from './components/input/input';
export type { InputProps } from './components/input/input';
export { Textarea } from './components/textarea/textarea';
export type { TextareaProps } from './components/textarea/textarea';
export { Select } from './components/select/select';
export type { SelectProps } from './components/select/select';
export { Checkbox } from './components/checkbox/checkbox';
export type { CheckboxProps } from './components/checkbox/checkbox';
export { Switch } from './components/switch/switch';
export type { SwitchProps } from './components/switch/switch';
export { Anchor } from './components/anchor/anchor';
export type { AnchorProps, AnchorVariant } from './components/anchor/anchor';
export { ExternalLink } from './components/external-link/external-link';
export type { ExternalLinkProps } from './components/external-link/external-link';
export { Card } from './components/card/card';
export type { CardProps } from './components/card/card';
export { Badge } from './components/badge/badge';
export type { BadgeProps, BadgeTone } from './components/badge/badge';
export { Banner } from './components/banner/banner';
export type { BannerProps, BannerTone } from './components/banner/banner';
export { Monogram } from './components/monogram/monogram';
export type { MonogramProps } from './components/monogram/monogram';
export { Skeleton } from './components/skeleton/skeleton';
export type { SkeletonProps } from './components/skeleton/skeleton';
export { EmptyState } from './components/empty-state/empty-state';
export type { EmptyStateProps } from './components/empty-state/empty-state';
export { ErrorState } from './components/error-state/error-state';
export type { ErrorStateProps } from './components/error-state/error-state';
export { Pagination } from './components/pagination/pagination';
export type { PaginationProps } from './components/pagination/pagination';
export { CodeText } from './components/code-text/code-text';
export type { CodeTextProps } from './components/code-text/code-text';
export { COPY_FEEDBACK_MS, CopyButton } from './components/copy-button/copy-button';
export type { CopyButtonProps } from './components/copy-button/copy-button';
export { RelativeTime } from './components/relative-time/relative-time';
export type { RelativeTimeProps } from './components/relative-time/relative-time';
export { SkipLink } from './components/skip-link/skip-link';
export type { SkipLinkProps } from './components/skip-link/skip-link';
export { Dialog } from './components/dialog/dialog';
export type { DialogProps, DialogSize } from './components/dialog/dialog';
export { ConfirmDialog } from './components/confirm-dialog/confirm-dialog';
export type { ConfirmDialogProps } from './components/confirm-dialog/confirm-dialog';
export { Drawer } from './components/drawer/drawer';
export type { DrawerProps, DrawerSide } from './components/drawer/drawer';
export { CommandPalette } from './components/command-palette/command-palette';
export type {
    CommandPaletteGroup,
    CommandPaletteItem,
    CommandPaletteProps,
} from './components/command-palette/command-palette';
export { Menu } from './components/menu/menu';
export type {
    MenuEntry,
    MenuHeadingEntry,
    MenuItemEntry,
    MenuLinkEntry,
    MenuProps,
    MenuSeparatorEntry,
    MenuTriggerProps,
} from './components/menu/menu';
export { Tabs } from './components/tabs/tabs';
export type { TabDefinition, TabsProps, TabTriggerProps } from './components/tabs/tabs';
export { Toaster } from './components/toaster/toaster';
export { DEFAULT_TOAST_DURATION_MS, useToast } from './components/toaster/toast-store';
export type {
    ToastApi,
    ToastInput,
    ToastPromiseMessages,
    ToastRecord,
    ToastTone,
} from './components/toaster/toast-store';
export { Spinner } from './components/spinner/spinner';
export type { SpinnerProps } from './components/spinner/spinner';
export { VisuallyHidden } from './components/visually-hidden/visually-hidden';
export type { VisuallyHiddenProps } from './components/visually-hidden/visually-hidden';

export { useZodForm } from './forms/use-zod-form';
export type { UseZodFormOptions, ZodForm } from './forms/use-zod-form';
export { Form, FormSubmit } from './forms/form';
export type { FormProps, FormSubmitProps } from './forms/form';
export { errorMessage, FormField } from './forms/form-field';
export type { CheckboxControlProps, FormFieldControl, FormFieldProps, TextControlProps } from './forms/form-field';
export { applyServerErrors, toFieldName } from './forms/server-errors';
export type { ServerFieldError } from './forms/server-errors';
export { SensitiveInput, useSensitiveInput } from './forms/sensitive-input';
export type { SensitiveInputHandle, SensitiveInputProps } from './forms/sensitive-input';

export { FINGERPRINT_COLOURS, FINGERPRINT_GRID_SIZE, fingerprintColour } from './components/trust-mark/fingerprint';
export type { TrustMarkFingerprint } from './components/trust-mark/fingerprint';
export { TrustMark } from './components/trust-mark/trust-mark';
export type { TrustMarkProps, TrustMarkSize, TrustMarkState } from './components/trust-mark/trust-mark';

export { columnLabel, DataTable } from './components/data-table/data-table';
export type {
    DataTableEmpty,
    DataTableError,
    DataTableExpansion,
    DataTablePage,
    DataTableProps,
    DataTableSelection,
} from './components/data-table/data-table';
export { createDataTableColumnHelper, dataTableFeatures } from './components/data-table/columns';
export type {
    ColumnFilter,
    ColumnFiltersState,
    ColumnSort,
    ColumnVisibilityState,
    DataTableCellContext,
    DataTableColumnDef,
    DataTableColumnFilter,
    DataTableColumnHelper,
    DataTableColumnMeta,
    DataTableFeatures,
    DataTableFilterOption,
    DataTableHeaderContext,
    DataTableRow,
    RowData,
    RowSelectionState,
    SortingState,
} from './components/data-table/columns';
export type { DataTableStorage } from './components/data-table/visibility-storage';

export { EngineSwitcher } from './components/engine-switcher/engine-switcher';
export type {
    CurrentEngine,
    EngineStatus,
    EngineSwitcherProps,
    SwitchableEngine,
} from './components/engine-switcher/engine-switcher';

export { Gallery, GALLERY_ENTRIES } from './gallery';
export type { GalleryEntry } from './gallery-entry';

/** For apps' jsdom tests: stand-ins for `<dialog>`, the Popover API and `matchMedia`. Tree-shaken from bundles. */
export { installDomGaps, setMedia } from './testing/dom-gaps';
