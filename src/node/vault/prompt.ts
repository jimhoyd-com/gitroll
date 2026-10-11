// Reading secrets: from a hidden prompt on a terminal, or from standard input
// with --stdin. Never from a command-line argument, where other processes and
// shell history can see them. Prompts go to stderr so stdout stays clean for
// what a command prints (a revealed value piped elsewhere).

import crypto from "node:crypto";
import readline from "node:readline/promises";
import { UserError } from "../../core/util.ts";
import { CliError } from "../cli-contract.ts";

const MAX_STDIN = 2 * 1024 * 1024;
let stdinCache: Promise<string> | null = null;

/** All of standard input, read once. */
export function stdinText(): Promise<string> {
  stdinCache ??= new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      data += chunk;
      if (data.length > MAX_STDIN) reject(new UserError("Standard input is too large."));
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
  return stdinCache;
}

/** Line `index` of standard input, without its line ending. */
export async function stdinLine(index: number, what: string): Promise<string> {
  const lines = (await stdinText()).split(/\r?\n/);
  const line = lines[index];
  if (line === undefined || (!line && index === lines.length - 1)) throw new CliError("INVALID_ARGUMENT", `Standard input has no ${what} (line ${index + 1}).`);
  return line;
}

export interface Asker {
  /** Read secrets from stdin rather than a prompt. */
  stdin: boolean;
  nonInteractive: boolean;
}

const needTerminal = (question: string): never => {
  throw new CliError("INTERACTION_REQUIRED", `${question.replace(/:\s*$/, "")} is needed: run this in a terminal, or pass it on standard input with --stdin.`);
};

/** A prompt whose answer isn't shown as it is typed. */
export async function hidden(question: string, ask: Asker, stdinIndex = 0): Promise<string> {
  if (ask.stdin) return stdinLine(stdinIndex, question.replace(/:\s*$/, "").toLowerCase());
  if (ask.nonInteractive || !process.stdin.isTTY) needTerminal(question);
  const input = process.stdin;
  process.stderr.write(question);
  input.setRawMode(true);
  input.resume();
  input.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let value = "";
    const done = (error?: Error) => {
      input.setRawMode(false);
      input.pause();
      input.removeListener("data", onData);
      process.stderr.write("\n");
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") return done();
        if (ch === "\u0003" || ch === "\u0004") return done(new UserError("Cancelled."));
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else if (ch >= " ") value += ch;
      }
    };
    input.on("data", onData);
  });
}

/** A new passphrase, typed twice on a terminal (once on stdin). */
export async function newPassphrase(question: string, ask: Asker, stdinIndex = 0): Promise<string> {
  const first = await hidden(question, ask, stdinIndex);
  if (!ask.stdin && (await hidden("Type it again: ", ask)) !== first) throw new UserError("Those didn't match. Nothing was changed.");
  return first;
}

/** An ordinary visible prompt. */
export async function visible(question: string, ask: Asker): Promise<string> {
  if (ask.nonInteractive || !process.stdin.isTTY) needTerminal(question);
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789-_.!@#%";
/** A random password from the system's CSPRNG: 24 characters (about 143 bits) by default. */
export function generatePassword(length = 24): string {
  let out = "";
  for (let i = 0; i < length; i++) out += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return out;
}
