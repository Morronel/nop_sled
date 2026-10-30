// Paged 64 KiB memory with R/W/X permissions and input taint tracking.

export const PAGE_SIZE = 0x100;
export const R = 1;
export const W = 2;
export const X = 4;

export type Signal = 'SIGSEGV' | 'SIGILL' | 'SIGABRT';
export type FaultKind = 'read' | 'write' | 'exec' | 'illegal' | 'abort';

export class Fault extends Error {
  constructor(
    public signal: Signal,
    public kind: FaultKind,
    public addr: number,
  ) {
    super(`${signal} (${kind}) at 0x${addr.toString(16)}`);
  }
}

export function permString(p: number): string {
  if (!p) return '---';
  return (p & R ? 'R' : '-') + (p & W ? 'W' : '-') + (p & X ? 'X' : '-');
}

export class Memory {
  readonly bytes = new Uint8Array(0x10000);
  /** Permission bits per 256-byte page; 0 = unmapped. */
  readonly perms = new Uint8Array(0x100);
  /** 1 for every byte last written by read(0, ...) — i.e. attacker-controlled. */
  readonly taint = new Uint8Array(0x10000);
  /** Addresses written during the current instruction (for UI highlights). */
  lastWrites: number[] = [];

  map(start: number, size: number, perms: number): void {
    const first = start >> 8;
    const last = (start + size - 1) >> 8;
    for (let p = first; p <= last; p++) this.perms[p] = perms;
  }

  permAt(addr: number): number {
    return this.perms[(addr & 0xffff) >> 8];
  }

  can(addr: number, perm: number): boolean {
    return (this.permAt(addr) & perm) === perm;
  }

  /** Copy bytes in, ignoring permissions (loader use). */
  load(addr: number, data: ArrayLike<number>): void {
    for (let i = 0; i < data.length; i++) this.bytes[(addr + i) & 0xffff] = data[i];
  }

  read8(addr: number): number {
    addr &= 0xffff;
    if (!this.can(addr, R)) throw new Fault('SIGSEGV', 'read', addr);
    return this.bytes[addr];
  }

  fetch8(addr: number): number {
    addr &= 0xffff;
    if (!this.can(addr, X)) throw new Fault('SIGSEGV', 'exec', addr);
    return this.bytes[addr];
  }

  write8(addr: number, v: number, tainted = false): void {
    addr &= 0xffff;
    if (!this.can(addr, W)) throw new Fault('SIGSEGV', 'write', addr);
    this.bytes[addr] = v & 0xff;
    this.taint[addr] = tainted ? 1 : 0;
    this.lastWrites.push(addr);
  }

  read16(addr: number): number {
    return this.read8(addr) | (this.read8(addr + 1) << 8);
  }

  write16(addr: number, v: number): void {
    // Check both bytes first so a faulting store doesn't half-complete.
    if (!this.can(addr, W)) throw new Fault('SIGSEGV', 'write', addr & 0xffff);
    if (!this.can(addr + 1, W)) throw new Fault('SIGSEGV', 'write', (addr + 1) & 0xffff);
    this.write8(addr, v & 0xff);
    this.write8(addr + 1, (v >> 8) & 0xff);
  }

  /** Raw peek for the debugger: never faults, returns undefined for unmapped bytes. */
  peek(addr: number): number | undefined {
    addr &= 0xffff;
    return this.permAt(addr) ? this.bytes[addr] : undefined;
  }
}
