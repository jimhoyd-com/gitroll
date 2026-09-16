import type { Adapter, EventDraft } from "../adapter.ts";
import { AdapterError } from "../adapter.ts";
import { parseAmount } from "../util.ts";

const isMapping = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

const str = (v: unknown) => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");
const strs = (v: unknown) => (Array.isArray(v) ? v.map(str).filter(Boolean) : str(v) ? str(v).split(",").map((s) => s.trim()) : []);

/**
 * Generic JSON: one event or an array of events.
 *
 *   { "id": "invoice-1042", "title": "Paid Carlos", "text": "Paid Carlos for the tiling", "date": "2026-09-15",
 *     "project": "bathroom-remodel", "tags": ["contractor"], "amount": "$1,850", "url": "https://…" }
 *
 * `id` is required so resending the same payload never duplicates an event.
 */
export const webhookAdapter: Adapter = {
  id: "webhook",
  label: "Webhook / JSON",
  description: "Any system that can send JSON with an id and some text.",
  toEvents(input, ctx) {
    const items = Array.isArray(input) ? input : [input];
    return items.map((item, i): EventDraft => {
      if (!isMapping(item)) throw new AdapterError(`event ${i}: expected a JSON object`);
      const id = str(item.id);
      if (!id) throw new AdapterError(`event ${i}: "id" is required so the event is only logged once`);
      const text = str(item.text) || str(item.title) || str(item.message);
      if (!text) throw new AdapterError(`event ${i}: "text" is required`);
      const amount = typeof item.amount === "number" ? { value: item.amount, currency: "USD" } : parseAmount(str(item.amount));
      const url = str(item.url);
      return {
        title: str(item.title) || undefined,
        text,
        date: str(item.date) || str(item.occurred) || str(item.timestamp) || undefined,
        tags: strs(item.tags),
        amount: amount ?? undefined,
        source: { adapter: ctx.options.source || "webhook", id, ...(url ? { url } : {}) },
      };
    });
  },
};
