// Minimal ambient types for gifenc (ships no .d.ts).
declare module "gifenc" {
  export interface GifFrameOpts {
    palette?: number[][];
    delay?: number;
    transparent?: boolean;
    dispose?: number;
  }
  export interface Encoder {
    writeFrame(
      index: Uint8Array,
      width: number,
      height: number,
      opts?: GifFrameOpts,
    ): void;
    finish(): void;
    bytes(): Uint8Array;
  }
  export function GIFEncoder(): Encoder;
  export function quantize(
    rgba: Uint8Array | Uint8ClampedArray,
    maxColors: number,
    opts?: Record<string, unknown>,
  ): number[][];
  export function applyPalette(
    rgba: Uint8Array | Uint8ClampedArray,
    palette: number[][],
    format?: string,
  ): Uint8Array;
}
