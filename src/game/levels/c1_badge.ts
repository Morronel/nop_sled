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
    CALL check_badge
    MOV  0, ACC         ; return 0
    RET

check_badge:
    ADJ  -10            ; badge @ SP+0, clearance @ SP+8
    MOV  SP, ACC
    ADD  8
    SWP                 ; PTR = &clearance
    MOV  0, ACC
    ST                  ; clearance = 0
    MOV  32, ACC        ; read(0, badge, 32): push args right to left
    PUSH
    MOV  SP, ACC
    ADD  2
    PUSH                ;   badge
    MOV  0, ACC
    PUSH                ;   fd 0
    SYS                 ; ACC = 0 = SYS_read
    ADJ  6              ; drop the arguments
    MOV  SP, ACC
    ADD  8
    SWP
    LD                  ; ACC = clearance
    SUB  0x1337
    JNZ  denied
    CALL win
denied:
    MOV  14, ACC        ; write(1, msg_denied, 14)
    PUSH
    MOV  msg_denied, ACC
    PUSH
    MOV  1, ACC
    PUSH
    SYS                 ; ACC = 1 = SYS_write
    ADJ  16             ; drop the arguments and the locals
    RET

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
  par: { bytes: 10, cycles: 36, insns: 24 },
};
