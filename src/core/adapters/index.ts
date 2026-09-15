import type { Adapter } from "../adapter.ts";
import { webhookAdapter } from "./webhook.ts";

/** Built-in adapters. Others implement the same `Adapter` interface. */
export const ADAPTERS: Adapter[] = [webhookAdapter];

export function getAdapter(id: string): Adapter | undefined {
  return ADAPTERS.find((a) => a.id === id);
}
