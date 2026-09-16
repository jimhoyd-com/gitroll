/*
  Every sentence the interface says, in one place.

  Tone: plain and warm, the way you'd explain your own filing system to a
  friend. Never chirpy, never clever. People log hard things here — a flooded
  basement, a diagnosis, money they'd rather not have spent — so nothing jokes
  and nothing congratulates. Say what happened, say what it means, stop.
*/

/** How the browser carries out the safety advice. Backing up the first time is a terminal step. */
export const WEB_SAFETY = {
  backup: "To copy them somewhere safe, run: gitroll backup",
  sync: "Back up now to send them there.",
};

export const COPY = {
  // Saving
  saved: "Saved.",
  savedWithFiles: (n: number) => `Saved, with ${n === 1 ? "the file" : `${n} files`}.`,
  edited: "Saved. The earlier version is in History.",
  undoDelete: "Put it back",
  removedLink: "Deleted something by mistake?",
  restored: "Put back, as a new commit. The deletion is still in the history.",
  deleted: "Gone from your timeline. Git still has it in History.",
  confirmDeleteTitle: "Delete this event?",
  confirmDeleteBody: "It disappears from your timeline, but it stays in History and in your Git repository. Nothing is really lost.",
  confirmDeleteAction: "Delete",
  confirmDiscardTitle: "Throw this away?",
  confirmDiscardBody: "You've written something that hasn't been saved yet.",
  confirmDiscardAction: "Discard",
  keepWriting: "Keep writing",
  badAmount: "That amount didn't make sense. Try 1850, $1,850 or 1850 EUR.",

  // Connection
  stoppedTitle: "GitRoll isn't running",
  stoppedBody: "It runs on your computer, so nothing works until you start it again.",
  stoppedHint: "In your terminal:",
  signedOutTitle: "Open GitRoll from your terminal",
  signedOutBody: "The link your terminal printed is what signs this browser in. It's how GitRoll keeps your Roll to yourself.",

  // Timeline
  emptyTitle: "Nothing here yet",
  emptyBody: "Write down what happened. You'll be glad you did when you're trying to remember it in two years.",
  emptyAction: "Log the first thing",
  noMatches: "Nothing matches that.",
  noMatchesHint: "Try fewer filters, or a different word.",
  clearFilters: "Clear the search",
  loadMore: "Show older",
  showingCount: (shown: number, total: number) => `Showing ${shown} of ${total}`,

  // Composer
  composerPlaceholder: "What happened?",
  composerHint: "Markdown works. #tags and amounts like $40 are picked up as you type.",
  composerOpen: "Log something",
  saveEntry: "Save",
  saving: "Saving…",
  moreOptions: "More",
  attachHint: "Drop a photo or file here, or paste one.",
  tooLarge: (name: string, mb: number) => `${name} is bigger than ${mb} MB, so it stayed out. Everything else is fine.`,

  // Sync
  syncing: "Backing up…",
  syncFailed: "Couldn't back up",
  retry: "Try again",

  // Dialogs
  close: "Close",

  // Shortcuts
  shortcutsTitle: "Keyboard shortcuts",
} as const;

/** A description of what a filter does, for the chip that represents it. */
export const FILTER_HELP: Record<string, string> = {
  tag: "with this tag",
  type: "of this type",
  has: "that have",
  after: "on or after",
  before: "on or before",
  on: "on",
  amount: "for an amount",
  author: "logged by",
};
