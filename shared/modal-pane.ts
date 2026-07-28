// Detect whether a captured tmux pane is sitting on a MODAL Claude Code picker
// (tool-permission confirm, /model chooser, plan review, AskUserQuestion …).
//
// Why the mirror cares: a modal picker eats pasted text and reads Enter as
// "confirm the highlighted option". Injecting a WeCom message into one loses
// the message AND answers a permission prompt on the user's behalf — the user
// sees their session silently skip their input while a file edit they never
// approved goes through.
//
// The blocking case that motivated this: editing any file under `.claude/**`
// makes Claude Code raise its own "allow Claude to edit its own settings"
// confirm. That confirm does NOT go through the PreToolUse hook, so weclaude
// never learns about it, never sends a card, and the pane blocks until someone
// presses a key locally.
//
// Kept as a pure function over captured text so it is unit-testable without a
// live tmux server.

// A highlighted numbered option row: "❯ 1. Yes". The `❯` glyph alone is NOT
// evidence — the normal input box renders one too — so the digit + dot +
// non-space content are all load-bearing.
const MODAL_OPTION_ROW = /^\s*[❯>]\s*\d+\.\s+\S/mu;

// Picker footer. Present on every modal picker, absent from the idle input box.
const MODAL_FOOTER = /Esc to cancel/iu;

// Title line of the confirm, surfaced in the failure reason so the user knows
// what is waiting for them. Optional — detection never depends on it.
const MODAL_TITLE = /^\s*((?:Do|Would|Should) you .+?)\s*$/mu;

export interface ModalPaneVerdict {
  modal: boolean;
  /** Confirm title, when the pane exposed a recognizable one. */
  title?: string;
}

/**
 * Conservative by construction: BOTH an option row and the footer must be
 * present. A false positive blocks a legitimate message, which is worse than
 * missing an exotic picker layout — an "Esc to cancel" appearing inside pasted
 * text cannot fabricate a numbered option row above itself, and a message that
 * merely lists "1. …" cannot fabricate the footer.
 */
export const isModalPane = (pane: string): ModalPaneVerdict => {
  if (!pane || !MODAL_OPTION_ROW.test(pane) || !MODAL_FOOTER.test(pane)) return { modal: false };
  return { modal: true, title: pane.match(MODAL_TITLE)?.[1] };
};
