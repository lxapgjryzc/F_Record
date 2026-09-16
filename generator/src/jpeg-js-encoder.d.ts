/**
 * jpeg-js types only its package entry; encoder.ts imports the encoder module
 * directly (see there for why), and this gives that import the same signature.
 */
declare module "jpeg-js/lib/encoder.js" {
    import { encode } from "jpeg-js";
    const encodeJpeg: typeof encode;
    export = encodeJpeg;
}
