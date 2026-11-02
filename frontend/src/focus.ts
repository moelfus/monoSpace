import { RangeSetBuilder } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";

const dimmed = Decoration.line({ class: "cm-dim" });

/**
 * Marks every line outside the paragraph containing the cursor with `cm-dim`.
 * The dimming itself is switched on by the `focus` class on <body>.
 */
export const paragraphFocus = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = this.build(view);
    }

    update(u: ViewUpdate) {
      if (u.docChanged || u.selectionSet || u.viewportChanged) {
        this.decorations = this.build(u.view);
      }
    }

    build(view: EditorView): DecorationSet {
      const { doc, selection } = view.state;
      const head = doc.lineAt(selection.main.head);

      let first = head.number;
      let last = head.number;
      if (head.text.trim() !== "") {
        while (first > 1 && doc.line(first - 1).text.trim() !== "") first--;
        while (last < doc.lines && doc.line(last + 1).text.trim() !== "") last++;
      }

      const builder = new RangeSetBuilder<Decoration>();
      for (const { from, to } of view.visibleRanges) {
        let pos = from;
        while (pos <= to) {
          const line = doc.lineAt(pos);
          if (line.number < first || line.number > last) {
            builder.add(line.from, line.from, dimmed);
          }
          pos = line.to + 1;
        }
      }
      return builder.finish();
    }
  },
  { decorations: (v) => v.decorations },
);
