import { writeSync } from "node:fs";

/**
 * Write `data` to `fd` in full, retrying after short writes.
 *
 * POSIX allows `write(2)` to return fewer bytes than requested (common on
 * non-Linux platforms and on some edge cases under memory pressure). Node's
 * `fs.writeSync` exposes this directly: the return value is the number of
 * bytes actually written, which can be less than the buffer length.  Callers
 * that ignore the return value risk silent partial writes that leave torn
 * JSONL lines on disk.
 *
 * This helper converts the string to a `Buffer` once (so byte-length is
 * stable across iterations) and loops until every byte is on disk.
 */
export function writeAllSync(fd: number, data: string): void {
  const buf = Buffer.from(data);
  let offset = 0;
  while (offset < buf.length) {
    try {
      offset += writeSync(fd, buf, offset, buf.length - offset);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "EINTR") continue;
      throw err;
    }
  }
}
