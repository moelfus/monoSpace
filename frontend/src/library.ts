import * as Files from "../bindings/monospace/fileservice";

type Entry = { name: string; path: string; rel: string; isDir: boolean };

interface Host {
  openFile(path: string): void;
  focusEditor(): void;
}

const $sidebar = document.getElementById("sidebar")!;
const $switcher = document.getElementById("switcher")!;
const $input = document.getElementById("switcher-input") as HTMLInputElement;
const $list = document.getElementById("switcher-list")!;

let host: Host;
let root = "";
let activePath = "";
let dirtyPaths = new Set<string>();
let switcherFiles: Entry[] = [];
let matches: Entry[] = [];
let selected = 0;

export function initLibrary(h: Host) {
  host = h;
  try {
    root = localStorage.getItem("monospace.folder") ?? "";
    if (localStorage.getItem("monospace.sidebar") === "1") toggleSidebar(true);
  } catch {
    /* storage unavailable */
  }
  void renderRoot();

  $input.addEventListener("input", () => filter());
  $input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeSwitcher();
    else if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) move(1, e);
    else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) move(-1, e);
    else if (e.key === "Enter") {
      e.preventDefault();
      choose(selected);
    }
  });
  $switcher.addEventListener("mousedown", (e) => {
    if (e.target === $switcher) closeSwitcher();
  });
}

export function setActive(path: string) {
  activePath = path;
  $sidebar.querySelectorAll(".row.file").forEach((el) => {
    el.classList.toggle("active", (el as HTMLElement).dataset.path === path);
  });
}

/** Mark files that have unsaved changes in an open buffer. */
export function setDirtyPaths(paths: Set<string>) {
  dirtyPaths = paths;
  $sidebar.querySelectorAll(".row.file").forEach((el) => {
    el.classList.toggle("dirty", paths.has((el as HTMLElement).dataset.path ?? ""));
  });
}

export function toggleSidebar(force?: boolean) {
  const show = force ?? $sidebar.hidden;
  $sidebar.hidden = !show;
  try {
    localStorage.setItem("monospace.sidebar", show ? "1" : "0");
  } catch {
    /* storage unavailable */
  }
}

export async function chooseFolder() {
  const picked = await Files.PickFolder();
  if (!picked) return;
  root = picked;
  try {
    localStorage.setItem("monospace.folder", root);
  } catch {
    /* storage unavailable */
  }
  toggleSidebar(true);
  await renderRoot();
}

// ---- tree --------------------------------------------------------------------

function baseName(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p;
}

async function renderRoot() {
  $sidebar.replaceChildren();

  const header = document.createElement("div");
  header.className = "lib-header";
  header.textContent = root ? baseName(root) : "No folder";
  header.title = root || "Open a folder";
  header.addEventListener("click", () => void chooseFolder());
  $sidebar.append(header);

  if (!root) {
    const hint = document.createElement("div");
    hint.className = "lib-hint";
    hint.textContent = "Click here or press Ctrl+Shift+E to open a folder.";
    $sidebar.append(hint);
    return;
  }

  const tree = document.createElement("ul");
  tree.className = "tree";
  $sidebar.append(tree);
  try {
    await fillDir(tree, root);
  } catch (e) {
    const err = document.createElement("div");
    err.className = "lib-hint";
    err.textContent = `Cannot read folder: ${e}`;
    $sidebar.append(err);
  }
}

async function fillDir(ul: HTMLElement, dir: string) {
  const entries = (await Files.ListDir(dir)) as Entry[];
  for (const entry of entries) {
    const li = document.createElement("li");
    const row = document.createElement("div");
    row.className = "row " + (entry.isDir ? "dir" : "file");
    row.dataset.path = entry.path;
    row.textContent = entry.name;
    row.title = entry.path;
    li.append(row);
    ul.append(li);

    if (entry.isDir) {
      let child: HTMLUListElement | null = null;
      row.addEventListener("click", async () => {
        if (!child) {
          child = document.createElement("ul");
          li.append(child);
          row.classList.add("open");
          try {
            await fillDir(child, entry.path);
          } catch (e) {
            child.textContent = String(e);
          }
        } else {
          child.hidden = !child.hidden;
          row.classList.toggle("open", !child.hidden);
        }
      });
    } else {
      if (entry.path === activePath) row.classList.add("active");
      if (dirtyPaths.has(entry.path)) row.classList.add("dirty");
      row.addEventListener("click", () => host.openFile(entry.path));
    }
  }
}

// ---- quick switcher ------------------------------------------------------------

export async function openSwitcher() {
  if (!root) {
    await chooseFolder();
    if (!root) return;
  }
  try {
    switcherFiles = (await Files.ListFiles(root)) as Entry[];
  } catch {
    switcherFiles = [];
  }
  $switcher.hidden = false;
  $input.value = "";
  filter();
  $input.focus();
}

function closeSwitcher() {
  $switcher.hidden = true;
  host.focusEditor();
}

/** Subsequence match; rewards consecutive characters and matches in the file name. */
function score(query: string, e: Entry): number | null {
  const text = e.rel.toLowerCase();
  const nameStart = text.length - e.name.length;
  let pos = 0;
  let s = 0;
  let prev = -2;
  for (const ch of query) {
    const i = text.indexOf(ch, pos);
    if (i < 0) return null;
    s += i === prev + 1 ? 5 : 1;
    if (i >= nameStart) s += 2;
    prev = i;
    pos = i + 1;
  }
  return s - text.length * 0.01;
}

function filter() {
  const q = $input.value.trim().toLowerCase().replace(/\s+/g, "");
  if (!q) {
    matches = switcherFiles.slice(0, 50);
  } else {
    matches = switcherFiles
      .map((e) => ({ e, s: score(q, e) }))
      .filter((x): x is { e: Entry; s: number } => x.s !== null)
      .sort((a, b) => b.s - a.s)
      .slice(0, 50)
      .map((x) => x.e);
  }
  selected = 0;
  renderMatches();
}

function renderMatches() {
  $list.replaceChildren(
    ...matches.map((e, i) => {
      const li = document.createElement("li");
      li.textContent = e.rel;
      li.className = i === selected ? "selected" : "";
      li.addEventListener("mousedown", (ev) => {
        ev.preventDefault();
        choose(i);
      });
      return li;
    }),
  );
  $list.children[selected]?.scrollIntoView({ block: "nearest" });
}

function move(delta: number, e: KeyboardEvent) {
  e.preventDefault();
  if (!matches.length) return;
  selected = (selected + delta + matches.length) % matches.length;
  renderMatches();
}

function choose(i: number) {
  const entry = matches[i];
  closeSwitcher();
  if (entry) host.openFile(entry.path);
}
