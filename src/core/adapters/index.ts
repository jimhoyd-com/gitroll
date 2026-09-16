import type { Adapter } from "../adapter.ts";
import { ciAdapter } from "./ci.ts";
import { githubAdapter } from "./github.ts";
import { webhookAdapter } from "./webhook.ts";

/** Built-in adapters. Others implement the same `Adapter` interface. */
export const ADAPTERS: Adapter[] = [githubAdapter, ciAdapter, webhookAdapter];

export { ciAdapter, githubAdapter, webhookAdapter };

export function getAdapter(id: string): Adapter | undefined {
  return ADAPTERS.find((a) => a.id === id);
}
