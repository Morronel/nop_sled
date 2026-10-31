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
    MOV  flag_end-flag, ACC
    PUSH
    MOV  flag, ACC
    PUSH
    MOV  1, ACC
    PUSH
    SYS                 ; write(1, flag, len)
    MOV  0, ACC
    PUSH
    MOV  0x3C, ACC
    SYS                 ; exit(0)

echo:
    ADJ  -8             ; buf @ SP+0
    MOV  64, ACC        ; read(0, buf, 64)
    PUSH
    MOV  SP, ACC
    ADD  2
    PUSH
    MOV  0, ACC
    PUSH
    SYS
    ADJ  6
    MOV  8, ACC         ; write(1, buf, 8)
    PUSH
    MOV  SP, ACC
    ADD  2
    PUSH
    MOV  1, ACC
    PUSH
    SYS
    ADJ  14             ; drop the arguments and buf
    RET                 ; IP = word at SP

main:
    CALL echo
    MOV  0, ACC
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
  par: { bytes: 10, cycles: 39, insns: 22 },
};
