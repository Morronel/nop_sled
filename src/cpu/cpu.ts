// SK-16 emulator: executes one instruction per step() and implements syscalls.

import { BP, SP, cyclesOf, decode, type Insn } from './isa';
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
  readonly regs = new Uint16Array(6);
  ip = 0;
  z = false;
  c = false;
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

  private alu(mn: Insn['mn'], a: number, b: number): number {
    let r: number;
    switch (mn) {
      case 'ADD':
        r = a + b;
        this.c = r > 0xffff;
        break;
      case 'SUB':
      case 'CMP':
        r = a - b;
        this.c = a < b;
        break;
      case 'AND':
        r = a & b;
        this.c = false;
        break;
      default: // XOR
        r = a ^ b;
        this.c = false;
    }
    r &= 0xffff;
    this.z = r === 0;
    return r;
  }

  private exec(insn: Insn): void {
    const g = this.regs;
    const d = insn.d ?? 0;
    const s = insn.s ?? 0;
    const imm = insn.imm ?? 0;
    switch (insn.mn) {
      case 'NOP':
        return;
      case 'MOV':
        g[d] = insn.form === 'r_imm' ? imm : g[s];
        return;
      case 'LD':
        g[d] = this.mem.read16(g[s]);
        return;
      case 'ST':
        this.mem.write16(g[d], g[s]);
        return;
      case 'ADD':
      case 'SUB':
      case 'AND':
      case 'XOR':
      case 'CMP': {
        const r = this.alu(insn.mn, g[d], insn.form === 'r_imm' ? imm : g[s]);
        if (insn.mn !== 'CMP') g[d] = r;
        return;
      }
      case 'JMP':
        this.ip = insn.form === 'r' ? g[d] : (this.ip + imm) & 0xffff;
        return;
      case 'JZ':
        if (this.z) this.ip = (this.ip + imm) & 0xffff;
        return;
      case 'JNZ':
        if (!this.z) this.ip = (this.ip + imm) & 0xffff;
        return;
      case 'CALL':
        this.push(this.ip);
        this.ip = (this.ip + imm) & 0xffff;
        return;
      case 'RET':
        this.ip = this.pop();
        return;
      case 'LEAVE':
        g[SP] = g[BP];
        g[BP] = this.pop();
        return;
      case 'PUSH':
        this.push(g[d]); // PUSH SP pushes the pre-decrement value, as on x86
        return;
      case 'POP': {
        const v = this.pop();
        g[d] = v; // POP SP: SP ends up holding the popped value
        return;
      }
      case 'SYSCALL':
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

  /** argv/envp check for execve: NULL, or a NULL-terminated array of string pointers. */
  private validStringArray(addr: number): boolean {
    if (addr === 0) return true;
    for (let i = 0; i < 32; i++) {
      const p = (addr + i * 2) & 0xffff;
      if (!this.mem.can(p, R) || !this.mem.can(p + 1, R)) return false;
      const ptr = this.mem.bytes[p] | (this.mem.bytes[(p + 1) & 0xffff] << 8);
      if (ptr === 0) return true;
      if (this.readCString(ptr) === undefined) return false;
    }
    return false;
  }

  private syscall(): void {
    const g = this.regs;
    const nr = g[0];
    const args: [number, number, number] = [g[1], g[2], g[3]];
    const [b, c, d] = args;
    const rec: SyscallRecord = { nr, args, ret: 0 };
    let ret: number;
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
    rec.ret = ret;
    this.syscalls.push(rec);
    if (this.status === 'running') g[0] = ret;
  }
}
