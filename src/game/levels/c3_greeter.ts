import { CRT0, type LevelDef } from '../level';

// Chapter 3: shellcode on an executable stack, NOP sled to absorb stack shift.
export const c3Greeter: LevelDef = {
  id: 'c3-1',
  chapter: 3,
  source: `// greeter.c  (linked with -z execstack)

const char *debug_shell = "/bin/sh";   // unused, but still in .data

void greet(void) {
    char name[48];

    write(1, "Name, agent?\\n", 13);
    read(0, name, 128);   // 128 bytes into a 48-byte buffer
}

int main(void) {
    greet();
    return 0;
}`,
  text: `${CRT0}
main:
    PUSH BP
    MOV  BP, SP
    CALL greet
    XOR  A, A
    LEAVE
    RET

greet:
    PUSH BP
    MOV  BP, SP
    SUB  SP, 48         ; name @ BP-48
    MOV  A, 1           ; SYS_write
    MOV  B, 1
    MOV  C, prompt
    MOV  D, 13
    SYSCALL
    XOR  A, A           ; SYS_read
    XOR  B, B
    MOV  C, BP
    SUB  C, 48
    MOV  D, 128
    SYSCALL
    LEAVE
    RET
`,
  data: `
prompt:      .ascii "Name, agent?\\n"
debug_shell: .word  bin_sh
bin_sh:      .asciz "/bin/sh"
`,
  stackExec: true,
  envs: [
    ['USER=ctf', 'SHELL=/bin/sh'],
    ['USER=ctf', 'SHELL=/bin/sh', 'TERM=xterm'],
    ['USER=ctf', 'SHELL=/bin/sh', 'TERM=vt100', 'LANG=C'],
    ['USER=ctf', 'SHELL=/bin/sh', 'TERM=xterm', 'LANG=uk_UA'],
  ],
  goal: { type: 'shell' },
  frame: { fn: 'greet', slots: [{ name: 'name[48]', offset: -48, size: 48 }] },
  par: { bytes: 52, cycles: 90, insns: 50 },
};
