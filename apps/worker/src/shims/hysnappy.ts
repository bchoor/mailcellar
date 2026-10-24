// Stands in for hysnappy, which hyparquet-compressors (via icebird) loads: hysnappy compiles
// WebAssembly at run time, which Workers forbid. hyparquet's own JavaScript snappy does the job.
import { snappyUncompress as uncompressInto } from 'hyparquet';

export function snappyUncompress(input: Uint8Array, outputLength: number): Uint8Array {
  const output = new Uint8Array(outputLength);
  uncompressInto(input, output);
  return output;
}
export const snappyUncompressor = () => snappyUncompress;
export function snappyCompress(): never {
  throw new Error('snappy compression is not available here');
}
export const snappyCompressor = () => snappyCompress;
