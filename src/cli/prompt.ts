import { createInterface, type Interface } from "node:readline";
import { Writable } from "node:stream";

/**
 * Interactive prompts.
 *
 * Two things make this less trivial than `rl.question()` in a loop:
 *
 * 1. **One interface serves the whole session.** Closing a readline interface
 *    detaches it from stdin, so a fresh one per question hangs on the second
 *    read. These flows ask eight questions in a row.
 * 2. **Lines are queued, not awaited one at a time.** With non-TTY input
 *    (`terminal: false`) readline drains everything available and emits every
 *    `line` event immediately. A promise that captures only the line in flight
 *    would drop the rest, which is exactly how piping answers into
 *    `keychain add` stalls after the first question. So every line is buffered
 *    and handed out in order.
 *
 * Hiding the password works by routing readline's echo through a stream we can
 * mute; the label itself is written straight to stdout so it stays visible.
 */

let rl: Interface | null = null;
let muted = false;
let closed = false;

/** Lines read but not yet consumed. */
const pending: string[] = [];
/** Readers waiting for a line that has not arrived. */
const waiting: Array<(line: string) => void> = [];

function reader(): Interface {
  if (rl) return rl;
  const out = new Writable({
    write(chunk, _encoding, callback) {
      if (!muted) process.stdout.write(chunk as Buffer);
      callback();
    },
  });
  rl = createInterface({
    input: process.stdin,
    output: out,
    terminal: Boolean(process.stdin.isTTY),
  });
  rl.on("line", (line: string) => {
    const next = waiting.shift();
    if (next) next(line);
    else pending.push(line);
  });
  rl.on("close", () => {
    closed = true;
    // Unblock anyone still waiting; an empty answer is what end-of-input means.
    while (waiting.length > 0) waiting.shift()!("");
  });
  return rl;
}

function nextLine(): Promise<string> {
  reader();
  const queued = pending.shift();
  if (queued !== undefined) return Promise.resolve(queued);
  if (closed) return Promise.resolve("");
  return new Promise((resolve) => waiting.push(resolve));
}

function ask(label: string): Promise<string> {
  reader();
  process.stdout.write(label);
  return nextLine();
}

/** Releases stdin so the process can exit. Safe to call when nothing prompted. */
export function closePrompts(): void {
  rl?.close();
  rl = null;
  muted = false;
  closed = false;
  pending.length = 0;
  waiting.length = 0;
}

export async function promptText(question: string, defaultValue?: string): Promise<string> {
  const suffix = defaultValue !== undefined && defaultValue !== "" ? ` (${defaultValue})` : "";
  const answer = (await ask(`  ? ${question}${suffix} `)).trim();
  return answer.length > 0 ? answer : (defaultValue ?? "");
}

export async function promptRequired(question: string): Promise<string> {
  for (;;) {
    const answer = await promptText(question);
    if (answer.length > 0) return answer;
    console.log("    (required)");
  }
}

export async function promptPassword(label: string): Promise<string> {
  reader();
  process.stdout.write(`  ? ${label} `);
  muted = true;
  try {
    return (await nextLine()).replace(/[\r\n]+$/, "");
  } finally {
    muted = false;
    process.stdout.write("\n");
  }
}

export async function promptChoice(question: string, options: string[]): Promise<string> {
  for (;;) {
    const answer = (await promptText(`${question} (${options.join("/")})`)).toLowerCase();
    if (options.includes(answer)) return answer;
    console.log(`    please enter one of: ${options.join(", ")}`);
  }
}

export async function promptPort(defaultPort: number): Promise<number> {
  for (;;) {
    const answer = await promptText("Port", String(defaultPort));
    const n = Number(answer);
    if (Number.isInteger(n) && n > 0) return n;
    console.log("    enter a positive port number");
  }
}

export async function promptYesNo(question: string, defaultValue: boolean): Promise<boolean> {
  const suffix = defaultValue ? " (Y/n)" : " (y/N)";
  const answer = (await ask(`  ? ${question}${suffix} `)).trim();
  if (answer.length === 0) return defaultValue;
  return /^y(es)?$/i.test(answer);
}
