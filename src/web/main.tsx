// Entry point for the local GitRoll app.

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./components/App.tsx";
import { Stopped } from "./components/Stopped.tsx";
import { AskProvider } from "./components/ui/ask.tsx";
import { TooltipProvider } from "./components/ui/misc.tsx";
import { ToastProvider } from "./components/ui/toast.tsx";
import { LocalStore } from "./local.ts";

const container = document.getElementById("root");
if (!container) throw new Error("GitRoll couldn't find the page to draw on.");

// A Roll is private. Being framed by another page is never legitimate here.
if (window.top !== window.self) {
  container.textContent = "For your security, GitRoll can't be shown inside another page.";
} else {
  const result = await LocalStore.connect();
  createRoot(container).render(
    <StrictMode>
      <TooltipProvider delayDuration={400}>
        <ToastProvider>
          <AskProvider>{"error" in result ? <Stopped kind={result.error} /> : <App store={result.store} />}</AskProvider>
        </ToastProvider>
      </TooltipProvider>
    </StrictMode>,
  );
}
