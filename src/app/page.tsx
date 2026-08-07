"use client";

import { useChat } from "@ai-sdk/react";
import { getToolName, isToolUIPart } from "ai";
import { type FormEvent, useEffect, useRef, useState } from "react";
import type { FreightUIMessage } from "@/lib/agent/ui";

const SUGGESTIONS = [
  "Which carriers have confirmed availability for PA-NJ Box Truck loads this week?",
  "What's the best rate on offer for load #29372450?",
  "Draft a reply to CE0074.",
  "What did the caller with the garbled MC number want?",
];

export default function Home() {
  const { messages, sendMessage, status, error } = useChat<FreightUIMessage>();
  const [input, setInput] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  const busy = status === "submitted" || status === "streaming";

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  function submit(e: FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    void sendMessage({ text });
  }

  function ask(text: string) {
    if (busy) return;
    setInput("");
    void sendMessage({ text });
  }

  return (
    <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col px-4">
      <header className="border-zinc-200 border-b py-5 dark:border-zinc-800">
        <h1 className="font-semibold text-lg tracking-tight">
          Goodlane Freight Desk
        </h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          Loads, carrier inquiries, compliance and market rates. Snapshot date
          2026-05-25.
        </p>
      </header>

      <div className="flex-1 space-y-6 overflow-y-auto py-6">
        {messages.length === 0 && (
          <div className="space-y-2">
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              Try one of these:
            </p>
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => ask(s)}
                className="block w-full rounded-lg border border-zinc-200 px-3 py-2 text-left text-sm transition-colors hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900"
              >
                {s}
              </button>
            ))}
          </div>
        )}

        {messages.map((m) => (
          <Message key={m.id} message={m} />
        ))}

        {busy && (
          <p className="text-sm text-zinc-400 dark:text-zinc-500">
            <span className="inline-block animate-pulse">Working…</span>
          </p>
        )}

        {error && (
          <p className="rounded-lg bg-red-50 px-3 py-2 text-red-700 text-sm dark:bg-red-950 dark:text-red-300">
            {error.message}
          </p>
        )}

        <div ref={endRef} />
      </div>

      <form
        onSubmit={submit}
        className="sticky bottom-0 flex gap-2 border-zinc-200 border-t bg-white py-4 dark:border-zinc-800 dark:bg-black"
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask about a load, a carrier, a lane…"
          className="flex-1 rounded-lg border border-zinc-300 bg-transparent px-3 py-2 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:focus:border-zinc-500"
        />
        <button
          type="submit"
          disabled={busy || input.trim() === ""}
          className="rounded-lg bg-zinc-900 px-4 py-2 font-medium text-sm text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900"
        >
          Send
        </button>
      </form>
    </div>
  );
}

function Message({ message }: { message: FreightUIMessage }) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <p className="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-zinc-900 px-4 py-2 text-sm text-white dark:bg-zinc-100 dark:text-zinc-900">
          {message.parts
            .filter((p) => p.type === "text")
            .map((p) => p.text)
            .join("")}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {message.parts.map((part, i) => (
        // Parts are positional and append-only within a message, so the index
        // is a stable key here.
        // biome-ignore lint/suspicious/noArrayIndexKey: parts are append-only
        <Part key={i} part={part} />
      ))}
    </div>
  );
}

type FreightPart = FreightUIMessage["parts"][number];

function Part({ part }: { part: FreightPart }) {
  if (part.type === "text") return <Prose text={part.text} />;
  if (isToolUIPart(part)) return <ToolChip part={part} />;
  // reasoning / step-start / source parts: nothing useful to show a broker.
  return null;
}

/** The subset of tool-part state we render. */
type ToolPart = Extract<FreightPart, { toolCallId: string }>;

function ToolChip({ part }: { part: ToolPart }) {
  const name = getToolName(part);
  const input = "input" in part ? part.input : undefined;
  const args = input ? compactArgs(input) : "";

  let badge: string;
  let tone: string;
  switch (part.state) {
    case "output-available": {
      badge = `${rowCount(part.output)} rows`;
      tone =
        "border-emerald-300 text-emerald-800 dark:border-emerald-800 dark:text-emerald-300";
      break;
    }
    case "output-error": {
      badge = "error";
      tone =
        "border-red-300 text-red-700 dark:border-red-800 dark:text-red-300";
      break;
    }
    default: {
      badge = "running…";
      tone = "border-zinc-300 text-zinc-500 dark:border-zinc-700";
    }
  }

  return (
    <div
      className={`inline-flex flex-wrap items-center gap-2 rounded-full border px-3 py-1 font-mono text-xs ${tone}`}
    >
      <span className="font-semibold">{name}</span>
      {args && <span className="opacity-70">{args}</span>}
      <span className="opacity-70">· {badge}</span>
    </div>
  );
}

function compactArgs(input: unknown): string {
  if (input == null || typeof input !== "object") return "";
  return Object.entries(input as Record<string, unknown>)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(" ");
}

/** Mirrors src/lib/log.ts `countRows`, for the client-side chip. */
function rowCount(output: unknown): number {
  if (output == null) return 0;
  if (Array.isArray(output)) return output.length;
  if (typeof output !== "object") return 1;
  const o = output as Record<string, unknown>;
  if (o.not_found === true || o.no_data === true) return 0;
  for (const key of ["results", "rows", "inquiries", "weeks"]) {
    if (Array.isArray(o[key])) return (o[key] as unknown[]).length;
  }
  return 1;
}

const CITATION = /(\[[^\]\n]{1,40}\])/g;

/**
 * Deliberately not a markdown library: the model emits short paragraphs and
 * `- ` bullets, plus `[CE0074]`-style citations we want to make visible. That's
 * ~30 lines of rendering versus a dependency.
 */
function Prose({ text }: { text: string }) {
  const blocks = text.split(/\n{2,}/).filter((b) => b.trim() !== "");

  return (
    <div className="space-y-3 text-sm leading-relaxed">
      {blocks.map((block, bi) => {
        const lines = block.split("\n");
        const isList = lines.every((l) => /^\s*[-*]\s+/.test(l));

        if (isList) {
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: streamed text blocks are positional
            <ul key={bi} className="list-disc space-y-1 pl-5">
              {lines.map((l, li) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: streamed text blocks are positional
                <li key={li}>{inline(l.replace(/^\s*[-*]\s+/, ""))}</li>
              ))}
            </ul>
          );
        }
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: streamed text blocks are positional
          <p key={bi} className="whitespace-pre-wrap">
            {inline(block)}
          </p>
        );
      })}
    </div>
  );
}

type Segment = { key: string; kind: "text" | "bold" | "cite"; value: string };

/**
 * Split a line into plain / bold / citation segments with keys derived from the
 * character offset, so keys stay stable while the text streams in.
 */
function segments(text: string): Segment[] {
  const out: Segment[] = [];
  let offset = 0;

  for (const chunk of text.split(CITATION)) {
    if (chunk === "") continue;
    const at = offset;
    offset += chunk.length;

    if (chunk.startsWith("[") && chunk.endsWith("]")) {
      out.push({ key: `c${at}`, kind: "cite", value: chunk });
      continue;
    }

    let inner = at;
    for (const [i, seg] of chunk.split(/\*\*(.+?)\*\*/g).entries()) {
      if (seg !== "") {
        out.push({
          key: `s${inner}`,
          kind: i % 2 === 1 ? "bold" : "text",
          value: seg,
        });
      }
      inner += seg.length;
    }
  }
  return out;
}

/** Bold `**x**` and badge `[CE0074]` citations. */
function inline(text: string) {
  return segments(text).map((seg) => {
    if (seg.kind === "cite") {
      return (
        <span
          key={seg.key}
          className="mx-0.5 rounded bg-zinc-100 px-1 font-mono text-[0.85em] text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
        >
          {seg.value}
        </span>
      );
    }
    if (seg.kind === "bold") {
      return (
        <strong key={seg.key} className="font-semibold">
          {seg.value}
        </strong>
      );
    }
    return <span key={seg.key}>{seg.value}</span>;
  });
}
