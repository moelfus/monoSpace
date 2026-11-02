interface Host {
  focusEditor(): void;
}

type Row = [keys: string, description: string];

const sections: { title: string; rows: Row[] }[] = [
  {
    title: "Files & buffers",
    rows: [
      [":e [path]", "Open a file (file dialog without a path)"],
      [":w [path]", "Save (optionally under a new path)"],
      [":wq / :q", "Save and quit / quit (asks if anything is unsaved)"],
      [":enew", "New empty document"],
      [":bn / :bp", "Next / previous open document"],
      [":bd", "Close the current document"],
      ["Ctrl+PageDown / PageUp", "Next / previous open document"],
      ["Ctrl+S / Ctrl+Shift+S", "Save / Save as"],
      ["Ctrl+Shift+O / N / W", "Open / new / close document"],
    ],
  },
  {
    title: "Library",
    rows: [
      [":folder  Ctrl+Shift+E", "Choose the library folder"],
      [":sidebar  Ctrl+Shift+B", "Show / hide the folder tree"],
      [":find  Ctrl+P", "Go to file (fuzzy search in the library)"],
    ],
  },
  {
    title: "Writing",
    rows: [
      [":focus  Ctrl+Shift+F", "Dim everything except the current paragraph"],
      [":typewriter  Ctrl+Shift+T", "Keep the cursor line centered"],
      [":theme [auto|light|dark]  Ctrl+Shift+D", "Switch theme"],
      ["F11", "Fullscreen"],
    ],
  },
  {
    title: "Spell checking",
    rows: [
      [":lang [en|de|off]", "Spell-check language of this document (remembered per file)"],
      ["z=  or right-click", "Suggestions for the misspelled word"],
      ["]s  /  [s", "Jump to next / previous misspelled word"],
      ["In the menu", "1-9 or Enter picks; Add to dictionary; Esc closes"],
    ],
  },
  {
    title: "Vim",
    rows: [
      ["jj", "Leave insert mode (same as Esc)"],
      ["j / k", "Move by display line on wrapped text"],
      ["h j k l  w b e  0 $  gg G", "Usual vim motions"],
      ["v  V  d  y  p  u  Ctrl+R", "Visual mode, delete, yank, paste, undo, redo"],
      ["ciw  di\"  yap", "Text objects work as in vim"],
      ["/  n  N  :%s/a/b/g", "Search and substitute"],
    ],
  },
  {
    title: "Help",
    rows: [
      [":help  F1", "Show / hide this page (Esc or q closes it)"],
    ],
  },
];

const scrollKeys = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);
const $help = document.getElementById("help")!;
let host: Host;

export function initHelp(h: Host) {
  host = h;

  const box = document.createElement("div");
  box.id = "help-box";
  const heading = document.createElement("h1");
  heading.textContent = "monoSpace";
  box.append(heading);

  for (const s of sections) {
    const h2 = document.createElement("h2");
    h2.textContent = s.title;
    const dl = document.createElement("dl");
    for (const [keys, desc] of s.rows) {
      const dt = document.createElement("dt");
      dt.textContent = keys;
      const dd = document.createElement("dd");
      dd.textContent = desc;
      dl.append(dt, dd);
    }
    box.append(h2, dl);
  }
  $help.append(box);

  // Capture at window level: after an ex command vim hands focus back to the editor,
  // so the overlay can't rely on having focus itself.
  window.addEventListener(
    "keydown",
    (e) => {
      if ($help.hidden) return;
      if (e.key === "F1") return; // handled by the global shortcut in main.ts
      if (e.key === "Escape" || e.key === "q") {
        e.preventDefault();
        e.stopPropagation();
        closeHelp();
      } else if (!scrollKeys.has(e.key) && !e.ctrlKey && !e.metaKey) {
        e.stopPropagation(); // keep typing out of the editor underneath
        e.preventDefault();
      }
    },
    true,
  );
  $help.addEventListener("mousedown", (e) => {
    if (e.target === $help) closeHelp();
  });
}

function closeHelp() {
  $help.hidden = true;
  host.focusEditor();
}

export function toggleHelp() {
  if (!$help.hidden) {
    closeHelp();
    return;
  }
  $help.hidden = false;
  $help.scrollTop = 0;
  requestAnimationFrame(() => $help.focus()); // after vim has released focus
}
