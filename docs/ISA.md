# SK-16 Instruction Set Architecture

> *SOKIL MICROSYSTEMS · SK-16 PROGRAMMER'S REFERENCE · REV 0.9 · INTERNAL*
>
> This is the design spec for the fictional CPU used by NOP SLED. The in-game
> "leaked manual" is generated from the same tables (`src/cpu/isa.ts`), so if
> you change one, change both.

## 1. Design goals

* **Learnable on a phone.** 18 mnemonics, 6 registers, one addressing mode for
  memory (`[reg]`).
* **Mechanically faithful to real exploitation.** Little-endian words, a
  downward-growing stack, `CALL` pushing a return address that `RET` blindly
  trusts, a saved frame pointer between locals and the return address,
  variable-length instructions (so unintended gadgets exist), page permissions
  (so NX exists), and Linux-style syscalls.
* **Recognisable.** Opcode bytes deliberately echo x86 (`90` is NOP, `C3` is
  RET, `FF E4` is `JMP SP`, `0F 05` is SYSCALL, `55 89 E5` is the classic
  prologue). Skills transfer; byte values you learn here are the ones you will
  see in real dumps.
* **Room to grow.** Everything chapters 1–8 need is in the base ISA. Later
  chapters change the *loader* (permissions, randomisation, canaries), not the
  CPU.

## 2. Registers

All registers are 16 bits wide.

| # | Name | Role |
|---|------|------|
| 0 | `A`  | Accumulator. Syscall number in, return value out. Function return value. |
| 1 | `B`  | 1st argument (functions and syscalls). |
| 2 | `C`  | 2nd argument. |
| 3 | `D`  | 3rd argument. |
| 4 | `SP` | Stack pointer. Points at the last pushed word. |
| 5 | `BP` | Frame (base) pointer. |
| – | `IP` | Instruction pointer. Not directly addressable; changed by jumps, `CALL`, `RET`. |
| – | `FLAGS` | `Z` (zero) and `C` (carry/borrow). |

The register number appears in encodings (§4). Numbers 6 and 7 are invalid and
raise `SIGILL`.

## 3. Memory

* 16-bit byte-addressed space: `0x0000`–`0xFFFF`.
* **Little-endian.** The word `0x1337` is stored as bytes `37 13`. A return
  address `0x1040` sits on the stack as `40 10`.
* No alignment requirement. Word accesses at odd addresses are legal.
* Memory is split into 256 pages of 256 bytes. Each page is either unmapped or
  mapped with a combination of `R`, `W`, `X`.

### 3.1 Default process layout

| Range | Name | Perms (ch.1–6) | Perms (ch.7+) | Contents |
|-------|------|----------------|---------------|----------|
| `0x0000–0x0FFF` | null guard | unmapped | unmapped | Dereferencing NULL (or anything near it) faults. |
| `0x1000–0x1FFF` | `.text` | `R-X` | `R-X` | Program code. Loaded at `0x1000` unless ASLR (ch.8). |
| `0x2000–0x2FFF` | `.data` | `RW-` | `RW-` | Globals and strings. Always at `.text + 0x1000` (same image). |
| `0x3000–0x30FF` | TLS | `RW-` | `RW-` | Thread-local storage. Stack canary lives at `0x3000` (ch.6+). |
| `0xE000–0xEFFF` | heap / mmap | – | – | Reserved for later chapters (staged payloads, egg hunting). |
| `0xF000–0xFFFF` | stack | `RWX` | `RW-` | Grows down. Top holds environment strings. |

Only pages a level actually uses are mapped. The exact layout per level is
shown in the debugger's memory map.

### 3.2 Faults

| Signal | Cause |
|--------|-------|
| `SIGSEGV` | Read/write of an unmapped page, write to a page without `W`, instruction fetch from a page without `X` (NX). |
| `SIGILL` | Undefined opcode, or a register field of 6 or 7. |
| `SIGABRT` | Raised by library code (e.g. `__stack_chk_fail` in ch.6). Not a CPU fault. |

Every byte of an instruction is fetched with an `X` check, so an instruction
that straddles into a non-executable page faults.

## 4. Encoding

Instructions are **variable length (1–4 bytes)** and unaligned. Jumping into
the middle of an instruction is legal and decodes whatever bytes are there.
This is what makes *unintended gadgets* possible in chapter 7.

Three operand byte formats exist:

* **`+r`**: register number added to the opcode (`PUSH`, `POP`, `MOV r, imm16`).
* **reg-pair byte** `11 sss ddd`: `0xC0 | (src << 3) | dst`. Used by every
  two-register instruction. Example: `MOV BP, SP` → `89 E5`;
  `XOR A, A` → `31 C0`.
* **group byte** `11 ooo ddd`: `0xC0 | (op << 3) | dst`. Used by
  `0x81` (ALU with immediate) and `0xFF` (indirect jump).

Immediates are little-endian: `imm16` is 2 bytes (low first), `rel8` is a
signed byte, `rel16` is a signed little-endian word. Relative targets are
computed from the address of the **next** instruction.

### 4.1 Opcode table

| Mnemonic | Form | Encoding | Size | Cycles | Flags | Operation |
|----------|------|----------|------|--------|-------|-----------|
| `NOP` | | `90` | 1 | 1 | – | Nothing. |
| `MOV` | `r, imm16` | `B8+r lo hi` | 3 | 1 | – | `r ← imm16` |
| `MOV` | `d, s` | `89 /pair` | 2 | 1 | – | `d ← s` |
| `LD` | `d, [s]` | `8B /pair` | 2 | 2 | – | `d ← mem16[s]` |
| `ST` | `[d], s` | `88 /pair` | 2 | 2 | – | `mem16[d] ← s` |
| `ADD` | `d, s` | `01 /pair` | 2 | 1 | Z C | `d ← d + s` |
| `SUB` | `d, s` | `29 /pair` | 2 | 1 | Z C | `d ← d − s` |
| `AND` | `d, s` | `21 /pair` | 2 | 1 | Z, C=0 | `d ← d & s` |
| `XOR` | `d, s` | `31 /pair` | 2 | 1 | Z, C=0 | `d ← d ^ s` |
| `CMP` | `d, s` | `39 /pair` | 2 | 1 | Z C | flags of `d − s` |
| `ADD` | `r, imm16` | `81 /0 lo hi` | 4 | 1 | Z C | `r ← r + imm` |
| `AND` | `r, imm16` | `81 /4 lo hi` | 4 | 1 | Z, C=0 | `r ← r & imm` |
| `SUB` | `r, imm16` | `81 /5 lo hi` | 4 | 1 | Z C | `r ← r − imm` |
| `XOR` | `r, imm16` | `81 /6 lo hi` | 4 | 1 | Z, C=0 | `r ← r ^ imm` |
| `CMP` | `r, imm16` | `81 /7 lo hi` | 4 | 1 | Z C | flags of `r − imm` |
| `JMP` | `rel8` | `EB rel8` | 2 | 1 | – | `IP ← next + rel8` |
| `JZ` | `rel8` | `74 rel8` | 2 | 1 | – | if `Z`: `IP ← next + rel8` |
| `JNZ` | `rel8` | `75 rel8` | 2 | 1 | – | if `!Z`: `IP ← next + rel8` |
| `JMP` | `r` | `FF /4` = `FF E0+r` | 2 | 1 | – | `IP ← r` |
| `CALL` | `rel16` | `E8 lo hi` | 3 | 3 | – | `push next; IP ← next + rel16` |
| `RET` | | `C3` | 1 | 3 | – | `IP ← pop` |
| `LEAVE` | | `C9` | 1 | 3 | – | `SP ← BP; BP ← pop` |
| `PUSH` | `r` | `50+r` | 1 | 2 | – | `SP ← SP − 2; mem16[SP] ← r` |
| `POP` | `r` | `58+r` | 1 | 2 | – | `r ← mem16[SP]; SP ← SP + 2` |
| `SYSCALL` | | `0F 05` | 2 | 10 | – | Kernel call, see §6. |

Notes:

* `Z` is set when the 16-bit result is zero. `C` is the unsigned carry out of
  `ADD`, or the unsigned borrow of `SUB`/`CMP` (`C = 1` iff `d < s`).
* `PUSH SP` pushes the value of `SP` *before* the decrement. `POP SP` loads
  `SP` with the popped value (the increment is discarded). Both match x86.
* `JMP SP` is `FF E4`, `PUSH A` is `50` (`'P'`), `POP A` is `58` (`'X'`). If
  that rings a bell, good.
* Any byte not listed above as an opcode is undefined and raises `SIGILL`.
  That includes `00`, so running into zeroed memory crashes rather than
  sliding.
* No byte of any opcode is `0x00` or `0x0A`, and reg-pair/group bytes are
  always `≥ 0xC0`. Bad characters (ch.4) come from **immediates and
  addresses**, exactly as on real hardware.

### 4.2 Hidden gadgets (ch.7)

Because decoding can start at any byte, a long instruction contains shorter
ones. `MOV A, 0xC358` encodes as `B8 58 C3`; jumping to its second byte runs
`POP A; RET`. Gadget finders in the game scan `.text` byte by byte, exactly
like ROPgadget.

## 5. Stack and calling convention

The stack grows towards lower addresses. `SP` points at the last pushed word.
Buffers are written towards *higher* addresses, so an overflowing buffer runs
into whatever was pushed before it: other locals, then the saved frame pointer,
then the return address.

### 5.1 Convention ("SK-16 ABI")

* Arguments: `B`, `C`, `D` (first three). More are pushed right-to-left.
* Return value: `A`.
* Caller-saved: `A`, `B`, `C`, `D`. Callee-saved: `BP`, `SP`.
* `CALL` pushes the address of the next instruction. `RET` pops into `IP`
  without any check (there is no shadow stack or CFI on the SK-16).

### 5.2 Standard prologue and epilogue

```
vuln:   PUSH BP          ; 55        save caller's frame pointer
        MOV  BP, SP      ; 89 E5     new frame
        SUB  SP, 0x10    ; 81 EC 10 00   reserve locals
        ...
        LEAVE            ; C9        SP ← BP; POP BP
        RET              ; C3        POP IP
```

### 5.3 Frame layout

Higher addresses at the top:

```
          ┌──────────────────┐
 BP + 2 → │ return address   │  ← RET pops this into IP
 BP + 0 → │ saved BP         │  ← LEAVE pops this into BP
 BP - 2 → │ local scalar     │  (ch.6+: stack canary sits here)
          │ ...              │
 BP - n → │ char buf[...]    │  ← input lands here and is written upward
          └──────────────────┘  ← SP
```

The compiler that built the chapter 1–5 binaries places arrays *below*
scalars and uses no stack protector. See fidelity notes (§8).

### 5.4 Stack canary (ch.6)

Functions with arrays get extra code from the "compiler" (sketch; real code
spills argument registers first):

```
prologue:  MOV B, 0x3000 ; LD A, [B] ; MOV B, BP ; SUB B, 2 ; ST [B], A
epilogue:  MOV B, BP ; SUB B, 2 ; LD A, [B] ; MOV B, 0x3000 ; LD C, [B]
           CMP A, C ; JNZ __stack_chk_fail
```

The loader writes a random 16-bit canary to `0x3000` at process start. Like
glibc, **the low byte is always `0x00`**, so string-based over-reads stop at it
and string-based overflows can't write it. `__stack_chk_fail` prints
`*** stack smashing detected ***` and raises `SIGABRT`.

## 6. Syscalls

`SYSCALL` reads the number from `A` and arguments from `B`, `C`, `D`. The
result goes into `A`; errors are returned as negative errno values
(`0xFFF2` = −14 = `-EFAULT`). No other register is modified. Numbers match
Linux x86-64.

| `A` | Name | Args | Behaviour |
|-----|------|------|-----------|
| `0x00` | `read` | `B`=fd, `C`=buf, `D`=len | Copies up to `len` bytes of stdin to `buf`. Does **not** NUL-terminate and does not stop at newlines. Returns bytes read, `0` at EOF, `-EFAULT` if the first byte isn't writable (a partial count if a later one isn't). Only fd 0. |
| `0x01` | `write` | `B`=fd, `C`=buf, `D`=len | Writes `len` bytes to stdout (fd 1) or stderr (fd 2). `-EFAULT` if unreadable. |
| `0x15` | `access` | `B`=path | Returns `-EFAULT` if `path` is unmapped, otherwise `-ENOENT`. Used as a safe memory probe by egg hunters (ch.5). |
| `0x3B` | `execve` | `B`=path, `C`=argv, `D`=envp | `path` must be a readable NUL-terminated string. `argv`/`envp` must each be `0` or a readable NULL-terminated array of pointers to readable strings, otherwise `-EFAULT` (so leftover garbage in `C`/`D` breaks it, as on Linux). If `path` is `"/bin/sh"` the process is replaced by a shell (goal of most chapters). Otherwise `-ENOENT`. |
| `0x3C` | `exit` | `B`=status | Terminates the process. |

Unknown numbers return `-ENOSYS` (`0xFFDA`). `fd` values other than those listed
return `-EBADF` (`0xFFF7`).

### 6.1 Input model

stdin is the player's payload. Chapters 1–5 deliver it all at once. From
chapter 6, a `read` on an empty stdin blocks: the debugger pauses, shows
stdout so far, and lets the player append the next stage (this is how a
leaked canary or address gets used, like a pwntools `recv`/`send` loop).

## 7. Process start

1. The loader maps the pages, copies `.text` and `.data`, writes the canary
   (ch.6+), and copies environment strings to the top of the stack.
2. `SP` is set just below the environment strings, rounded down to even.
   **Different environments therefore shift every stack address**, which is
   why chapter 3 needs a NOP sled.
3. All other registers are `0`, flags are clear, `IP` = `_start`.
4. `_start` calls `main`, then calls `exit(A)`.

A per-level watchdog stops runaway programs (default 5 000 cycles).

## 8. Fidelity notes: where the game abstracts

These are simplifications that **don't** change how the exploit works, plus the
one place where the game's model would be wrong if taken literally.

1. **16-bit address space.** ASLR (ch.8) randomises at page granularity
   (256 bytes), which leaves only a few bits of entropy. That matches 32-bit
   Linux, where brute-forcing ASLR is realistic. On 64-bit systems it isn't.
   The low byte of every address is not randomised, so partial overwrites work
   just like the real low-12-bit trick.
2. **Word-only memory operands, one addressing mode.** Real x86 has
   `[base+index*scale+disp]` and byte loads; their encodings can contain
   `0x00` (e.g. `8B 00`). On the SK-16 bad bytes only come from immediates and
   addresses.
3. **Syscalls clobber nothing but `A`.** x86-64 `syscall` also clobbers
   `RCX` and `R11`.
4. **Local variable order (ch.1).** GCC/Clang with `-fstack-protector`
   move arrays above scalars, so "overflow into the adjacent int" mostly works
   on code built without it, or between fields of a struct. The level says so.
5. **Executable stack (ch.1–6).** Models `-z execstack` / pre-NX hardware.
6. **Why the NOP sled.** In the game the stack moves because environment
   strings differ between runs. In reality argv, auxv, alignment and the
   debugger (gdb sets `LINES`/`COLUMNS`) all shift it too. The sled makes the
   jump target a range instead of an exact address. That is the real reason
   sleds exist; they are not needed when the address is known exactly.
7. **`execve` checks.** The path is compared against `"/bin/sh"` instead of
   looking up a filesystem. `argv`/`envp` are validated like the kernel does
   (walk the pointer array until NULL). Linux accepts `argv = NULL`, which is
   what minimal shellcode passes.
8. **Cycles are fictional.** They exist for the score histograms only.
9. **Self-modifying code.** Writes to an executable page take effect on the
   next fetch (no instruction cache to flush), which is how x86 behaves. On
   ARM or RISC-V, real shellcode decoders need a cache flush.
10. **Canary location.** At a fixed TLS address `0x3000`, standing in for
    `fs:0x28` on x86-64 Linux. The value is random per process and
    has a NUL low byte, both like glibc.

## 9. Chapter coverage

| Ch. | Mechanic | What the ISA/loader provides |
|-----|----------|------------------------------|
| 1 | Overwrite adjacent variable | Downward stack, upward buffer writes, little-endian `CMP r, imm16`. |
| 2 | Overwrite return address | `CALL`/`RET` with unchecked return address; saved `BP` padding. |
| 3 | Shellcode + NOP sled | `RWX` stack, `90` NOP, environment-dependent stack shift, `execve`. |
| 4 | Bad chars | Program uses a `gets`/`strcpy`-style loop; avoid `00`/`0A` with `XOR r, r`, `XOR r, imm16` and `SUB` tricks. |
| 5 | Tiny buffer | Staged payloads and egg hunting with `access` as a fault-free probe, `AND r, 0xFF00` for page stepping, `CMP`/`JNZ` loops. |
| 6 | Stack canary | Loader canary with NUL low byte; staged input to reuse a leak. |
| 7 | NX | Stack `RW-`; `POP r; RET` (`58+r C3`), `SYSCALL` (`0F 05`) and hidden gadgets in `.text`; `LEAVE; RET` for pivots. |
| 8 | ASLR | Loader randomises the image and stack bases per run; PIE code uses relative `CALL`/`JMP` and `CALL $+3; POP r` to find itself. |
