import "./style.css";
import { Window } from "@wailsio/runtime";
import { EditorState, Extension } from "@codemirror/state";
import { EditorView, drawSelection, keymap, placeholder } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { syntaxHighlighting } from "@codemirror/language";
import { tagHighlighter, tags as t } from "@lezer/highlight";
import { Vim, getCM, vim } from "@replit/codemirror-vim";
import * as Files from "../bindings/monospace/fileservice";
import { paragraphFocus } from "./focus";
import { initHelp, toggleHelp } from "./help";
import {
  Lang,
  applyLang,
  getDefaultLang,
  isMisspelledAt,
  jumpToMisspelling,
  languages,
  openSpellMenu,
  setLang,
  spellcheck,
} from "./spell";
import { chooseFolder, initLibrary, openSwitcher, setActive, setDirtyPaths, toggleSidebar } from "./library";

const mdHighlight = syntaxHighlighting(
  tagHighlighter([
    { tag: [t.heading, t.strong], class: "md-heading" },
    { tag: t.emphasis, class: "md-quote" },
    { tag: [t.processingInstruction, t.contentSeparator, t.list], class: "md-marker" },
    { tag: [t.link, t.url], class: "md-link" },
    { tag: t.quote, class: "md-quote" },
    { tag: t.monospace, class: "md-code" },
  ]),
);

// ---- preferences -------------------------------------------------------------

const prefs = {
  focus: load("focus", true),
  typewriter: load("typewriter", true),
};

function load(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem("monospace." + key);
    return v === null ? fallback : v === "1";
  } catch {
    return fallback;
  }
}

function save(key: keyof typeof prefs) {
  try {
    localStorage.setItem("monospace." + key, prefs[key] ? "1" : "0");
  } catch {
    /* storage unavailable */
  }
}

// ---- DOM -------------------------------------------------------------------

const $mode = document.getElementById("mode")!;
const $file = document.getElementById("file")!;
const $stats = document.getElementById("stats")!;
const $theme = document.getElementById("theme")!;
const $lang = document.getElementById("lang")!;

type Theme = "auto" | "light" | "dark";
const themes: Theme[] = ["auto", "light", "dark"];
let theme = loadTheme();

function loadTheme(): Theme {
  try {
    const v = localStorage.getItem("monospace.theme") as Theme | null;
    return v && themes.includes(v) ? v : "auto";
  } catch {
    return "auto";
  }
}

function setTheme(next: Theme) {
  theme = next;
  if (theme === "auto") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", theme);
  try {
    localStorage.setItem("monospace.theme", theme);
  } catch {
    /* storage unavailable */
  }
  $theme.textContent = theme;
}

function cycleTheme() {
  setTheme(themes[(themes.indexOf(theme) + 1) % themes.length]);
}

function applyPrefs() {
  document.body.classList.toggle("focus", prefs.focus);
  document.body.classList.toggle("typewriter", prefs.typewriter);
}

// ---- buffers -----------------------------------------------------------------

/** An open document. `state` is only up to date while the buffer is not the active one. */
interface Buffer {
  path: string;
  state: EditorState;
  dirty: boolean;
  lang: Lang;
}

// Spell-check language remembered per file path.
function savedLangs(): Record<string, Lang> {
  try {
    return JSON.parse(localStorage.getItem("monospace.langs") ?? "{}");
  } catch {
    return {};
  }
}

function langFor(path: string): Lang {
  return (path && savedLangs()[path]) || getDefaultLang();
}

function rememberLang(path: string, lang: Lang) {
  if (!path) return;
  try {
    localStorage.setItem("monospace.langs", JSON.stringify({ ...savedLangs(), [path]: lang }));
  } catch {
    /* storage unavailable */
  }
}

function syncLang() {
  applyLang(current.lang, view);
  $lang.textContent = current.lang;
}

function chooseLang(next?: Lang) {
  const l = next ?? languages[(languages.indexOf(current.lang) + 1) % languages.length];
  current.lang = l;
  rememberLang(current.path, l);
  setLang(l, view);
  $lang.textContent = l;
}

function baseName(p: string): string {
  return p ? p.split(/[\\/]/).pop()! : "Untitled";
}

function refreshChrome() {
  const name = baseName(current.path);
  const title = `${current.dirty ? "• " : ""}${name} — monoSpace`;
  const others = buffers.length > 1 ? `  [${buffers.indexOf(current) + 1}/${buffers.length}]` : "";
  $file.textContent = name + (current.dirty ? " •" : "") + others;
  document.getElementById("title")!.textContent = title;
  Window.SetTitle(title).catch(() => {});
  setActive(current.path);
  setDirtyPaths(new Set(buffers.filter((b) => b.dirty && b.path).map((b) => b.path)));
}

function refreshStats() {
  const text = view.state.doc.toString();
  const words = text.match(/\S+/g)?.length ?? 0;
  $stats.textContent = `${words} words`;
}

// ---- typewriter scrolling ---------------------------------------------------

function centerCursor() {
  view.dispatch({
    effects: EditorView.scrollIntoView(view.state.selection.main.head, { y: "center" }),
  });
}

const typewriterScroll = EditorView.updateListener.of((u) => {
  if (!prefs.typewriter || !(u.selectionSet || u.docChanged)) return;
  requestAnimationFrame(centerCursor);
});

// ---- editor ----------------------------------------------------------------

const extensions: Extension[] = [
  vim(),
  history(),
  drawSelection(),
  EditorView.lineWrapping,
  markdown(),
  mdHighlight,
  paragraphFocus,
  spellcheck,
  typewriterScroll,
  placeholder("Start writing…   :help for commands · :e open · :w save · Ctrl+P find file"),
  keymap.of([...defaultKeymap, ...historyKeymap]),
  EditorView.updateListener.of((u) => {
    if (u.docChanged) {
      current.dirty = true;
      refreshChrome();
      refreshStats();
      flagTyping();
    }
  }),
];

function newState(content: string): EditorState {
  return EditorState.create({ doc: content, extensions });
}

const buffers: Buffer[] = [{ path: "", state: newState(""), dirty: false, lang: getDefaultLang() }];
let current = buffers[0];

const view = new EditorView({
  state: current.state,
  parent: document.getElementById("editor")!,
});

// Hide the status bar while typing, bring it back when the mouse moves.
let typingTimer: number | undefined;
function flagTyping() {
  document.body.classList.add("typing");
  clearTimeout(typingTimer);
  typingTimer = window.setTimeout(() => document.body.classList.remove("typing"), 1500);
}
window.addEventListener("mousemove", () => document.body.classList.remove("typing"));

// view.setState() recreates the vim plugin, so the mode listener has to be re-attached each time.
function hookVimMode() {
  $mode.textContent = "NORMAL";
  getCM(view)?.on("vim-mode-change", (e: { mode: string; subMode?: string }) => {
    $mode.textContent = e.mode === "visual" && e.subMode === "linewise" ? "VISUAL LINE" : e.mode.toUpperCase();
  });
}

/** Make `b` the active buffer, keeping the text, cursor and undo history of the one we leave. */
function switchTo(b: Buffer) {
  if (b === current) {
    view.focus();
    return;
  }
  current.state = view.state;
  current = b;
  view.setState(b.state);
  hookVimMode();
  syncLang();
  refreshChrome();
  refreshStats();
  view.focus();
  if (prefs.typewriter) requestAnimationFrame(centerCursor);
}

function addBuffer(path: string, content: string): Buffer {
  const b: Buffer = { path, state: newState(content), dirty: false, lang: langFor(path) };
  // Replace a pristine "Untitled" instead of piling up empty buffers.
  const pristine = buffers.length === 1 && !current.path && !current.dirty && view.state.doc.length === 0;
  if (pristine) buffers[0] = b;
  else buffers.push(b);
  return b;
}

// ---- file operations -------------------------------------------------------

async function openFile(target?: string) {
  try {
    const doc = target ? await Files.OpenPath(target) : await Files.Open();
    if (!doc.path) return;
    const existing = buffers.find((b) => b.path === doc.path);
    if (existing) {
      switchTo(existing);
      return;
    }
    const b = addBuffer(doc.path, doc.content);
    // A pristine buffer was replaced: swap without trying to stash it.
    if (!buffers.includes(current)) {
      current = b;
      view.setState(b.state);
      hookVimMode();
      syncLang();
      refreshChrome();
      refreshStats();
      view.focus();
    } else {
      switchTo(b);
    }
  } catch (e) {
    window.alert(`Could not open file: ${e}`);
  }
}

async function saveFile(forceDialog = false): Promise<boolean> {
  const content = view.state.doc.toString();
  try {
    if (current.path && !forceDialog) {
      await Files.Save(current.path, content);
    } else {
      const chosen = await Files.SaveAs(baseName(current.path) === "Untitled" ? "Untitled.md" : baseName(current.path), content);
      if (!chosen) return false;
      current.path = chosen;
      rememberLang(chosen, current.lang);
    }
    current.dirty = false;
    refreshChrome();
    return true;
  } catch (e) {
    window.alert(`Could not save file: ${e}`);
    return false;
  }
}

function newDocument() {
  const b: Buffer = { path: "", state: newState(""), dirty: false, lang: getDefaultLang() };
  buffers.push(b);
  switchTo(b);
}

function closeBuffer() {
  if (current.dirty && !window.confirm(`Discard unsaved changes to ${baseName(current.path)}?`)) return;
  const i = buffers.indexOf(current);
  buffers.splice(i, 1);
  if (buffers.length === 0) buffers.push({ path: "", state: newState(""), dirty: false, lang: getDefaultLang() });
  const next = buffers[Math.min(i, buffers.length - 1)];
  current = next; // the closed buffer is gone, so skip stashing it
  view.setState(next.state);
  hookVimMode();
  syncLang();
  refreshChrome();
  refreshStats();
  view.focus();
}

function cycleBuffer(delta: number) {
  if (buffers.length < 2) return;
  const i = buffers.indexOf(current);
  switchTo(buffers[(i + delta + buffers.length) % buffers.length]);
}

function requestQuit() {
  const dirtyCount = buffers.filter((b) => b.dirty).length;
  const msg = `${dirtyCount} document${dirtyCount > 1 ? "s have" : " has"} unsaved changes. Quit anyway?`;
  if (dirtyCount === 0 || window.confirm(msg)) void Files.Quit();
}

function toggle(key: keyof typeof prefs) {
  prefs[key] = !prefs[key];
  save(key);
  applyPrefs();
  if (key === "typewriter" && prefs.typewriter) centerCursor();
}

// ---- vim -------------------------------------------------------------------

// Move by display line so j/k behave on wrapped prose.
Vim.map("j", "gj", "normal");
Vim.map("k", "gk", "normal");
Vim.map("jj", "<Esc>", "insert");

type ExParams = { args?: string[] };

Vim.defineEx("write", "w", (_cm: unknown, params: ExParams) => {
  const target = params.args?.[0];
  if (target) current.path = target;
  void saveFile();
});
Vim.defineEx("edit", "e", (_cm: unknown, params: ExParams) => {
  void openFile(params.args?.[0]);
});
Vim.defineEx("enew", "ene", () => newDocument());
Vim.defineEx("bnext", "bn", () => cycleBuffer(1));
Vim.defineEx("bprevious", "bp", () => cycleBuffer(-1));
Vim.defineEx("bdelete", "bd", () => closeBuffer());
Vim.defineEx("quit", "q", () => requestQuit());
Vim.defineEx("wq", "wq", async () => {
  if (await saveFile()) requestQuit();
});
Vim.defineEx("focus", "foc", () => toggle("focus"));
Vim.defineEx("typewriter", "type", () => toggle("typewriter"));
Vim.defineEx("sidebar", "sid", () => toggleSidebar());
Vim.defineEx("folder", "fol", () => void chooseFolder());
Vim.defineEx("find", "fin", () => void openSwitcher());
Vim.defineEx("help", "h", () => toggleHelp());
Vim.defineEx("lang", "lan", (_cm: unknown, params: ExParams) => {
  const arg = params.args?.[0] as Lang | undefined;
  chooseLang(arg && languages.includes(arg) ? arg : undefined);
});

// Spell checking, using vim's own keys.
Vim.defineAction("spellSuggest", () => void openSpellMenu(view));
Vim.defineAction("spellNext", () => void jumpToMisspelling(view, 1));
Vim.defineAction("spellPrev", () => void jumpToMisspelling(view, -1));
Vim.mapCommand("z=", "action", "spellSuggest", {}, { context: "normal" });
Vim.mapCommand("]s", "action", "spellNext", {}, { context: "normal" });
Vim.mapCommand("[s", "action", "spellPrev", {}, { context: "normal" });

// Right-click on a misspelled word opens the same menu.
view.dom.addEventListener("contextmenu", (e) => {
  const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
  if (pos !== null && isMisspelledAt(view, pos)) {
    e.preventDefault();
    void openSpellMenu(view, pos);
  }
});
Vim.defineEx("theme", "the", (_cm: unknown, params: ExParams) => {
  const arg = params.args?.[0] as Theme | undefined;
  if (arg && themes.includes(arg)) setTheme(arg);
  else cycleTheme();
});

hookVimMode();

// ---- window controls (frameless) --------------------------------------------

document.getElementById("btn-min")!.addEventListener("click", () => void Window.Minimise());
document.getElementById("btn-max")!.addEventListener("click", () => void Window.ToggleMaximise());
document.getElementById("btn-close")!.addEventListener("click", () => requestQuit());

// ---- global shortcuts ------------------------------------------------------

window.addEventListener(
  "keydown",
  (e) => {
    if (e.key === "F1") {
      e.preventDefault();
      toggleHelp();
      return;
    }
    if (!e.ctrlKey && e.key !== "F11") return;
    if ((e.target as HTMLElement).id === "switcher-input") return;
    const key = e.key.toLowerCase();
    let handled = true;
    if (key === "p" && !e.shiftKey) void openSwitcher();
    else if (key === "pagedown") cycleBuffer(1);
    else if (key === "pageup") cycleBuffer(-1);
    else if (key === "b" && e.shiftKey) toggleSidebar();
    else if (key === "e" && e.shiftKey) void chooseFolder();
    else if (key === "s" && e.shiftKey) void saveFile(true);
    else if (key === "s") void saveFile();
    else if (key === "o" && e.shiftKey) void openFile();
    else if (key === "n" && e.shiftKey) newDocument();
    else if (key === "w" && e.shiftKey) closeBuffer();
    else if (key === "f" && e.shiftKey) toggle("focus");
    else if (key === "t" && e.shiftKey) toggle("typewriter");
    else if (key === "d" && e.shiftKey) cycleTheme();
    else if (e.key === "F11") void Window.ToggleFullscreen();
    else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  },
  true,
);

initHelp({ focusEditor: () => view.focus() });
initLibrary({ openFile: (p) => void openFile(p), focusEditor: () => view.focus() });
setTheme(theme);
applyPrefs();
syncLang();
refreshChrome();
refreshStats();
view.focus();
