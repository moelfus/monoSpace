import nspell from "nspell";

// The DOM lib is in use project-wide, so type the worker scope by hand instead of pulling in "webworker".
const ctx = self as unknown as {
  onmessage: ((e: MessageEvent) => void) | null;
  postMessage(message: unknown): void;
};

type Lang = "en" | "de";

type Request =
  | { id: number; type: "check"; lang: Lang; words: string[] }
  | { id: number; type: "suggest"; lang: Lang; word: string }
  | { id: number; type: "add"; word: string };

const checkers = new Map<Lang, Promise<ReturnType<typeof nspell>>>();
const personal = new Set<string>();

// The dictionary packages only export a Node-specific index.js, so the Hunspell files are
// imported by relative path (bypassing "exports") and bundled as lazy chunks.
async function loadRaw(lang: Lang): Promise<[string, string]> {
  if (lang === "de") {
    const [aff, dic] = await Promise.all([
      import("../node_modules/dictionary-de/index.aff?raw"),
      import("../node_modules/dictionary-de/index.dic?raw"),
    ]);
    return [aff.default, dic.default];
  }
  const [aff, dic] = await Promise.all([
    import("../node_modules/dictionary-en/index.aff?raw"),
    import("../node_modules/dictionary-en/index.dic?raw"),
  ]);
  return [aff.default, dic.default];
}

function checker(lang: Lang) {
  let c = checkers.get(lang);
  if (!c) {
    c = loadRaw(lang).then(([aff, dic]) => {
      const sp = nspell(aff, dic);
      for (const w of personal) sp.add(w);
      return sp;
    });
    checkers.set(lang, c);
  }
  return c;
}

ctx.onmessage = async (e: MessageEvent<Request>) => {
  const msg = e.data;
  try {
    if (msg.type === "check") {
      const sp = await checker(msg.lang);
      const bad = msg.words.filter((w) => !sp.correct(w) && !sp.correct(w.toLowerCase()));
      ctx.postMessage({ id: msg.id, bad });
    } else if (msg.type === "suggest") {
      const sp = await checker(msg.lang);
      ctx.postMessage({ id: msg.id, suggestions: sp.suggest(msg.word).slice(0, 8) });
    } else {
      personal.add(msg.word);
      for (const c of checkers.values()) void c.then((sp) => sp.add(msg.word));
      ctx.postMessage({ id: msg.id });
    }
  } catch (err) {
    // A failed dictionary load must not leave the caller hanging: report nothing misspelled.
    console.error("spell worker:", err);
    ctx.postMessage({ id: msg.id, bad: [], suggestions: [], error: String(err) });
  }
};
