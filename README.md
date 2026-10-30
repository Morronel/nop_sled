# NOP SLED

A TIS-100-style puzzle game about buffer overflows and shellcoding, for the
mobile browser. Each level is a vulnerable program for the **SK-16**, a
fictional 16-bit CPU. Read the source and disassembly, build an input byte by
byte with the hex keypad and opcode palette, then step through it in the
debugger.

* **ISA spec:** [`docs/ISA.md`](docs/ISA.md) (registers, encoding, memory map,
  calling convention, syscalls, and the fidelity notes on where the game
  abstracts real exploitation).
* **Playable now:** chapters 1–3 (adjacent variable, ret2win, shellcode + NOP
  sled). Chapters 4–8 are designed into the ISA but not built yet.

## Run it

```sh
npm install
npm run dev      # local dev server
npm test         # emulator + level solution tests
npm run build    # static site in dist/
```

Add `?unlock` to the URL to open every level without solving the previous one.

## Deploy

`.github/workflows/deploy.yml` tests, builds and publishes `main` to GitHub
Pages. In the repo settings, set **Pages → Source** to **GitHub Actions** once.

## Layout

```
docs/ISA.md            the CPU spec (kept in sync with src/cpu/isa.ts)
src/cpu/               isa (encode/decode), memory (pages, perms, taint), cpu, asm, disasm
src/game/              level type, levels/, session (loader + run + verify), save, stats
src/i18n/              en.ts, uk.ts (uk is type-checked against en)
src/ui/                DOM views: menu, level screen, payload editor, debugger, results, manual
tests/                 vitest: ISA/CPU behaviour and a reference solution for each level
```

### Adding a level

1. Copy a file in `src/game/levels/`, write the C-like `source`, the `text` and
   `data` assembly, the frame slots for the debugger, and the environments.
2. Register it in `src/game/levels/index.ts`.
3. Add `title`, `brief`, `hint`, `reality`, `fragment` under `levels` in both
   `src/i18n/en.ts` and `src/i18n/uk.ts`.
4. Add a reference solution to `tests/levels.test.ts`.

## Design decisions

* **DOM, not Canvas.** The game is text: listings, hex, tables. DOM gives crisp
  text at any zoom, native scrolling and accessibility, and is easy to edit
  from a phone. CRT effects are a CSS overlay and can be turned off.
* **No framework.** A 30-line `h()` helper; screens re-render from state.
* **Payload as chunks.** Every insert (a byte, a little-endian word, an
  instruction) is a chunk with a repeat count, so a 40-byte NOP sled is one
  tile you can grow or shrink.
* **Score histograms are mocked** with a seeded distribution per level
  (`src/game/stats.ts`) until there is somewhere to collect real ones.

License: MIT.
