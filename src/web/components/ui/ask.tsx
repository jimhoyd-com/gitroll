/*
  Replacements for window.confirm() and window.prompt().

  The native ones are not reachable for many assistive technologies, cannot be
  styled or translated, and stop the whole page. These are ordinary dialogs:
  focus moves in, Escape and the close button both cancel, and focus returns to
  whatever opened them.
*/

import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import type * as React from "react";
import { Button } from "./button.tsx";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./dialog.tsx";
import { Field, Input } from "./input.tsx";

interface ConfirmOptions {
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
}

interface PromptOptions {
  title: string;
  description?: string;
  label: string;
  placeholder?: string;
  initialValue?: string;
  confirmLabel?: string;
}

interface AskApi {
  confirm(options: ConfirmOptions): Promise<boolean>;
  prompt(options: PromptOptions): Promise<string | null>;
}

const AskContext = createContext<AskApi | null>(null);

export function useAsk(): AskApi {
  const api = useContext(AskContext);
  if (!api) throw new Error("useAsk must be used inside <AskProvider>");
  return api;
}

type Pending =
  | { kind: "confirm"; options: ConfirmOptions; resolve: (value: boolean) => void }
  | { kind: "prompt"; options: PromptOptions; resolve: (value: string | null) => void };

export function AskProvider({ children }: { children: React.ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [value, setValue] = useState("");
  const settled = useRef(false);

  const close = useCallback(
    (result: boolean | string | null) => {
      if (!pending || settled.current) return;
      settled.current = true;
      if (pending.kind === "confirm") pending.resolve(result === true);
      else pending.resolve(typeof result === "string" ? result : null);
      setPending(null);
    },
    [pending],
  );

  const api = useMemo<AskApi>(
    () => ({
      confirm: (options) =>
        new Promise<boolean>((resolve) => {
          settled.current = false;
          setValue("");
          setPending({ kind: "confirm", options, resolve });
        }),
      prompt: (options) =>
        new Promise<string | null>((resolve) => {
          settled.current = false;
          setValue(options.initialValue ?? "");
          setPending({ kind: "prompt", options, resolve });
        }),
    }),
    [],
  );

  const isPrompt = pending?.kind === "prompt";
  const trimmed = value.trim();

  return (
    <AskContext.Provider value={api}>
      {children}
      <Dialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) close(isPrompt ? null : false);
        }}
      >
        {pending && (
          <DialogContent className="sm:max-w-md">
            <form
              onSubmit={(ev) => {
                ev.preventDefault();
                if (isPrompt && !trimmed) return;
                close(isPrompt ? trimmed : true);
              }}
              className="flex flex-col gap-4"
            >
              <DialogHeader>
                <DialogTitle>{pending.options.title}</DialogTitle>
                {pending.options.description && <DialogDescription>{pending.options.description}</DialogDescription>}
              </DialogHeader>

              {pending.kind === "prompt" && (
                <Field label={pending.options.label} htmlFor="ask-input">
                  <Input
                    id="ask-input"
                    autoFocus
                    value={value}
                    placeholder={pending.options.placeholder}
                    onChange={(ev) => setValue(ev.target.value)}
                  />
                </Field>
              )}

              <DialogFooter>
                <Button variant="secondary" onClick={() => close(isPrompt ? null : false)}>
                  {(!isPrompt && pending.options.cancelLabel) || "Cancel"}
                </Button>
                <Button
                  type="submit"
                  variant={!isPrompt && pending.options.destructive ? "destructive" : "default"}
                  disabled={isPrompt && !trimmed}
                >
                  {pending.options.confirmLabel ?? (isPrompt ? "Save" : "OK")}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        )}
      </Dialog>
    </AskContext.Provider>
  );
}
