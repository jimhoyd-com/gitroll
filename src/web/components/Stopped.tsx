import { COPY } from "../copy.ts";
import { lastRoll } from "../drafts.ts";

/**
 * The command that starts this Roll's browser app again — not plain `gitroll`,
 * which opens the terminal workspace for whichever Roll happens to be the
 * default. The folder is remembered by the page while it was working.
 */
function StartAgain() {
  const roll = lastRoll();
  const command = roll ? `gitroll open -C ${JSON.stringify(roll.location)}` : "gitroll open";
  return (
    <>
      <p className="text-sm text-muted-foreground">
        {roll ? `In your terminal, to open ${roll.name} in this browser again:` : COPY.stoppedHint}
      </p>
      <pre className="overflow-x-auto rounded-md border border-border bg-muted px-3 py-2 font-mono text-sm">{command}</pre>
      <p className="text-xs text-muted-foreground">Then use the link it prints: that link is what signs this browser in.</p>
    </>
  );
}

/** Shown when the app on this computer isn't reachable, or this browser isn't signed in. */
export function Stopped({ kind }: { kind: "stopped" | "signed-out" }) {
  const signedOut = kind === "signed-out";
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-3 px-6">
      <h1 className="text-lg font-semibold">{signedOut ? COPY.signedOutTitle : COPY.stoppedTitle}</h1>
      <p className="text-sm text-muted-foreground">{signedOut ? COPY.signedOutBody : COPY.stoppedBody}</p>
      {!signedOut && <StartAgain />}
    </main>
  );
}
