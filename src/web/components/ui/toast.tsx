import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import type * as React from "react";
import { cn } from "../../lib/utils.ts";
import { Button } from "./button.tsx";

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastOptions {
  tone?: "default" | "error";
  action?: ToastAction;
  /** Milliseconds on screen. Errors stay longer; 0 stays until dismissed. */
  duration?: number;
}

interface ToastItem extends ToastOptions {
  id: number;
  text: string;
}

interface ToastApi {
  toast(text: string, options?: ToastOptions): void;
  error(text: string, options?: Omit<ToastOptions, "tone">): void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error("useToast must be used inside <ToastProvider>");
  return api;
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => setItems((list) => list.filter((t) => t.id !== id)), []);

  const api = useMemo<ToastApi>(() => {
    const push = (text: string, options: ToastOptions = {}) => {
      const id = nextId.current++;
      const duration = options.duration ?? (options.tone === "error" ? 9000 : 4000);
      setItems((list) => [...list, { ...options, id, text }]);
      // An action needs time to be read and reached, so it never auto-hides fast.
      if (duration > 0 && !options.action) setTimeout(() => dismiss(id), duration);
      else if (duration > 0) setTimeout(() => dismiss(id), Math.max(duration, 12000));
    };
    return {
      toast: push,
      error: (text, options) => push(text, { ...options, tone: "error" }),
    };
  }, [dismiss]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      {/*
        One live region for the whole app. Announcements are polite so they never
        interrupt what someone is typing, but errors are assertive because they
        mean the thing they just asked for did not happen (WCAG 4.1.3).
      */}
      <div className="pointer-events-none fixed inset-x-0 bottom-0 z-[100] flex flex-col items-center gap-2 p-4 sm:items-end">
        {items.map((t) => (
          <div
            key={t.id}
            role={t.tone === "error" ? "alert" : "status"}
            aria-live={t.tone === "error" ? "assertive" : "polite"}
            className={cn(
              "pointer-events-auto flex w-full max-w-md items-start gap-3 rounded-lg border p-3 shadow-lg",
              "animate-in slide-in-from-bottom-2 fade-in-0",
              t.tone === "error" ? "border-destructive/40 bg-destructive-bg text-destructive" : "border-border bg-card text-card-foreground",
            )}
          >
            <p className="flex-1 text-sm">{t.text}</p>
            {t.action && (
              <Button
                variant={t.tone === "error" ? "outlineDestructive" : "secondary"}
                size="sm"
                onClick={() => {
                  t.action?.onClick();
                  dismiss(t.id);
                }}
              >
                {t.action.label}
              </Button>
            )}
            <button
              type="button"
              onClick={() => dismiss(t.id)}
              className="tap-target rounded p-0.5 text-current opacity-60 transition-opacity hover:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              <span aria-hidden="true">×</span>
              <span className="sr-only">Dismiss</span>
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
