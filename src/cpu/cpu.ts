// SK-1 emulator: executes one instruction per step() and implements syscalls.

import { ACC, PTR, SP, cyclesOf, decode, type Insn } from './isa';
import { Fault, Memory, R, W, type FaultKind, type Signal } from './memory';

export type Status = 'running' | 'exited' | 'shell' | 'faulted' | 'timeout';

export const SYS = { READ: 0x00, WRITE: 0x01, ACCESS: 0x15, EXECVE: 0x3b, EXIT: 0x3c } as const;
export const ERR = {
  ENOENT: 0x10000 - 2,
  EBADF: 0x10000 - 9,
  EFAULT: 0x10000 - 14,
  ENOSYS: 0x10000 - 38,
} as const;

export interface FaultInfo {
  signal: Signal;
  kind: FaultKind;
  addr: number;
  ip: number;
}

export interface SyscallRecord {
  nr: number;
  args: [number, number, number];
  ret: number;
  path?: string;
}

export class CPU {
  /** ACC, PTR, SP (see REG_NAMES). */
  readonly regs = new Uint16Array(3);
  ip = 0;
  cycles = 0;
  steps = 0;
  status: Status = 'running';
  fault?: FaultInfo;
  exitCode?: number;
  stdin: number[] = [];
  stdinPos = 0;
  stdout: number[] = [];
  syscalls: SyscallRecord[] = [];
  /** Instruction executed by the last step (undefined after a fetch fault). */
  lastInsn?: Insn;

  constructor(
    public mem: Memory,
    public maxCycles = 5000,
  ) {}

  get acc(): number {
    return this.regs[ACC];
  }

  get sp(): number {
    return this.regs[SP];
  }

  step(): void {
    if (this.status !== 'running') return;
    if (this.cycles >= this.maxCycles) {
      this.status = 'timeout';
      return;
    }
    const ip = this.ip;
    this.mem.lastWrites = [];
    this.lastInsn = undefined;
    try {
      const dec = decode((a) => this.mem.fetch8(a), ip);
      if (!dec.ok) throw new Fault('SIGILL', 'illegal', ip);
      this.lastInsn = dec.insn;
      this.ip = (ip + dec.len) & 0xffff;
      this.exec(dec.insn);
      this.cycles += cyclesOf(dec.insn);
      this.steps++;
    } catch (e) {
      if (!(e instanceof Fault)) throw e;
      this.ip = ip;
      this.status = 'faulted';
      this.fault = { signal: e.signal, kind: e.kind, addr: e.addr, ip };
    }
  }

  run(limitSteps = 100000): void {
    for (let i = 0; i < limitSteps && this.status === 'running'; i++) this.step();
  }

  push(v: number): void {
    const sp = (this.regs[SP] - 2) & 0xffff;
    this.mem.write16(sp, v);
    this.regs[SP] = sp;
  }

  pop(): number {
    const v = this.mem.read16(this.regs[SP]);
    this.regs[SP] = (this.regs[SP] + 2) & 0xffff;
    return v;
  }

  private exec(insn: Insn): void {
    const g = this.regs;
    const imm = insn.imm ?? 0;
    const jump = () => (this.ip = (this.ip + imm) & 0xffff);
    switch (insn.id) {
      case 'nop':
        return;
      case 'mov_i':
        g[ACC] = imm;
        return;
      case 'mov_sp':
        g[ACC] = g[SP];
        return;
      case 'mov_acc':
        g[SP] = g[ACC];
        return;
      case 'swp': {
        const t = g[ACC];
        g[ACC] = g[PTR];
        g[PTR] = t;
        return;
      }
      case 'add':
        g[ACC] = g[ACC] + imm; // Uint16Array wraps
        return;
      case 'sub':
        g[ACC] = g[ACC] - imm;
        return;
      case 'ld':
        g[ACC] = this.mem.read16(g[PTR]);
        return;
      case 'st':
        this.mem.write16(g[PTR], g[ACC]);
        return;
      case 'push':
        this.push(g[ACC]);
        return;
      case 'pop':
        g[ACC] = this.pop();
        return;
      case 'adj':
        g[SP] = g[SP] + imm;
        return;
      case 'jmp':
        jump();
        return;
      case 'jez':
        if (g[ACC] === 0) jump();
        return;
      case 'jnz':
        if (g[ACC] !== 0) jump();
        return;
      case 'call':
        this.push(this.ip);
        jump();
        return;
      case 'ret':
        this.ip = this.pop();
        return;
      case 'sys':
        this.syscall();
        return;
    }
  }

  private readCString(addr: number, max = 256): string | undefined {
    let out = '';
    for (let i = 0; i < max; i++) {
      const a = (addr + i) & 0xffff;
      if (!this.mem.can(a, R)) return undefined;
      const b = this.mem.bytes[a];
      if (b === 0) return out;
      out += String.fromCharCode(b);
    }
    return undefined;
  }

  /** Word read that reports unreadable memory instead of faulting (kernel-side copy). */
  private peek16(addr: number): number | undefined {
    if (!this.mem.can(addr, R) || !this.mem.can(addr + 1, R)) return undefined;
    return this.mem.bytes[addr & 0xffff] | (this.mem.bytes[(addr + 1) & 0xffff] << 8);
  }

  /** argv/envp check for execve: NULL, or a NULL-terminated array of string pointers. */
  private validStringArray(addr: number): boolean {
    if (addr === 0) return true;
    for (let i = 0; i < 32; i++) {
      const ptr = this.peek16(addr + i * 2);
      if (ptr === undefined) return false;
      if (ptr === 0) return true;
      if (this.readCString(ptr) === undefined) return false;
    }
    return false;
  }

  private syscall(): void {
    const g = this.regs;
    const nr = g[ACC];
    // Arguments are the three words at SP, SP+2, SP+4 (pushed right to left).
    const raw = [0, 2, 4].map((o) => this.peek16(g[SP] + o));
    const args = raw.map((v) => v ?? 0) as [number, number, number];
    const [b, c, d] = args;
    const rec: SyscallRecord = { nr, args, ret: 0 };
    let ret: number;
    if (raw.some((v) => v === undefined)) {
      ret = ERR.EFAULT;
    } else {
      switch (nr) {
        case SYS.READ: {
          if (b !== 0) {
            ret = ERR.EBADF;
            break;
          }
          let n = 0;
          while (n < d && this.stdinPos < this.stdin.length) {
            const a = (c + n) & 0xffff;
            if (!this.mem.can(a, W)) break;
            this.mem.write8(a, this.stdin[this.stdinPos++], true);
            n++;
          }
          ret = n === 0 && d > 0 && this.stdinPos < this.stdin.length ? ERR.EFAULT : n;
          break;
        }
        case SYS.WRITE: {
          if (b !== 1 && b !== 2) {
            ret = ERR.EBADF;
            break;
          }
          const out: number[] = [];
          let okRead = true;
          for (let i = 0; i < d; i++) {
            const a = (c + i) & 0xffff;
            if (!this.mem.can(a, R)) {
              okRead = false;
              break;
            }
            out.push(this.mem.bytes[a]);
          }
          if (!okRead) {
            ret = ERR.EFAULT;
            break;
          }
          this.stdout.push(...out);
          ret = d;
          break;
        }
        case SYS.ACCESS:
          ret = this.mem.can(b, R) ? ERR.ENOENT : ERR.EFAULT;
          break;
        case SYS.EXECVE: {
          const path = this.readCString(b);
          rec.path = path;
          if (path === undefined || !this.validStringArray(c) || !this.validStringArray(d)) {
            ret = ERR.EFAULT;
          } else if (path === '/bin/sh') {
            this.status = 'shell';
            ret = 0;
          } else {
            ret = ERR.ENOENT;
          }
          break;
        }
        case SYS.EXIT:
          this.status = 'exited';
          this.exitCode = b;
          ret = 0;
          break;
        default:
          ret = ERR.ENOSYS;
      }
    }
    rec.ret = ret;
    this.syscalls.push(rec);
    if (this.status === 'running') g[ACC] = ret;
  }
}
