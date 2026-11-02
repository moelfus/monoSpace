import { EditorState, RangeSetBuilder, StateEffect } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";

export type Lang = "en" | "de" | "off";
export const languages: Lang[] = ["en", "de", "off"];

interface Word {
  from: number;
  to: number;
  text: string;
}

// ---- worker client -------------------------------------------------------------

const worker = new Worker(new URL("./spell.worker.ts", import.meta.url), { type: "module" });
const waiting = new Map<number, (data: any) => void>();
let nextId = 1;

worker.onmessage = (e: MessageEvent) => {
  const resolve = waiting.get(e.data.id);
  if (resolve) {
    waiting.delete(e.data.id);
    resolve(e.data);
  }
};

function call<T>(msg: object): Promise<T> {
  const id = nextId++;
  return new Promise((resolve) => {
    waiting.set(id, resolve as (data: any) => void);
    worker.postMessage({ id, ...msg });
  });
}

// ---- state ---------------------------------------------------------------------

let lang: Lang = loadDefault();
/** "lang:word" -> true if misspelled. */
const known = new Map<string, boolean>();
const personal = loadPersonal();

function loadDefault(): Lang {
  try {
    const v = localStorage.getItem("monospace.lang") as Lang | null;
    return v && languages.includes(v) ? v : "en";
  } catch {
    return "en";
  }
}

function loadPersonal(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem("monospace.dictionary") ?? "[]"));
  } catch {
    return new Set();
  }
}

function persistPersonal() {
  try {
    localStorage.setItem("monospace.dictionary", JSON.stringify([...personal]));
  } catch {
    /* storage unavailable */
  }
}

for (const w of personal) void call({ type: "add", word: w });

export function getLang(): Lang {
  return lang;
}

export function getDefaultLang(): Lang {
  return loadDefault();
}

/** Switch the checking language (e.g. when changing buffers) without changing the saved default. */
export function applyLang(next: Lang, view: EditorView) {
  lang = next;
  view.dispatch({ effects: refresh.of(null) });
}

/** The user explicitly chose a language: apply it and remember it as the default. */
export function setLang(next: Lang, view: EditorView) {
  try {
    localStorage.setItem("monospace.lang", next);
  } catch {
    /* storage unavailable */
  }
  applyLang(next, view);
}

// ---- finding words ------------------------------------------------------------------

const wordRe = /[\p{L}\p{M}][\p{L}\p{M}\p{N}'’_]*/gu;
const skipNodes = new Set([
  "InlineCode",
  "FencedCode",
  "CodeBlock",
  "CodeText",
  "URL",
  "HTMLTag",
  "HTMLBlock",
  "Comment",
  "CommentBlock",
]);

function inSkippedNode(state: EditorState, pos: number): boolean {
  for (let n: any = syntaxTree(state).resolveInner(pos, 1); n; n = n.parent) {
    if (skipNodes.has(n.name)) return true;
  }
  return false;
}

// Bare URLs and e-mail addresses aren't Markdown nodes, so skip them by pattern.
const linkRe = /(?:https?:\/\/|www\.)\S+|[\w.+-]+@[\w-]+(?:\.[\w-]+)+/gi;

function* wordsIn(state: EditorState, from: number, to: number): Generator<Word> {
  const text = state.doc.sliceString(from, to);
  const links = [...text.matchAll(linkRe)].map((m) => [m.index!, m.index! + m[0].length] as const);
  for (const m of text.matchAll(wordRe)) {
    const raw = m[0].replace(/['’]+$/, "");
    if (raw.length < 2 || /[\d_]/.test(raw)) continue;
    if (links.some(([a, b]) => m.index! >= a && m.index! < b)) continue;
    const start = from + m.index!;
    if (inSkippedNode(state, start)) continue;
    yield { from: start, to: start + raw.length, text: raw.replace(/’/g, "'") };
  }
}

function keyOf(word: string, l: Lang = lang): string {
  return `${l}:${word}`;
}

// ---- underline plugin -----------------------------------------------------------------

const refresh = StateEffect.define<null>();
const misspelled = Decoration.mark({ class: "cm-misspelled" });

let queue = new Set<string>();
let flushTimer: number | undefined;

function schedule(view: EditorView, words: Iterable<string>) {
  for (const w of words) queue.add(w);
  clearTimeout(flushTimer);
  flushTimer = window.setTimeout(() => void flush(view), 150);
}

async function flush(view: EditorView) {
  const l = lang;
  const words = [...queue].filter((w) => !known.has(keyOf(w, l)));
  queue = new Set();
  if (l === "off" || words.length === 0) return;
  const res = await call<{ bad: string[] }>({ type: "check", lang: l, words });
  const bad = new Set(res.bad);
  for (const w of words) known.set(keyOf(w, l), bad.has(w));
  view.dispatch({ effects: refresh.of(null) });
}

export const spellcheck = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet = Decoration.none;

    constructor(view: EditorView) {
      this.build(view);
    }

    update(u: ViewUpdate) {
      const refreshed = u.transactions.some((tr) => tr.effects.some((e) => e.is(refresh)));
      if (u.docChanged || u.viewportChanged || u.selectionSet || refreshed) this.build(u.view);
    }

    build(view: EditorView) {
      const builder = new RangeSetBuilder<Decoration>();
      if (lang !== "off") {
        const { state } = view;
        const head = state.selection.main.head;
        const unknown = new Set<string>();
        let lastTo = -1;
        for (const range of view.visibleRanges) {
          const from = Math.max(state.doc.lineAt(range.from).from, lastTo);
          const to = state.doc.lineAt(range.to).to;
          if (from >= to) continue;
          for (const w of wordsIn(state, from, to)) {
            const bad = known.get(keyOf(w.text));
            if (bad === undefined) unknown.add(w.text);
            // Don't flag the word being typed.
            else if (bad && !(view.hasFocus && head >= w.from && head <= w.to)) builder.add(w.from, w.to, misspelled);
          }
          lastTo = to + 1;
        }
        if (unknown.size) schedule(view, unknown);
      }
      this.decorations = builder.finish();
    }
  },
  { decorations: (v) => v.decorations },
);

// ---- suggestions menu --------------------------------------------------------------------

function wordAt(state: EditorState, pos: number): Word | null {
  const line = state.doc.lineAt(pos);
  for (const w of wordsIn(state, line.from, line.to)) {
    if (pos >= w.from && pos <= w.to) return w;
  }
  return null;
}

/** True if the word under `pos` is already known to be misspelled (no async lookup). */
export function isMisspelledAt(view: EditorView, pos: number): boolean {
  const w = wordAt(view.state, pos);
  return !!w && known.get(keyOf(w.text)) === true;
}

async function checkWords(words: string[]) {
  const l = lang;
  const todo = [...new Set(words)].filter((w) => !known.has(keyOf(w, l)));
  if (l === "off" || todo.length === 0) return;
  const res = await call<{ bad: string[] }>({ type: "check", lang: l, words: todo });
  const bad = new Set(res.bad);
  for (const w of todo) known.set(keyOf(w, l), bad.has(w));
}

let closeMenu: (() => void) | null = null;

function markGood(word: string, view: EditorView, everywhere: boolean) {
  if (everywhere) for (const l of languages) known.set(keyOf(word, l), false);
  else known.set(keyOf(word), false);
  view.dispatch({ effects: refresh.of(null) });
}

/** Show suggestions for the misspelled word at `pos` (default: the cursor). */
export async function openSpellMenu(view: EditorView, pos = view.state.selection.main.head) {
  closeMenu?.();
  if (lang === "off") return;
  const w = wordAt(view.state, pos);
  if (!w) return;
  await checkWords([w.text]);
  if (known.get(keyOf(w.text)) !== true) return;

  const { suggestions } = await call<{ suggestions: string[] }>({ type: "suggest", lang, word: w.text });

  const items: { label: string; run: () => void }[] = [
    ...suggestions.map((s) => ({
      label: s,
      run: () =>
        view.dispatch({ changes: { from: w.from, to: w.to, insert: s }, selection: { anchor: w.from + s.length } }),
    })),
    {
      label: "Add to dictionary",
      run: () => {
        personal.add(w.text);
        persistPersonal();
        void call({ type: "add", word: w.text });
        markGood(w.text, view, true);
      },
    },
    { label: "Ignore for this session", run: () => markGood(w.text, view, false) },
  ];

  const menu = document.createElement("ul");
  menu.className = "spell-menu";
  let selected = 0;
  const rows = items.map((item, i) => {
    const li = document.createElement("li");
    li.textContent = (i < 9 ? `${i + 1}  ` : "   ") + item.label;
    li.addEventListener("mousedown", (e) => {
      e.preventDefault();
      choose(i);
    });
    menu.append(li);
    return li;
  });
  const paint = () => rows.forEach((li, i) => li.classList.toggle("selected", i === selected));
  paint();

  const coords = view.coordsAtPos(w.from);
  document.body.append(menu);
  const left = Math.min(coords?.left ?? 40, window.innerWidth - menu.offsetWidth - 8);
  const below = (coords?.bottom ?? 40) + 4;
  const top = below + menu.offsetHeight > window.innerHeight ? Math.max(8, (coords?.top ?? 0) - menu.offsetHeight - 4) : below;
  menu.style.left = `${Math.max(8, left)}px`;
  menu.style.top = `${top}px`;

  const onKey = (e: KeyboardEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (e.key === "Escape") close();
    else if (e.key === "ArrowDown" || e.key === "j") selected = (selected + 1) % items.length;
    else if (e.key === "ArrowUp" || e.key === "k") selected = (selected - 1 + items.length) % items.length;
    else if (e.key === "Enter") choose(selected);
    else if (/^[1-9]$/.test(e.key) && Number(e.key) <= items.length) choose(Number(e.key) - 1);
    paint();
  };
  const onOutside = (e: MouseEvent) => {
    if (!menu.contains(e.target as Node)) close();
  };
  function close() {
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("mousedown", onOutside, true);
    menu.remove();
    closeMenu = null;
    view.focus();
  }
  function choose(i: number) {
    close();
    items[i].run();
  }
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("mousedown", onOutside, true);
  closeMenu = close;
}

/** Jump to the next (dir = 1) or previous (dir = -1) misspelled word, wrapping around. */
export async function jumpToMisspelling(view: EditorView, dir: 1 | -1) {
  if (lang === "off") return;
  const { state } = view;
  const all = [...wordsIn(state, 0, state.doc.length)];
  await checkWords(all.map((w) => w.text));
  const bad = all.filter((w) => known.get(keyOf(w.text)));
  if (bad.length === 0) return;
  const head = state.selection.main.head;
  const target =
    dir > 0
      ? (bad.find((w) => w.from > head) ?? bad[0])
      : ([...bad].reverse().find((w) => w.to < head) ?? bad[bad.length - 1]);
  view.dispatch({
    selection: { anchor: target.from },
    effects: EditorView.scrollIntoView(target.from, { y: "center" }),
  });
}
