// What counts as a tag, for the app, is what counts as a tag for the Roll.
//
// The browser used to have a hashtag regex of its own. It disagreed with the
// parser about `#include` inside a code fence, so the app could show a tag the
// Roll hadn't filed — two answers to one question, in the one place where
// people are entitled to assume there is only one.

import { extractHashtags, normalizeTag } from "../../core/entry.ts";

/** The #tags in a body, as the Roll will store them. */
export function tagsIn(text: string): string[] {
  return [...new Set(extractHashtags(text).map(normalizeTag).filter(Boolean))];
}

/**
 * The tags that aren't written in the text — set from the CLI, or left in the
 * front matter by an edit. The ones in the text are already on screen, and
 * already clickable, where their author put them, so showing them again says
 * the same thing twice and makes one tag look like two.
 */
export function frontMatterTags(entry: { tags: string[]; body: string }): string[] {
  const inBody = new Set(tagsIn(entry.body));
  return entry.tags.filter((t) => !inBody.has(t));
}
