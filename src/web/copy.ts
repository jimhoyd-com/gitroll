/*
  Every sentence the interface says, in one place.

  Tone: plain and warm, the way you'd explain your own filing system to a
  friend. Never chirpy, never clever. People log hard things here — a flooded
  basement, a diagnosis, money they'd rather not have spent — so nothing jokes
  and nothing congratulates. Say what happened, say what it means, stop.
*/

export const COPY = {
  // Saving
  saved: "Saved.",
  savedWithFiles: (n: number) => `Saved, with ${n === 1 ? "the file" : `${n} files`}.`,
  edited: "Saved. The earlier version is in History.",
  deleted: "Gone from your timeline. Git still has it in History.",
  confirmDeleteTitle: "Delete this event?",
  confirmDeleteBody: "It disappears from your timeline, but it stays in History and in your Git repository. Nothing is really lost.",
  confirmDeleteAction: "Delete",
  confirmDiscardTitle: "Throw this away?",
  confirmDiscardBody: "You've written something that hasn't been saved yet.",
  confirmDiscardAction: "Discard",
  keepWriting: "Keep writing",
  draftKept: "Picked up where you left off. This draft is kept in this browser until you save or discard it.",
  draftFiles: (names: string[]) =>
    `${names.length === 1 ? "The file" : "The files"} you attached (${names.join(", ")}) ${names.length === 1 ? "isn't" : "aren't"} kept in a draft — attach ${names.length === 1 ? "it" : "them"} again before saving.`,
  draftDiscarded: "Draft discarded.",
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

  // Topics
  topic: "Topic",
  topics: "Topics",
  newTopic: "New topic",
  newTopicTitle: "Name this topic",
  newTopicBody: "A topic groups related events — a house, a car, a client, a year.",
  newTopicLabel: "Name",
  newTopicPlaceholder: "Kitchen, Volvo, Mum's care…",
  topicsEmpty: "Topics keep related events together — a house, a car, a client. You don't need one to start logging.",

  // Sync
  notBackedUp: "On this computer only",
  notBackedUpHint: "Your events are saved here and committed to Git. To copy them somewhere safe, run: gitroll backup",
  syncedJustNow: "Backed up",
  backUpWhenReady: "Your events are saved and committed here. Back up when you're ready — GitRoll never uploads on its own.",
  syncing: "Backing up…",
  syncFailed: "Couldn't back up",
  retry: "Try again",
  pendingChanges: (n: number) => `${n} ${n === 1 ? "change" : "changes"} waiting to back up`,

  // Ask
  askPlaceholder: "Ask your Roll a question, like: when was the boiler last serviced?",
  askThinking: "Reading your events…",
  askCaveat: "Answers come from the events below, and they can still be wrong. The events are the record.",
  askNoSources: "Nothing in your Roll seemed to answer that.",
  close: "Close",

  // Shortcuts
  shortcutsTitle: "Keyboard shortcuts",
} as const;

/** A description of what a filter does, for the chip that represents it. */
export const FILTER_HELP: Record<string, string> = {
  topic: "in this topic",
  tag: "with this tag",
  type: "of this type",
  has: "that have",
  after: "on or after",
  before: "on or before",
  on: "on",
  amount: "for an amount",
  author: "logged by",
};
