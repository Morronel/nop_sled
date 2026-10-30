// The payload is edited as a list of chunks (one per insert) so it stays readable.

export interface Chunk {
  bytes: number[];
  /** Assembly-style label, not translated: "NOP", "MOV A, 0x003B", "db 41", "dw 0x1337". */
  label: string;
  rep: number;
}

export function flatten(chunks: Chunk[]): number[] {
  const out: number[] = [];
  for (const c of chunks) for (let i = 0; i < c.rep; i++) out.push(...c.bytes);
  return out;
}

export function chunkLength(c: Chunk): number {
  return c.bytes.length * c.rep;
}

export function isChunkList(v: unknown): v is Chunk[] {
  return (
    Array.isArray(v) &&
    v.every(
      (c) =>
        c && Array.isArray(c.bytes) && c.bytes.every((b: unknown) => typeof b === 'number' && b >= 0 && b < 256) &&
        typeof c.label === 'string' && Number.isInteger(c.rep) && c.rep > 0,
    )
  );
}
