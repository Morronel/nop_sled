// Text formatting shared by the debugger and results views.

import { SYS, type SyscallRecord } from '../cpu/cpu';
import { hex2, hex4 } from '../cpu/isa';
import { fmt, S } from '../i18n';
import type { Session } from '../game/session';

export const hexList = (bytes: number[]) => bytes.map(hex2).join(' ');

export function statusText(s: Session): string {
  const t = S().status;
  const cpu = s.cpu;
  switch (cpu.status) {
    case 'running':
      if (s.goalReached && s.level.goal.type === 'reach') return fmt(t.goal, { symbol: s.level.goal.symbol });
      return cpu.steps === 0 ? t.ready : t.running;
    case 'exited':
      return fmt(t.exited, { code: cpu.exitCode ?? 0 });
    case 'shell':
      return t.shell;
    case 'timeout':
      return fmt(t.timeout, { n: cpu.maxCycles });
    case 'faulted': {
      const f = cpu.fault!;
      const reason = fmt(S().fault[f.kind], { addr: hex4(f.addr) });
      return fmt(t.faulted, { signal: f.signal, ip: hex4(f.ip), reason });
    }
  }
}

const SYS_NAMES: Record<number, string> = {
  [SYS.READ]: 'read',
  [SYS.WRITE]: 'write',
  [SYS.ACCESS]: 'access',
  [SYS.EXECVE]: 'execve',
  [SYS.EXIT]: 'exit',
};

const ERRNO: Record<number, string> = { 0xfffe: '-ENOENT', 0xfff7: '-EBADF', 0xfff2: '-EFAULT', 0xffda: '-ENOSYS' };

export function syscallText(r: SyscallRecord): string {
  const name = SYS_NAMES[r.nr] ?? `sys_0x${hex2(r.nr)}`;
  const a = r.args.map((v) => `0x${hex4(v)}`);
  let args: string;
  if (r.nr === SYS.EXIT) args = String(r.args[0]);
  else if (r.nr === SYS.ACCESS) args = a[0];
  else if (r.nr === SYS.EXECVE) args = `${r.path !== undefined ? JSON.stringify(r.path) : a[0]}, ${a[1]}, ${a[2]}`;
  else args = `${r.args[0]}, ${a[1]}, ${r.args[2]}`;
  const ret = r.nr === SYS.EXIT ? '' : ` = ${ERRNO[r.ret] ?? r.ret}`;
  return `${name}(${args})${ret}`;
}

export function printable(bytes: number[]): string {
  return bytes
    .map((b) => (b === 0x0a ? '\n' : b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : `\\x${hex2(b).toLowerCase()}`))
    .join('');
}
