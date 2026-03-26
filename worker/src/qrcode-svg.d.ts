/**
 * Type declarations for qrcode-svg.
 * The library doesn't ship its own types, so we declare them here.
 * Place this file in the same src/ directory as worker.ts.
 */
declare module 'qrcode-svg' {
  interface Options {
    content: string;
    padding?: number;
    width?: number;
    height?: number;
    color?: string;
    background?: string;
    ecl?: 'L' | 'M' | 'Q' | 'H';
  }
  export default class QRCode {
    constructor(options: Options);
    svg(): string;
  }
}
