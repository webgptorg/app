import { actionMenuGallery } from './components/action-menu/action-menu.gallery';
import { filterBarGallery } from './components/filter-bar/filter-bar.gallery';
import { tooltipGallery } from './components/tooltip/tooltip.gallery';
import { emptyValueGallery } from './components/empty-value/empty-value.gallery';
import { technicalDetailsGallery } from './components/technical-details/technical-details.gallery';
import { iconButtonGallery } from './components/icon-button/icon-button.gallery';
import { fieldGallery } from './components/field/field.gallery';
import { inputGallery } from './components/input/input.gallery';
import { textareaGallery } from './components/textarea/textarea.gallery';
import { selectGallery } from './components/select/select.gallery';
import { checkboxGallery } from './components/checkbox/checkbox.gallery';
import { switchGallery } from './components/switch/switch.gallery';
import { anchorGallery } from './components/anchor/anchor.gallery';
import { externalLinkGallery } from './components/external-link/external-link.gallery';
import { cardGallery } from './components/card/card.gallery';
import { badgeGallery } from './components/badge/badge.gallery';
import { bannerGallery } from './components/banner/banner.gallery';
import { monogramGallery } from './components/monogram/monogram.gallery';
import { skeletonGallery } from './components/skeleton/skeleton.gallery';
import { emptyStateGallery } from './components/empty-state/empty-state.gallery';
import { errorStateGallery } from './components/error-state/error-state.gallery';
import { paginationGallery } from './components/pagination/pagination.gallery';
import { codeTextGallery } from './components/code-text/code-text.gallery';
import { commandPaletteGallery } from './components/command-palette/command-palette.gallery';
import { copyButtonGallery } from './components/copy-button/copy-button.gallery';
import { relativeTimeGallery } from './components/relative-time/relative-time.gallery';
import { skipLinkGallery } from './components/skip-link/skip-link.gallery';
import { dialogGallery } from './components/dialog/dialog.gallery';
import { confirmDialogGallery } from './components/confirm-dialog/confirm-dialog.gallery';
import { drawerGallery } from './components/drawer/drawer.gallery';
import { menuGallery } from './components/menu/menu.gallery';
import { tabsGallery } from './components/tabs/tabs.gallery';
import { toasterGallery } from './components/toaster/toaster.gallery';
import { engineSwitcherGallery } from './components/engine-switcher/engine-switcher.gallery';
import { languageSwitchGallery } from './components/language-switch/language-switch.gallery';
import { dataTableGallery } from './components/data-table/data-table.gallery';
import { buttonGallery } from './components/button/button.gallery';
import { spinnerGallery } from './components/spinner/spinner.gallery';
import { trustMarkGallery } from './components/trust-mark/trust-mark.gallery';
import { visuallyHiddenGallery } from './components/visually-hidden/visually-hidden.gallery';
import { formsGallery } from './forms/forms.gallery';
import type { GalleryEntry } from './gallery-entry';

/** Every component module's gallery entry, in alphabetical order. */
export const GALLERY_ENTRIES: readonly GalleryEntry[] = [
    actionMenuGallery,
    anchorGallery,
    badgeGallery,
    bannerGallery,
    buttonGallery,
    cardGallery,
    checkboxGallery,
    codeTextGallery,
    commandPaletteGallery,
    confirmDialogGallery,
    dataTableGallery,
    copyButtonGallery,
    dialogGallery,
    drawerGallery,
    emptyStateGallery,
    emptyValueGallery,
    engineSwitcherGallery,
    errorStateGallery,
    externalLinkGallery,
    fieldGallery,
    filterBarGallery,
    formsGallery,
    iconButtonGallery,
    inputGallery,
    languageSwitchGallery,
    menuGallery,
    paginationGallery,
    relativeTimeGallery,
    selectGallery,
    monogramGallery,
    skeletonGallery,
    skipLinkGallery,
    spinnerGallery,
    switchGallery,
    tabsGallery,
    technicalDetailsGallery,
    textareaGallery,
    toasterGallery,
    tooltipGallery,
    trustMarkGallery,
    visuallyHiddenGallery,
];

/**
 * Every component in every state. A developer and test tool: engine-ui mounts it only in its `test:csp` build, which
 * visits it in both themes, both languages and with reduced motion under the engine's CSP.
 */
export function Gallery() {
    return (
        <div data-ptbk-gallery="" className="flex flex-col gap-10">
            {GALLERY_ENTRIES.map((entry) => (
                <section key={entry.id} aria-labelledby={`gallery-${entry.id}`} className="flex flex-col gap-4">
                    <h2 id={`gallery-${entry.id}`} className="text-xl font-semibold">
                        {entry.title}
                    </h2>
                    {entry.render()}
                </section>
            ))}
        </div>
    );
}
