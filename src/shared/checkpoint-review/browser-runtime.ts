/// <reference lib="dom" />

import { checkpointReviewPayloadError } from '../../schemas/checkpoint-review-constraints.js';
import {
  type CheckpointReviewDraft,
  type CheckpointReviewIdentity,
  buildCheckpointReviewResponse,
  checkpointReviewDraftRestoreNotice,
  checkpointReviewDraftSummary,
  checkpointReviewStorageKey,
  restoreCheckpointReviewDraft,
  selectCheckpointReviewChoice,
  setCheckpointReviewChoiceNote,
  setCheckpointReviewOverallNote,
} from './state.js';

type ChoiceBinding = {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly previewHref: string;
  readonly control: HTMLElement;
};

type RenderSelectionOptions = {
  readonly focus: boolean;
  readonly announce: boolean;
};

type WorkspaceAdapter = {
  readonly root: HTMLElement;
  readonly choices: readonly ChoiceBinding[];
  readonly defaultSelection: string;
  readonly comment: HTMLTextAreaElement | null;
  readonly overall: HTMLTextAreaElement | null;
  readonly saveState: HTMLElement | null;
  readonly dialog: HTMLDialogElement | null;
  readonly confirmTitle: HTMLElement | null;
  readonly confirmSummary: HTMLElement | null;
  readonly command: HTMLElement | null;
  readonly commandState: HTMLElement | null;
  readonly finishButtons: readonly HTMLElement[];
  readonly closeButtons: readonly HTMLElement[];
  readonly copyButtons: readonly HTMLElement[];
  readonly exportButtons: readonly HTMLElement[];
  readonly previousButtons: readonly HTMLElement[];
  readonly nextButtons: readonly HTMLElement[];
  renderSelection(draft: CheckpointReviewDraft, options: RenderSelectionOptions): void;
  refreshNoteBadges(draft: CheckpointReviewDraft): void;
};

function query<T extends Element>(root: ParentNode, selector: string): T | null {
  return root.querySelector<T>(selector);
}

function queryAll<T extends Element>(root: ParentNode, selector: string): readonly T[] {
  return Array.from(root.querySelectorAll<T>(selector));
}

function choiceIndex(choices: readonly ChoiceBinding[], selection: string): number {
  const index = choices.findIndex((choice) => choice.id === selection);
  return index < 0 ? 0 : index;
}

function wrapIndex(index: number, length: number): number {
  return ((index % length) + length) % length;
}

function noteCount(draft: CheckpointReviewDraft, choiceId: string): number {
  return (draft.notes[choiceId] ?? '').trim().length > 0 ? 1 : 0;
}

function setBadge(badge: HTMLElement | null, count: number): void {
  if (badge === null) return;
  badge.textContent = String(count);
  badge.hidden = count === 0;
}

function checkpointAdapter(root: HTMLElement): WorkspaceAdapter | undefined {
  const controls = queryAll<HTMLInputElement>(root, '[data-cp-option]');
  const choices = controls.map((control) => ({
    id: control.dataset.cpChoiceId ?? '',
    label: control.dataset.cpLabel ?? control.dataset.cpChoiceId ?? '',
    description: control.dataset.cpDescription ?? '',
    previewHref: '',
    control,
  }));
  const first = choices[0];
  if (first === undefined) return undefined;
  const selected = controls.find((control) => control.checked);
  const details = queryAll<HTMLElement>(root, '[data-cp-option-detail]');
  const selectedLabel = query<HTMLElement>(root, '[data-cp-selected-label]');
  const selectedDescription = query<HTMLElement>(root, '[data-cp-selected-description]');
  const footerLabel = query<HTMLElement>(root, '[data-cp-footer-label]');
  const live = query<HTMLElement>(root, '[data-cp-live]');

  const adapter: WorkspaceAdapter = {
    root,
    choices,
    defaultSelection: selected?.dataset.cpChoiceId ?? first.id,
    comment: query<HTMLTextAreaElement>(root, '[data-cp-comment]'),
    overall: query<HTMLTextAreaElement>(root, '[data-cp-overall-comment]'),
    saveState: query<HTMLElement>(root, '[data-cp-save-state]'),
    dialog: query<HTMLDialogElement>(root, '[data-cp-dialog]'),
    confirmTitle: query<HTMLElement>(root, '[data-cp-confirm-title]'),
    confirmSummary: query<HTMLElement>(root, '[data-cp-confirm-summary]'),
    command: query<HTMLElement>(root, '[data-cp-command]'),
    commandState: query<HTMLElement>(root, '[data-cp-command-state]'),
    finishButtons: queryAll<HTMLElement>(root, '[data-cp-finish]'),
    closeButtons: queryAll<HTMLElement>(root, '[data-cp-close-dialog]'),
    copyButtons: queryAll<HTMLElement>(root, '[data-cp-copy-decision]'),
    exportButtons: queryAll<HTMLElement>(root, '[data-cp-export]'),
    previousButtons: queryAll<HTMLElement>(root, '[data-cp-previous]'),
    nextButtons: queryAll<HTMLElement>(root, '[data-cp-next]'),
    renderSelection(draft, options) {
      const current = choices.find((choice) => choice.id === draft.selection) ?? first;
      for (const choice of choices) {
        const isSelected = choice.id === current.id;
        const input = choice.control as HTMLInputElement;
        input.checked = isSelected;
        input.tabIndex = isSelected ? 0 : -1;
      }
      for (const detail of details) detail.hidden = detail.dataset.cpChoiceId !== current.id;
      if (adapter.comment !== null) adapter.comment.value = draft.notes[current.id] ?? '';
      if (selectedLabel !== null) selectedLabel.textContent = current.label;
      if (selectedDescription !== null) {
        selectedDescription.textContent = current.description;
        selectedDescription.hidden = current.description.length === 0;
      }
      if (footerLabel !== null) footerLabel.textContent = current.label;
      if (options.announce && live !== null) live.textContent = `${current.label} selected`;
      adapter.refreshNoteBadges(draft);
      if (options.focus) current.control.focus();
    },
    refreshNoteBadges(draft) {
      for (const choice of choices) {
        const option = choice.control.closest<HTMLElement>('.cp-option');
        setBadge(
          query<HTMLElement>(option ?? choice.control, '[data-cp-note-count]'),
          noteCount(draft, choice.id),
        );
      }
    },
  };
  return adapter;
}

function multiVariantAdapter(root: HTMLElement): WorkspaceAdapter | undefined {
  const tabs = queryAll<HTMLElement>(root, '[data-mv-option]');
  const choices = tabs.map((tab) => ({
    id: tab.dataset.mvVariantId ?? '',
    label: tab.dataset.mvLabel ?? tab.dataset.mvVariantId ?? '',
    description: '',
    previewHref: tab.dataset.mvPreviewSrc ?? '',
    control: tab,
  }));
  const first = choices[0];
  if (first === undefined) return undefined;
  const selected = tabs.find((tab) => tab.getAttribute('aria-selected') === 'true');
  const panels = queryAll<HTMLElement>(root, '[data-mv-panel]');
  const inspectors = queryAll<HTMLElement>(root, '[data-mv-inspector]');
  const title = query<HTMLElement>(root, '[data-mv-stage-title]');
  const position = query<HTMLElement>(root, '[data-mv-position]');
  const open = query<HTMLAnchorElement>(root, '[data-mv-open]');
  const live = query<HTMLElement>(root, '[data-mv-live]');

  const adapter: WorkspaceAdapter = {
    root,
    choices,
    defaultSelection: selected?.dataset.mvVariantId ?? first.id,
    comment: query<HTMLTextAreaElement>(root, '[data-mv-comment]'),
    overall: query<HTMLTextAreaElement>(root, '[data-mv-overall-comment]'),
    saveState: query<HTMLElement>(root, '[data-mv-save-state]'),
    dialog: query<HTMLDialogElement>(root, '[data-mv-dialog]'),
    confirmTitle: query<HTMLElement>(root, '[data-mv-confirm-title]'),
    confirmSummary: query<HTMLElement>(root, '[data-mv-confirm-summary]'),
    command: query<HTMLElement>(root, '[data-mv-command]'),
    commandState: query<HTMLElement>(root, '[data-mv-command-state]'),
    finishButtons: queryAll<HTMLElement>(root, '[data-mv-finish]'),
    closeButtons: queryAll<HTMLElement>(root, '[data-mv-close-dialog]'),
    copyButtons: queryAll<HTMLElement>(root, '[data-mv-copy-decision]'),
    exportButtons: queryAll<HTMLElement>(root, '[data-mv-export]'),
    previousButtons: queryAll<HTMLElement>(root, '[data-mv-previous]'),
    nextButtons: queryAll<HTMLElement>(root, '[data-mv-next]'),
    renderSelection(draft, options) {
      const currentIndex = choiceIndex(choices, draft.selection);
      const current = choices[currentIndex] ?? first;
      for (const choice of choices) {
        const isSelected = choice.id === current.id;
        choice.control.setAttribute('aria-selected', String(isSelected));
        choice.control.tabIndex = isSelected ? 0 : -1;
      }
      for (const panel of panels) panel.hidden = panel.dataset.mvVariantId !== current.id;
      for (const inspector of inspectors) {
        inspector.hidden = inspector.dataset.mvVariantId !== current.id;
      }
      if (adapter.comment !== null) adapter.comment.value = draft.notes[current.id] ?? '';
      if (title !== null) title.textContent = current.label;
      if (position !== null) position.textContent = `${currentIndex + 1} of ${choices.length}`;
      if (open !== null) {
        open.hidden = current.previewHref.length === 0;
        if (current.previewHref.length > 0) open.href = current.previewHref;
        else open.removeAttribute('href');
      }
      if (options.announce && live !== null) live.textContent = `${current.label} selected`;
      adapter.refreshNoteBadges(draft);
      if (options.focus) current.control.focus();
    },
    refreshNoteBadges(draft) {
      for (const choice of choices) {
        setBadge(
          query<HTMLElement>(choice.control, '[data-mv-note-count]'),
          noteCount(draft, choice.id),
        );
      }
    },
  };
  return adapter;
}

function identityFor(root: HTMLElement): CheckpointReviewIdentity {
  return {
    runId: root.dataset.runId ?? '',
    stepId: root.dataset.stepId ?? '',
    attempt: Number(root.dataset.attempt ?? '0'),
    requestSha256: root.dataset.requestSha256 ?? '',
  };
}

function readSavedDraft(
  storageKey: string,
  saveState: HTMLElement | null,
): { readonly saved: unknown; readonly storageAvailable: boolean } {
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(storageKey);
  } catch {
    if (saveState !== null) saveState.textContent = 'Draft won’t survive reload';
    return { saved: undefined, storageAvailable: false };
  }
  if (raw === null) return { saved: undefined, storageAvailable: true };
  try {
    return { saved: JSON.parse(raw) as unknown, storageAvailable: true };
  } catch {
    if (saveState !== null) saveState.textContent = 'Saved draft couldn’t be read. Starting fresh.';
    return { saved: undefined, storageAvailable: true };
  }
}

function encodeReviewToken(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `ckr1.${btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')}`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function summaryText(draft: CheckpointReviewDraft, choiceIds: readonly string[]): string {
  const summary = checkpointReviewDraftSummary(draft, choiceIds);
  const comments = `${summary.choiceCommentCount} option ${
    summary.choiceCommentCount === 1 ? 'comment' : 'comments'
  }`;
  const overall = summary.hasOverallComment ? 'Overall note added' : 'No overall note';
  const visited =
    summary.unvisitedCount === 0
      ? 'All options visited'
      : `${summary.unvisitedCount} ${summary.unvisitedCount === 1 ? 'option' : 'options'} unvisited`;
  return `${comments} · ${overall} · ${visited}`;
}

function mountWorkspace(adapter: WorkspaceAdapter): void {
  const identity = identityFor(adapter.root);
  const choiceIds = adapter.choices.map((choice) => choice.id);
  const storageKey = checkpointReviewStorageKey(identity);
  const loaded = readSavedDraft(storageKey, adapter.saveState);
  let storageAvailable = loaded.storageAvailable;
  const restoreNotice = checkpointReviewDraftRestoreNotice(loaded.saved, {
    choiceIds,
    defaultSelection: adapter.defaultSelection,
  });
  let draft = restoreCheckpointReviewDraft(loaded.saved, {
    choiceIds,
    defaultSelection: adapter.defaultSelection,
  });
  if (restoreNotice !== undefined && adapter.saveState !== null) {
    adapter.saveState.textContent = restoreNotice;
  }
  let dialogTrigger: HTMLElement | null = null;

  function restoreDialogFocus(): void {
    const trigger = dialogTrigger;
    dialogTrigger = null;
    trigger?.focus();
  }

  function persist(): void {
    if (!storageAvailable) {
      if (adapter.saveState !== null) adapter.saveState.textContent = 'Draft won’t survive reload';
      return;
    }
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(draft));
      if (adapter.saveState !== null) adapter.saveState.textContent = 'Saved in this browser';
    } catch {
      storageAvailable = false;
      if (adapter.saveState !== null) adapter.saveState.textContent = 'Draft won’t survive reload';
    }
  }

  function invalidatePreparedDecision(): void {
    if (adapter.command !== null) {
      adapter.command.hidden = true;
      adapter.command.textContent = '';
    }
    if (adapter.commandState !== null) adapter.commandState.textContent = '';
  }

  function refreshSummary(): void {
    const current = adapter.choices.find((choice) => choice.id === draft.selection);
    if (adapter.confirmTitle !== null) {
      adapter.confirmTitle.textContent = current?.label ?? draft.selection;
    }
    if (adapter.confirmSummary !== null) {
      adapter.confirmSummary.textContent = summaryText(draft, choiceIds);
    }
  }

  function syncFields(): void {
    if (adapter.comment !== null) {
      draft = setCheckpointReviewChoiceNote(
        draft,
        draft.selection,
        adapter.comment.value,
        choiceIds,
      );
    }
    if (adapter.overall !== null) {
      draft = setCheckpointReviewOverallNote(draft, adapter.overall.value);
    }
  }

  function select(choiceId: string, focus: boolean): void {
    syncFields();
    draft = selectCheckpointReviewChoice(draft, choiceId, choiceIds);
    adapter.renderSelection(draft, { focus, announce: true });
    refreshSummary();
    persist();
    invalidatePreparedDecision();
  }

  function selectOffset(offset: number, focus: boolean): void {
    const current = choiceIndex(adapter.choices, draft.selection);
    const next = adapter.choices[wrapIndex(current + offset, adapter.choices.length)];
    if (next !== undefined) select(next.id, focus);
  }

  function response() {
    syncFields();
    return buildCheckpointReviewResponse(draft, identity, choiceIds);
  }

  function showValidationError(message: string): void {
    if (adapter.command !== null) {
      adapter.command.hidden = true;
      adapter.command.textContent = '';
    }
    if (adapter.commandState !== null) adapter.commandState.textContent = message;
  }

  async function prepareDecision(): Promise<void> {
    const value = response();
    persist();
    refreshSummary();
    const validation = checkpointReviewPayloadError(value);
    if (validation !== undefined) {
      showValidationError(validation);
      return;
    }
    const resumePrefix = adapter.root.dataset.resumePrefix ?? 'circuit resume';
    const runFolder = adapter.root.dataset.runFolder ?? '';
    const command = `${resumePrefix} --run-folder ${shellQuote(
      runFolder,
    )} --checkpoint-response ${shellQuote(encodeReviewToken(value))}`;
    if (adapter.command !== null) {
      adapter.command.textContent = command;
      adapter.command.hidden = false;
    }
    try {
      if (navigator.clipboard === undefined) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(command);
      if (adapter.commandState !== null) {
        adapter.commandState.textContent =
          'Decision prepared — paste the command in your terminal.';
      }
    } catch {
      if (adapter.commandState !== null) {
        adapter.commandState.textContent = 'Decision prepared — copy the command shown above.';
      }
    }
  }

  function exportDecision(): void {
    const value = response();
    persist();
    refreshSummary();
    const validation = checkpointReviewPayloadError(value);
    if (validation !== undefined) {
      showValidationError(validation);
      return;
    }
    const blob = new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'checkpoint-review.json';
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  // Hydration is deliberately read-only. It renders the restored selection
  // and notes without passing through select(), which is a user-action path.
  if (adapter.overall !== null) adapter.overall.value = draft.overall;
  adapter.renderSelection(draft, { focus: false, announce: false });
  refreshSummary();

  for (const choice of adapter.choices) {
    choice.control.addEventListener('click', () => select(choice.id, false));
    choice.control.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
        event.preventDefault();
        selectOffset(1, true);
      } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
        event.preventDefault();
        selectOffset(-1, true);
      } else if (event.key === 'Home') {
        event.preventDefault();
        const first = adapter.choices[0];
        if (first !== undefined) select(first.id, true);
      } else if (event.key === 'End') {
        event.preventDefault();
        const last = adapter.choices[adapter.choices.length - 1];
        if (last !== undefined) select(last.id, true);
      }
    });
  }

  for (const button of adapter.previousButtons) {
    button.addEventListener('click', () => selectOffset(-1, false));
  }
  for (const button of adapter.nextButtons) {
    button.addEventListener('click', () => selectOffset(1, false));
  }
  if (adapter.comment !== null) {
    adapter.comment.addEventListener('input', () => {
      draft = setCheckpointReviewChoiceNote(
        draft,
        draft.selection,
        adapter.comment?.value ?? '',
        choiceIds,
      );
      adapter.refreshNoteBadges(draft);
      refreshSummary();
      persist();
      invalidatePreparedDecision();
    });
  }
  if (adapter.overall !== null) {
    adapter.overall.addEventListener('input', () => {
      draft = setCheckpointReviewOverallNote(draft, adapter.overall?.value ?? '');
      refreshSummary();
      persist();
      invalidatePreparedDecision();
    });
  }
  adapter.dialog?.addEventListener('close', restoreDialogFocus);
  for (const button of adapter.finishButtons) {
    button.addEventListener('click', () => {
      dialogTrigger = button;
      syncFields();
      persist();
      refreshSummary();
      if (adapter.dialog !== null && typeof adapter.dialog.showModal === 'function') {
        adapter.dialog.showModal();
      } else {
        adapter.dialog?.setAttribute('open', '');
      }
    });
  }
  for (const button of adapter.closeButtons) {
    button.addEventListener('click', () => {
      if (adapter.dialog !== null && typeof adapter.dialog.close === 'function') {
        adapter.dialog.close();
      } else {
        adapter.dialog?.removeAttribute('open');
        restoreDialogFocus();
      }
    });
  }
  for (const button of adapter.copyButtons) {
    button.addEventListener('click', () => {
      void prepareDecision();
    });
  }
  for (const button of adapter.exportButtons) {
    button.addEventListener('click', exportDecision);
  }
}

const checkpointRoot = document.querySelector<HTMLElement>('[data-cp-workspace]');
if (checkpointRoot !== null) {
  const adapter = checkpointAdapter(checkpointRoot);
  if (adapter !== undefined) mountWorkspace(adapter);
}

const multiVariantRoot = document.querySelector<HTMLElement>('[data-mv-workspace]');
if (multiVariantRoot !== null) {
  const adapter = multiVariantAdapter(multiVariantRoot);
  if (adapter !== undefined) mountWorkspace(adapter);
}
