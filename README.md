# monoSpace

A distraction-free Markdown writer with vim motions, built with Go, [Wails v3](https://v3.wails.io) and CodeMirror 6. Primarily for Windows; macOS builds are produced by CI.

## Features

- Vim editing (normal/insert/visual mode, text objects, registers, `:` commands) via `@replit/codemirror-vim`
- Focus mode (dims everything but the current paragraph) and typewriter scrolling
- Frameless window, light/dark/auto theme
- Library sidebar (folder tree) and `Ctrl+P` fuzzy file switcher
- Multiple open documents that keep their text, cursor and undo history
- Spell checking for English and German (`:lang en|de|off`, `z=` for suggestions)
- `:help` (or `F1`) lists all commands and shortcuts

## Development

Requires Go, Node.js and the Wails 3 CLI (`go install github.com/wailsapp/wails/v3/cmd/wails3@v3.0.0-alpha2.117`).

```
wails3 dev        # run with hot reload
wails3 build      # production binary in bin/
wails3 package    # installer (Windows, needs NSIS) / .app bundle (macOS)
```

## License

Copyright (C) 2026 moelfus

monoSpace is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. See [LICENSE](LICENSE).

Bundled third-party dictionaries keep their own licenses, see [licenses/](licenses/): English (`dictionary-en`, MIT and BSD) and German (`dictionary-de`, GPL-2.0 or GPL-3.0).
