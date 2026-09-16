import { Check, Loader2, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { AiCheck, AiConfig, AiProvider, AiSettingsPayload, Store } from "../store.ts";
import { message } from "../lib/format.ts";
import { cn } from "../lib/utils.ts";
import { Button } from "./ui/button.tsx";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog.tsx";
import { Field, Input } from "./ui/input.tsx";

/*
  Setting Ask up is the part people give up on, so this screen answers the three
  questions they actually have, in this order:

    1. Where does the model run — and therefore, what leaves this computer?
    2. Does it work?  (Test it here, before saving anything.)
    3. How do I turn it off?

  A model on this computer is the first thing offered and the safe answer. A
  hosted provider is allowed, but never without saying plainly what is sent.
  API keys are read from environment variables: this screen asks for the name of
  the variable, never the key, so nothing secret reaches the Roll or the
  settings file.
*/

export interface AiSettingsDialogProps {
  store: Store;
  open: boolean;
  onOpenChange(open: boolean): void;
  onSaved(): void;
}

export function AiSettingsDialog({ store, open, onOpenChange, onSaved }: AiSettingsDialogProps) {
  const [payload, setPayload] = useState<AiSettingsPayload | null>(null);
  const [draft, setDraft] = useState<AiConfig & { allowRemote?: boolean }>({ endpoint: "", model: "" });
  const [check, setCheck] = useState<AiCheck | null>(null);
  const [busy, setBusy] = useState<"" | "testing" | "saving">("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setError("");
    setCheck(null);
    store
      .aiSettings()
      .then((p) => {
        setPayload(p);
        const local = p.providers.find((x) => x.local);
        setDraft(p.settings ? { ...p.settings } : { provider: local?.id, endpoint: local?.endpoint ?? "", model: local?.model ?? "" });
      })
      .catch((e) => setError(message(e)));
  }, [open, store]);

  if (!payload) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Ask your Roll</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">{error || "Loading…"}</p>
        </DialogContent>
      </Dialog>
    );
  }

  const isLocal = looksLocal(draft.endpoint);
  const configured = !!payload.settings;

  // Choosing a hosted provider from the list is itself the deliberate choice;
  // typing a non-local address is not, so that asks separately.
  const pick = (p: AiProvider) =>
    setDraft({ provider: p.id, endpoint: p.endpoint, model: p.model, apiKeyEnv: p.apiKeyEnv, allowRemote: !p.local, enabled: true });
  const needsConsent = !isLocal && !draft.allowRemote;

  const run = async (what: "testing" | "saving") => {
    setBusy(what);
    setError("");
    try {
      if (what === "testing") setCheck(await store.testAi({ ...draft }));
      else {
        const saved = await store.saveAiSettings({ ...draft, enabled: true });
        setPayload(saved);
        onSaved();
        onOpenChange(false);
      }
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy("");
    }
  };

  const setOnOff = async (on: boolean) => {
    setBusy("saving");
    try {
      setPayload(await store.saveAiSettings({ ...(payload.settings ?? draft), enabled: on }));
      onSaved();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy("");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Ask your Roll</DialogTitle>
          <DialogDescription>
            Answers questions from your own events, using a model you choose. Every answer links to the events it came from.
          </DialogDescription>
        </DialogHeader>

        <div className="flex max-h-[70vh] flex-col gap-4 overflow-y-auto">
          {!payload.state.allowedHere && (
            <p className="rounded-md border border-border bg-muted p-3 text-sm">
              This Roll has Ask turned off for everyone (<code className="font-mono text-xs">ai: false</code> in{" "}
              <code className="font-mono text-xs">.gitroll/config.yaml</code>). You can set a model up here, but Ask stays
              unavailable in this Roll until that line is removed.
            </p>
          )}

          <fieldset className="flex flex-col gap-2">
            <legend className="text-sm font-medium">Where the model runs</legend>
            <p className="text-xs text-muted-foreground">
              On this computer, nothing you log ever leaves it. That is the recommended choice.
            </p>
            <ul className="grid gap-1.5 sm:grid-cols-2">
              {payload.providers.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => pick(p)}
                    aria-pressed={draft.provider === p.id}
                    className={cn(
                      "w-full rounded-md border p-2 text-left text-sm transition-colors",
                      "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                      draft.provider === p.id ? "border-ring bg-accent" : "border-border hover:bg-accent",
                    )}
                  >
                    <span className="flex items-center justify-between gap-2 font-medium">
                      {p.label}
                      <span className={cn("rounded-full px-1.5 py-0.5 text-[10px]", p.local ? "bg-muted text-muted-foreground" : "bg-del-bg text-del")}>
                        {p.local ? "on this computer" : "over the internet"}
                      </span>
                    </span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">{p.hint}</span>
                  </button>
                </li>
              ))}
            </ul>
          </fieldset>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Address" htmlFor="ai-endpoint" hint="An OpenAI-compatible API. It usually ends in /v1.">
              <Input id="ai-endpoint" value={draft.endpoint} onChange={(ev) => setDraft({ ...draft, endpoint: ev.target.value, provider: undefined })} />
            </Field>
            <Field label="Model" htmlFor="ai-model" hint={check?.models?.length ? `Available: ${check.models.slice(0, 4).join(", ")}` : "The model's name, exactly as the server knows it."}>
              <Input id="ai-model" value={draft.model} onChange={(ev) => setDraft({ ...draft, model: ev.target.value })} />
            </Field>
          </div>

          <Field
            label="API key environment variable"
            htmlFor="ai-key"
            hint="GitRoll reads the key from this variable when it asks a question. The key itself is never stored, and never goes in a Roll."
          >
            <Input
              id="ai-key"
              placeholder="OPENAI_API_KEY"
              value={draft.apiKeyEnv ?? ""}
              onChange={(ev) => setDraft({ ...draft, apiKeyEnv: ev.target.value || undefined })}
            />
          </Field>

          <div className={cn("flex flex-col gap-2 rounded-md p-3 text-sm", isLocal ? "bg-muted text-muted-foreground" : "bg-del-bg text-del")}>
            <p>
              {isLocal
                ? "Your question and the matching events stay on this computer."
                : `Your question and the full text of the matching events are sent to ${host(draft.endpoint)} over the internet. Attachments themselves are never sent.`}
            </p>
            {!isLocal && (
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  className="mt-0.5 size-4 rounded border-input"
                  checked={draft.allowRemote === true}
                  onChange={(ev) => setDraft({ ...draft, allowRemote: ev.target.checked })}
                />
                <span>Send my question and the matching events to {host(draft.endpoint)}.</span>
              </label>
            )}
          </div>

          {check && (
            <p className={cn("flex items-start gap-2 text-sm", check.ok ? "text-add" : "text-destructive")}>
              {check.ok ? <Check className="mt-0.5 size-4 shrink-0" aria-hidden="true" /> : <X className="mt-0.5 size-4 shrink-0" aria-hidden="true" />}
              <span role="status">{check.message}</span>
            </p>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border pt-3">
          {configured && (
            <Button variant="ghost" className="mr-auto" disabled={!!busy} onClick={() => void setOnOff(!payload.state.on)}>
              {payload.state.on ? "Turn Ask off" : "Turn Ask on"}
            </Button>
          )}
          <Button variant="secondary" disabled={!!busy || !draft.endpoint || !draft.model || needsConsent} onClick={() => void run("testing")}>
            {busy === "testing" ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
            Test it
          </Button>
          <Button disabled={!!busy || !draft.endpoint || !draft.model || needsConsent} onClick={() => void run("saving")}>
            {busy === "saving" ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
            Save
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

const host = (endpoint: string): string => {
  try {
    return new URL(endpoint).host;
  } catch {
    return endpoint || "that address";
  }
};

const looksLocal = (endpoint: string): boolean => ["localhost", "127.0.0.1", "::1", "[::1]"].includes(host(endpoint).replace(/:\d+$/, ""));
