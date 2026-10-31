# SK-1 Instruction Set Architecture

> *SOKIL MICROSYSTEMS · SK-1 PROGRAMMER'S REFERENCE · REV 1.0 · INTERNAL*
>
> This is the design spec for the fictional CPU used by NOP SLED. The in-game
> "leaked manual" is generated from the same table (`src/cpu/isa.ts`), so if
> you change one, change both.

## 1. Design goals

* **A toy, like TIS-100.** One accumulator, 16 mnemonics, no flags, no
  addressing modes, no register-encoding bytes. Every instruction is 1 byte,
  or 3 bytes when it carries a 16-bit operand. You can read and write it on a
  phone keypad after one level.
* **Mechanically faithful to real exploitation.** Little-endian words, a
  downward-growing stack shared by locals and return addresses, `RET` that
  blindly trusts the stack, relative jumps (so shellcode is
  position-independent), operands that leak `00` bytes, undefined bytes that
  fault, unaligned decoding (so unintended gadgets exist), page permissions (so
  NX exists) and stack-passed syscall arguments.
* **Recognisable bytes.** Opcodes echo x86 where a byte is famous: `90` NOP,
  `C3` RET, `50` PUSH (`'P'`), `58` POP (`'X'`), `B8` MOV imm, `E8` CALL, `E9`
  JMP, `74`/`75` JEZ/JNZ (x86 JE/JNE), `05`/`2D` ADD/SUB imm, `AD`/`AB` LD/ST
  (x86 `lods`/`stos`). The *semantics* are simpler than x86; see §8.
* **Room to grow.** Chapters 1–8 change the *loader* and the level hardware
  (§9), not the CPU.

## 2. Registers

All registers are 16 bits wide.

| Name  | Role |
|-------|------|
| `ACC` | Accumulator. All arithmetic happens here, conditional jumps test it, `PUSH`/`POP` move it. Syscall number in, result out. Function return value. |
| `PTR` | Pointer. `LD` and `ST` access the word at `PTR`. Only reachable through `SWP` (like TIS-100's `BAK`). |
| `SP`  | Stack pointer. Points at the last pushed word. Read with `MOV SP, ACC`, set with `MOV ACC, SP` or `ADJ`. |
| `IP`  | Instruction pointer. Changed only by jumps, `CALL`, `RET`. |

There is no flags register. There is no frame pointer (§5).

## 3. Memory

* 16-bit byte-addressed space: `0x0000`–`0xFFFF`.
* **Little-endian.** The word `0x1337` is stored as bytes `37 13`. A return
  address `0x1008` sits on the stack as `08 10`.
* No alignment requirement for data or code.
* 256 pages of 256 bytes, each unmapped or mapped with a combination of
  `R`, `W`, `X`.

### 3.1 Default process layout

| Range | Name | Perms (ch.1–6) | Perms (ch.7+) | Contents |
|-------|------|----------------|---------------|----------|
| `0x0000–0x0FFF` | null guard | unmapped | unmapped | Dereferencing NULL (or anything near it) faults. |
| `0x1000–0x1FFF` | `.text` | `R-X` | `R-X` | Program code. Loaded at `0x1000` unless ASLR (ch.8). |
| `0x2000–0x2FFF` | `.data` | `RW-` | `RW-` | Globals and strings. Always at `.text + 0x1000`. |
| `0x3000–0x30FF` | TLS | `RW-` | `RW-` | Stack canary at `0x3000` (ch.6+). |
| `0x8000–0x8FFF` | ROM cartridge | – | `R-X` | Library code for ROP (ch.7+, §9). |
| `0xE000–0xEFFF` | heap / mmap | – | – | Reserved for staged payloads and egg hunting (ch.5). |
| `0xF000–0xFFFF` | stack | `RWX` | `RW-` | Grows down. Top holds environment strings. |

Only pages a level uses are mapped. The debugger's Source tab shows the map.

### 3.2 Faults

| Signal | Cause |
|--------|-------|
| `SIGSEGV` | Read/write of an unmapped page, write to a page without `W`, instruction fetch from a page without `X` (NX). |
| `SIGILL` | Any byte that is not an opcode in §4. That includes `00` and ASCII letters, so zeroed memory or `AAAA` padding crashes instead of sliding; only `90` slides. |
| `SIGABRT` | Raised by library code (`__stack_chk_fail`, ch.6). Not a CPU fault. |

Every byte of an instruction is fetched with an `X` check.

## 4. Instructions

Operands are written **source first**, TIS-100 style: `MOV 5, ACC` means
`ACC ← 5`. `v` is a 16-bit immediate, stored little-endian after the opcode.
`rel` is a signed 16-bit offset from the address of the **next**
instruction; the assembler and disassembler show it as an absolute target.

| Instruction | Bytes | Cyc | Operation |
|-------------|-------|-----|-----------|
| `NOP`         | `90`       | 1 | Nothing. |
| `MOV v, ACC`  | `B8 lo hi` | 1 | `ACC ← v` |
| `MOV SP, ACC` | `89`       | 1 | `ACC ← SP` |
| `MOV ACC, SP` | `94`       | 1 | `SP ← ACC` (stack pivot) |
| `SWP`         | `92`       | 1 | `ACC ↔ PTR` |
| `ADD v`       | `05 lo hi` | 1 | `ACC ← ACC + v` (mod 2¹⁶) |
| `SUB v`       | `2D lo hi` | 1 | `ACC ← ACC − v` (mod 2¹⁶) |
| `LD`          | `AD`       | 2 | `ACC ← mem16[PTR]` |
| `ST`          | `AB`       | 2 | `mem16[PTR] ← ACC` |
| `PUSH`        | `50`       | 2 | `SP ← SP − 2; mem16[SP] ← ACC` |
| `POP`         | `58`       | 2 | `ACC ← mem16[SP]; SP ← SP + 2` |
| `ADJ v`       | `81 lo hi` | 1 | `SP ← SP + v` (v is signed: `ADJ -10` = `81 F6 FF`) |
| `JMP rel`     | `E9 lo hi` | 1 | `IP ← next + rel` |
| `JEZ rel`     | `74 lo hi` | 1 | if `ACC = 0`: `IP ← next + rel` |
| `JNZ rel`     | `75 lo hi` | 1 | if `ACC ≠ 0`: `IP ← next + rel` |
| `CALL rel`    | `E8 lo hi` | 2 | `push next; IP ← next + rel` |
| `RET`         | `C3`       | 2 | `IP ← pop` |
| `SYS`         | `CD`       | 5 | Kernel call, §6. |

Notes:

* No opcode is `00` or `0A`. Bad characters (ch.4) come from **operands**:
  small immediates (`MOV 0x3B, ACC` = `B8 3B 00`), addresses, and forward
  jumps (`JNZ +4` = `75 04 00`). Backward jumps (`FF` high byte), `SUB`
  arithmetic and self-modifying decoders are the ways around them, as on real
  hardware.
* Indirect jumps don't exist as an instruction: `PUSH; RET` jumps to `ACC`.
  That idiom is real (`push eax; ret`).
* Cycles are fictional and exist for the score histograms.

### 4.1 Hidden gadgets (ch.7)

Decoding can start at any byte, so operands are also code. `MOV 0xC358, ACC`
encodes as `B8 58 C3`; jumping to its second byte runs `POP; RET`. The game's
gadget scanner walks `.text` byte by byte, like ROPgadget.

## 5. Stack and calling convention

The stack grows towards lower addresses. `SP` points at the last pushed word.
Buffers are written towards *higher* addresses, so an overflowing buffer runs
into whatever is above it: other locals, then the return address.

### 5.1 Convention ("SK-1 ABI", modelled on i386 cdecl)

* Arguments are pushed right to left, so the first argument ends up at `SP`.
  The caller removes them afterwards with `ADJ`.
* Return value in `ACC`. Everything else is caller-saved.
* `CALL` pushes the address of the next instruction. `RET` pops into `IP`
  without any check (no shadow stack, no CFI).
* There is no frame pointer. A function reserves its locals with `ADJ -n`
  and frees them with `ADJ +n` before `RET`. Locals are addressed by copying
  `SP` into `ACC`, adding an offset and `SWP`-ing it into `PTR`.

### 5.2 Frame layout

Higher addresses at the top, as the debugger draws it:

```
          ┌──────────────────┐
          │ caller's frame   │
  RA   →  │ return address   │  ← SP on entry; RET pops this
  RA-2 →  │ uint16_t x       │
  RA-n →  │ char buf[...]    │  ← input lands here and is written upward
          └──────────────────┘  ← SP after ADJ -n
```

Compiled SK-1 code places arrays *below* scalars and uses no stack protector
until chapter 6. See fidelity notes (§8).

### 5.3 Stack canary (ch.6)

The compiler copies the canary from `0x3000` into the slot just below the
return address and checks it before `RET`, calling `__stack_chk_fail` on a
mismatch. The loader writes a random canary per process; like glibc, **its
low byte is always `00`**, so string-based reads stop at it and string-based
overflows can't write it.

## 6. Syscalls

`SYS` takes the number from `ACC` and three arguments from the words at `SP`,
`SP+2` and `SP+4`. The result goes into `ACC`; errors are negative errno
values (`0xFFF2` = −14 = `-EFAULT`). Nothing else changes, including `SP`.
If the argument words themselves are unreadable, the call returns `-EFAULT`.
Numbers match Linux x86-64.

```
; execve("/bin/sh", NULL, NULL)
MOV  0, ACC
PUSH            ; envp
PUSH            ; argv
MOV  bin_sh, ACC
PUSH            ; path   ← SP
MOV  0x3B, ACC
SYS
```

| `ACC` | Name | Args | Behaviour |
|-----|------|------|-----------|
| `0x00` | `read` | fd, buf, len | Copies up to `len` bytes of stdin to `buf`. Does **not** NUL-terminate and does not stop at newlines. Returns bytes read, `0` at EOF, `-EFAULT` if the first byte isn't writable (a partial count if a later one isn't). Only fd 0. |
| `0x01` | `write` | fd, buf, len | Writes `len` bytes to stdout (fd 1) or stderr (fd 2). `-EFAULT` if unreadable. |
| `0x15` | `access` | path | `-EFAULT` if `path` is unmapped, otherwise `-ENOENT`. A fault-free memory probe for egg hunters (ch.5). |
| `0x3B` | `execve` | path, argv, envp | `path` must be a readable NUL-terminated string. `argv`/`envp` must each be `0` or a readable NULL-terminated array of pointers to readable strings, otherwise `-EFAULT`. `"/bin/sh"` spawns a shell (the goal of most chapters); any other path gives `-ENOENT`. |
| `0x3C` | `exit` | status | Terminates the process. |

Unknown numbers return `-ENOSYS` (`0xFFDA`); bad fds return `-EBADF` (`0xFFF7`).

### 6.1 Input model

stdin is the player's payload. Chapters 1–5 deliver it all at once. From
chapter 6 a second input tape exists (§9).

## 7. Process start

1. The loader maps the pages, copies `.text` and `.data`, writes the canary
   (ch.6+), and copies environment strings to the top of the stack.
2. `SP` is set just below the environment strings, rounded down to even.
   **Different environments therefore shift every stack address**, which is
   why chapter 3 needs a NOP sled.
3. `ACC` and `PTR` are `0`, `IP` = `_start`.
4. `_start` calls `main`, then calls `exit(ACC)`.

A per-level watchdog stops runaway programs (default 5 000 cycles).

## 8. Fidelity notes: where the game abstracts

Simplifications that **don't** change how the exploit works, and the places
where taking the toy literally would teach something wrong.

1. **No frame pointer.** Like code built with `-fomit-frame-pointer`, the
   return address sits right above the locals. On x86 builds that keep a
   frame pointer, a saved `EBP`/`RBP` (4 or 8 bytes) sits in between, so real
   offsets are longer. Chapter 2 says so.
2. **Toy semantics behind real bytes.** Read as 16-bit x86, `90 B8 05 2D
   50 58 92 E8 E9 C3` do the same thing on the SK-1 (`PTR` plays `DX`). The
   rest only borrow the byte: `74`/`75` take a 16-bit offset here (8-bit on
   x86), `AD`/`AB` don't auto-increment like `lodsw`/`stosw`, `94` copies
   instead of exchanging, and `89`, `81`, `CD` need extra bytes on x86.
3. **One accumulator.** Real shellcode juggles many registers. The SK-1
   pushes the same lessons (zero without `00`, build addresses from
   arithmetic, position independence) through one register.
4. **Syscall convention.** Stack arguments match i386 cdecl and BSD
   `int 0x80` (which also expects a dummy return-address slot, omitted here).
   Linux passes syscall arguments in registers. Numbers are Linux x86-64.
   `SYS` clobbers only `ACC`; x86-64 `syscall` also clobbers `RCX` and `R11`.
5. **Word-only memory.** No byte loads or stores, one addressing mode.
6. **16-bit address space.** ASLR (ch.8) randomises at page granularity
   (256 bytes), leaving only a few bits of entropy. That matches 32-bit Linux,
   where brute-forcing ASLR is realistic; on 64-bit it isn't. The low byte of
   addresses is not randomised, so partial overwrites work like the real
   low-12-bit trick.
7. **Local variable order (ch.1).** GCC/Clang with `-fstack-protector` move
   arrays above scalars, so "overflow into the adjacent int" mostly works on
   code built without it, or between fields of a struct. The level says so.
8. **Executable stack (ch.1–6).** Models `-z execstack` or pre-NX hardware.
9. **Why the NOP sled.** In the game the stack moves because environment
   strings differ between runs. In reality argv, auxv, alignment and the
   debugger (gdb sets `LINES`/`COLUMNS`) shift it too. The sled turns the jump
   target into a range. That is why sleds exist; with an exact address they
   are unnecessary.
10. **Shellcode overwriting itself.** After `RET` the stack pointer sits just
    above the buffer, so shellcode `PUSH`es land on its own tail. This is a
    real failure mode; real payloads move `ESP` away first or leave slack.
11. **`execve` checks.** The path is compared with `"/bin/sh"` instead of
    looking up a filesystem. `argv`/`envp` are validated by walking the
    pointer arrays, as the kernel does. Linux accepts `argv = NULL`, which is
    what minimal shellcode passes.
12. **Self-modifying code.** Writes to an executable page take effect on the
    next fetch (no instruction cache to flush), as on x86. ARM and RISC-V
    decoders need a cache flush.
13. **Canary location.** A fixed TLS address `0x3000` stands in for
    `fs:0x28` on x86-64 Linux. Random per process with a NUL low byte, like
    glibc.

## 9. Level hardware: one "node" per chapter

TIS-100 gives each puzzle a grid of nodes. NOP SLED gives each chapter one
new piece of visible hardware around the vulnerable program. Each one
abstracts a real mechanism and must not add rules that real targets lack.

| Ch. | Node | What it is | Real mechanism |
|-----|------|------------|----------------|
| 1–2 | **Frame lens** | Debugger overlay that labels locals and the return address. | A debugger with symbols. |
| 3 | **Test rigs** | The payload runs on several rigs at once; each rig's environment shifts the stack. All must pop a shell. *(Built.)* | Stack position varies with environment, argv and auxv. |
| 4 | **Filter node** | Input passes through a visible filter before reaching the program: `strcpy` (stops at `00`), `gets` (stops at `0A`), later `toupper` or alnum-only. Bytes that get cut or changed light up. | Input-handling functions that terminate or transform the input. |
| 5 | **Relay pipeline** | Two processes wired stdout → stdin. The first has a tiny overflow; its stage-1 code reads more input (or hunts an "egg" already in memory with `access`) and runs the real payload. | Staged payloads and egg hunters. |
| 6 | **Sentinel + second tape** | Canary slot drawn as a sentinel that trips on change. A second input tape opens after the program's first output, so a leaked canary can be fed back. | Stack protector; interactive `recv`/`send` exploitation. |
| 7 | **ROM cartridge** | A library mapped `R-X` at `0x8000` plus a byte-level gadget scanner. Stack becomes `RW-`. | NX, ret2libc, ROP (incl. unintended gadgets). |
| 8 | **Drift** | Rigs with randomised image and stack bases per run. A leak shows one address; the player computes the rest. | ASLR/PIE and info leaks. |

## 10. Chapter coverage

| Ch. | Mechanic | What the ISA/loader provides |
|-----|----------|------------------------------|
| 1 | Overwrite adjacent variable | Downward stack, upward buffer writes, little-endian compare via `SUB`/`JNZ`. |
| 2 | Overwrite return address | `CALL`/`RET` with an unchecked return address right above the locals. |
| 3 | Shellcode + NOP sled | `RWX` stack, `90` NOP, environment-dependent stack shift, `execve`, push-clobber pitfall. |
| 4 | Bad chars | `00`/`0A` in operands: `MOV 0x4141, ACC; SUB 0x4106` for `0x3B`, backward jumps, `SUB`-encoded or self-decoding payloads. |
| 5 | Tiny buffer | Staged payloads; egg hunting with `access` as a fault-free probe and `JEZ`/`JNZ` loops. |
| 6 | Stack canary | Loader canary with NUL low byte; second input tape to reuse a leak. |
| 7 | NX | Stack `RW-`; `POP; RET` (`58 C3`), `ADJ n; RET` and `SYS` gadgets plus hidden ones; `MOV ACC, SP` for pivots; ret2libc with stack arguments. |
| 8 | ASLR | Randomised bases per run; relative `CALL`/`JMP` keep PIE code working; `CALL next; POP` finds the current address. |
