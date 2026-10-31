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
    CALL greet
    MOV  0, ACC
    RET

greet:
    ADJ  -48            ; name @ SP+0
    MOV  13, ACC        ; write(1, prompt, 13)
    PUSH
    MOV  prompt, ACC
    PUSH
    MOV  1, ACC
    PUSH
    SYS
    ADJ  6
    MOV  128, ACC       ; read(0, name, 128)
    PUSH
    MOV  SP, ACC
    ADD  2
    PUSH
    MOV  0, ACC
    PUSH
    SYS
    ADJ  54             ; drop the arguments and name
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
  par: { bytes: 50, cycles: 81, insns: 57 },
};
