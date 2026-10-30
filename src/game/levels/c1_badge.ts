import { CRT0, type LevelDef } from '../level';

// Chapter 1: overwrite an adjacent local variable.
export const c1Badge: LevelDef = {
  id: 'c1-1',
  chapter: 1,
  source: `// badge_reader.c  (built without -fstack-protector)

void win(void) {
    write(1, flag, sizeof(flag));
    exit(0);
}

void check_badge(void) {
    uint16_t clearance = 0x0000;
    char badge[8];

    read(0, badge, 32);   // up to 32 bytes into an 8-byte buffer

    if (clearance == 0x1337)
        win();
    write(1, "ACCESS DENIED\\n", 14);
}

int main(void) {
    check_badge();
    return 0;
}`,
  text: `${CRT0}
main:
    PUSH BP
    MOV  BP, SP
    CALL check_badge
    XOR  A, A
    LEAVE
    RET

check_badge:
    PUSH BP
    MOV  BP, SP
    SUB  SP, 10         ; clearance @ BP-2, badge @ BP-10
    MOV  B, BP
    SUB  B, 2
    XOR  A, A
    ST   [B], A         ; clearance = 0
    XOR  B, B           ; fd 0   (A = 0 = SYS_read)
    MOV  C, BP
    SUB  C, 10          ; badge
    MOV  D, 32
    SYSCALL
    MOV  B, BP
    SUB  B, 2
    LD   A, [B]
    CMP  A, 0x1337
    JNZ  denied
    CALL win
denied:
    MOV  A, 1           ; SYS_write
    MOV  B, 1
    MOV  C, msg_denied
    MOV  D, 14
    SYSCALL
    LEAVE
    RET

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
`,
  data: `
msg_denied: .ascii "ACCESS DENIED\\n"
flag:       .ascii "FLAG{l1ttle_end1an_n31ghb0ur}\\n"
flag_end:
`,
  stackExec: true,
  envs: [['USER=ctf', 'SHELL=/bin/sh', 'PATH=/usr/bin:/bin']],
  goal: { type: 'reach', symbol: 'win' },
  frame: {
    fn: 'check_badge',
    slots: [
      { name: 'clearance', offset: -2, size: 2 },
      { name: 'badge[8]', offset: -10, size: 8 },
    ],
  },
  par: { bytes: 10, cycles: 41, insns: 22 },
};
