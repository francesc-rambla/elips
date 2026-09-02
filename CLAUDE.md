# Instructions for Claude Code

## License header on every source file

This project is licensed under the GNU GPL v3 (or later) — see `LICENSE`.
Every source file (`.js`, `.mjs`, `.vue`, `.py`, `index.html`) must start
with this notice, adapted to the file's comment syntax:

```
elips — Editor de LIcitacions PúbliqueS
Copyright (C) 2026  Francesc Rambla i Marigot

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with this program.  If not, see <https://www.gnu.org/licenses/>.
```

- `.js`/`.mjs`: `/* ... */` block comment at the very top of the file.
- `.vue`: `<!-- ... -->` HTML comment before `<script setup>` (all SFCs in
  this repo start with `<script setup>`).
- `.py`: `# ...` line comments at the very top (before any shebang-less
  module docstring — the header goes first, then a blank line, then the
  docstring).
- `index.html`: `<!-- ... -->` placed *after* `<!DOCTYPE html>`, never
  before it (a comment before the doctype can trigger quirks mode).

**Add this header to every new source file you create**, regardless of
whether the user's request mentions it. Keep the copyright line exactly as
`Copyright (C) 2026  Francesc Rambla i Marigot` (update the year only if a
file is meaningfully new work in a later year).

**Exception**: `src/vendor/pandoc/pandoc.js` is third-party vendored code
(MIT License, Tweag I/O + John MacFarlane) — never add this header to it or
any other vendored/third-party file.
