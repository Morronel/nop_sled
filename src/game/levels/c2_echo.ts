import { CRT0, type LevelDef } from '../level';

// Chapter 2: overwrite the saved return address, return into win().
export const c2Echo: LevelDef = {
  id: 'c2-1',
  chapter: 2,
  source: `// echo_service.c

void win(void) {          // debug leftover, never called
    write(1, flag, sizeof(flag));
    exit(0);
}

void echo(void) {
    char buf[8];

    read(0, buf, 64);     // 64 bytes into an 8-byte buffer
    write(1, buf, 8);
}

int main(void) {
    echo();
    return 0;
}`,
  text: `${CRT0}
win:
    PUSH BP
    MOV  BP, SP
    MOV  A, 1
    MOV  B, 1
    MOV  C, flag
    MOV  D, flag_end-flag
    SYSCALL
    MOV  A, 0x3C
    XOR  B, B
    SYSCALL

echo:
    PUSH BP
    MOV  BP, SP
    SUB  SP, 8          ; buf @ BP-8
    XOR  A, A           ; SYS_read
    XOR  B, B
    MOV  C, BP
    SUB  C, 8
    MOV  D, 64
    SYSCALL
    MOV  A, 1           ; SYS_write
    MOV  B, 1
    MOV  C, BP
    SUB  C, 8
    MOV  D, 8
    SYSCALL
    LEAVE
    RET

main:
    PUSH BP
    MOV  BP, SP
    CALL echo
    XOR  A, A
    LEAVE
    RET
`,
  data: `
flag:     .ascii "FLAG{r3turn_t0_s3nd3r}\\n"
flag_end:
`,
  stackExec: true,
  envs: [['USER=ctf', 'SHELL=/bin/sh', 'PATH=/usr/bin:/bin']],
  goal: { type: 'reach', symbol: 'win' },
  frame: { fn: 'echo', slots: [{ name: 'buf[8]', offset: -8, size: 8 }] },
  par: { bytes: 12, cycles: 49, insns: 21 },
};
