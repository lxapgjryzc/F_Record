/**
 * A zip writer on nothing but fs, zlib and stream.
 *
 * Node has no archive module and the plug-in bundles no dependency it can do
 * without, so the format is written directly: a local header and the bytes
 * for each file, then the central directory and the end record. Each entry
 * is streamed from disk with its CRC and sizes learned on the way and written
 * after the data in a data descriptor (general purpose flag bit 3) -- the
 * arrangement every writer that cannot seek uses, and one that Explorer,
 * 7-Zip and the macOS Archive Utility all read. Frames are JPEG already, so
 * they are stored as they are; everything else -- the PSD, session.json -- is
 * deflated. Names are UTF-8 (flag bit 11), so a document called 龙.psd keeps
 * its name.
 *
 * Zip64 fields are written for an entry near or beyond 4 GB, a directory
 * beyond 4 GB, or more than 65,535 entries, which a long recording can be.
 *
 * The archive is assembled under a `.part` name and renamed into place only
 * once the end record is on disk, so a half-written zip is never mistaken
 * for a whole one; failure part-way removes the part file.
 */

import * as fs from "fs";
import * as path from "path";
import * as zlib from "zlib";
import { Transform } from "stream";
import { exists, mkdirp, rmrf } from "../../shared/compat";

export interface ZipEntry {
    /** Path inside the archive, with forward slashes. */
    name: string;
    /** File on disk. */
    source: string;
}

export type ZipProgressListener = (done: number, total: number) => void;

const SIG_LOCAL = 0x04034b50;
const SIG_DESCRIPTOR = 0x08074b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;
const SIG_ZIP64_END = 0x06064b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const ZIP64_EXTRA_ID = 0x0001;

const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
const FLAG_DESCRIPTOR = 0x0008;
const FLAG_UTF8 = 0x0800;
const VERSION_DEFLATE = 20;
const VERSION_ZIP64 = 45;

const LIMIT_16 = 0xffff;
const LIMIT_32 = 0xffffffff;
/**
 * Deflate can grow a file by a few bytes per block, so an entry that is
 * nearly 4 GB going in could come out over the line. Anything past this is
 * given zip64 fields up front rather than found out about too late.
 */
const ZIP64_ENTRY_THRESHOLD = 0xf0000000;

/** Formats that are compressed already, where deflate would only burn CPU. */
const STORED_EXTENSIONS: { [ext: string]: boolean } = {
    ".jpg": true,
    ".jpeg": true,
    ".png": true,
    ".gif": true,
    ".webp": true,
    ".mp4": true,
    ".mov": true,
    ".zip": true,
    ".7z": true
};

/* -------------------------------------------------------------------- crc */

const CRC_TABLE = (function (): number[] {
    const table: number[] = [];
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) {
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }
        table.push(c >>> 0);
    }
    return table;
})();

/** Feeds `buf` into a running CRC-32; start from 0. */
export function crc32(crc: number, buf: Buffer): number {
    let c = (crc ^ 0xffffffff) >>> 0;
    for (let i = 0; i < buf.length; i++) {
        c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
}

/* ---------------------------------------------------------------- streams */

/** Passes bytes through, counting them and, if asked, running the CRC. */
class ByteCounter extends Transform {
    bytes = 0;
    crc = 0;

    constructor(private readonly withCrc: boolean) {
        super();
    }

    _transform(chunk: Buffer, _encoding: string, callback: (error?: Error | null, data?: Buffer) => void): void {
        this.bytes += chunk.length;
        if (this.withCrc) {
            this.crc = crc32(this.crc, chunk);
        }
        callback(null, chunk);
    }
}

interface EntrySizes {
    crc: number;
    size: number;
    compressedSize: number;
}

/**
 * The file being written, with the byte offset every header needs. Writes
 * are sequential by construction: headers go through `write`, entry bodies
 * are piped in between with the stream kept open, and both land in call
 * order.
 */
class Output {
    offset = 0;
    private readonly stream: fs.WriteStream;
    private failure: Error | null = null;

    constructor(file: string) {
        this.stream = fs.createWriteStream(file);
        this.stream.on("error", (e: Error) => {
            this.failure = e;
        });
    }

    write(buf: Buffer): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            if (this.failure) {
                reject(this.failure);
                return;
            }
            this.offset += buf.length;
            this.stream.write(buf, (e?: Error | null) => {
                if (e) {
                    reject(e);
                } else {
                    resolve();
                }
            });
        });
    }

    /** Streams one file in, deflated or as it is, and reports what went by. */
    pipeFile(source: string, deflate: boolean): Promise<EntrySizes> {
        return new Promise<EntrySizes>((resolve, reject) => {
            if (this.failure) {
                reject(this.failure);
                return;
            }
            const reader = fs.createReadStream(source);
            const raw = new ByteCounter(true);
            const packed = new ByteCounter(false);
            let settled = false;
            const fail = (e: Error) => {
                if (settled) {
                    return;
                }
                settled = true;
                this.stream.removeListener("error", fail);
                try {
                    if (typeof (reader as any).destroy === "function") {
                        (reader as any).destroy();
                    } else {
                        reader.close();
                    }
                } catch (e2) {
                    /* the read stream is going away regardless */
                }
                reject(e);
            };
            // A failing destination unpipes and stalls the source rather than
            // telling it, so the destination's own error has to end this too.
            this.stream.on("error", fail);
            reader.on("error", fail);
            raw.on("error", fail);
            packed.on("error", fail);

            let tail: NodeJS.ReadableStream = reader.pipe(raw);
            if (deflate) {
                const deflater = zlib.createDeflateRaw();
                deflater.on("error", fail);
                tail = tail.pipe(deflater);
            }
            tail.pipe(packed).pipe(this.stream, { end: false });
            packed.on("end", () => {
                if (settled) {
                    return;
                }
                settled = true;
                this.stream.removeListener("error", fail);
                this.offset += packed.bytes;
                resolve({ crc: raw.crc, size: raw.bytes, compressedSize: packed.bytes });
            });
        });
    }

    finish(): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            if (this.failure) {
                reject(this.failure);
                return;
            }
            this.stream.once("error", reject);
            this.stream.end(() => resolve());
        });
    }

    abort(): void {
        try {
            this.stream.destroy();
        } catch (e) {
            /* already gone */
        }
    }
}

/* -------------------------------------------------------------- records */

interface CentralRecord {
    name: Buffer;
    method: number;
    dosTime: number;
    dosDate: number;
    crc: number;
    size: number;
    compressedSize: number;
    offset: number;
    zip64: boolean;
}

function dosDateTime(date: Date): { time: number; date: number } {
    // The format starts in 1980 and has two-second resolution.
    const year = Math.max(1980, date.getFullYear());
    return {
        time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
        date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
    };
}

function writeUInt64LE(buf: Buffer, value: number, offset: number): void {
    const high = Math.floor(value / 0x100000000);
    const low = value - high * 0x100000000;
    buf.writeUInt32LE(low >>> 0, offset);
    buf.writeUInt32LE(high >>> 0, offset + 4);
}

/** The zip64 extended information extra field, with whichever values are given. */
function zip64Extra(values: number[]): Buffer {
    const buf = Buffer.alloc(4 + values.length * 8);
    buf.writeUInt16LE(ZIP64_EXTRA_ID, 0);
    buf.writeUInt16LE(values.length * 8, 2);
    for (let i = 0; i < values.length; i++) {
        writeUInt64LE(buf, values[i], 4 + i * 8);
    }
    return buf;
}

function localHeader(record: CentralRecord): Buffer {
    // With a data descriptor to follow, the sizes and CRC here are zero. The
    // zip64 extra field is present -- with zeros too -- only to say that the
    // descriptor carries 8-byte sizes.
    const extra = record.zip64 ? zip64Extra([0, 0]) : Buffer.alloc(0);
    const buf = Buffer.alloc(30 + record.name.length + extra.length);
    buf.writeUInt32LE(SIG_LOCAL, 0);
    buf.writeUInt16LE(record.zip64 ? VERSION_ZIP64 : VERSION_DEFLATE, 4);
    buf.writeUInt16LE(FLAG_DESCRIPTOR | FLAG_UTF8, 6);
    buf.writeUInt16LE(record.method, 8);
    buf.writeUInt16LE(record.dosTime, 10);
    buf.writeUInt16LE(record.dosDate, 12);
    buf.writeUInt32LE(0, 14);
    buf.writeUInt32LE(0, 18);
    buf.writeUInt32LE(0, 22);
    buf.writeUInt16LE(record.name.length, 26);
    buf.writeUInt16LE(extra.length, 28);
    record.name.copy(buf, 30);
    extra.copy(buf, 30 + record.name.length);
    return buf;
}

function dataDescriptor(record: CentralRecord): Buffer {
    const buf = Buffer.alloc(record.zip64 ? 24 : 16);
    buf.writeUInt32LE(SIG_DESCRIPTOR, 0);
    buf.writeUInt32LE(record.crc, 4);
    if (record.zip64) {
        writeUInt64LE(buf, record.compressedSize, 8);
        writeUInt64LE(buf, record.size, 16);
    } else {
        buf.writeUInt32LE(record.compressedSize, 8);
        buf.writeUInt32LE(record.size, 12);
    }
    return buf;
}

function centralHeader(record: CentralRecord): Buffer {
    // An entry that needs zip64 anywhere gets all three wide fields, in the
    // order the format fixes, with the narrow ones set to the marker.
    const wide = record.zip64 || record.offset >= LIMIT_32;
    const extra = wide ? zip64Extra([record.size, record.compressedSize, record.offset]) : Buffer.alloc(0);
    const buf = Buffer.alloc(46 + record.name.length + extra.length);
    buf.writeUInt32LE(SIG_CENTRAL, 0);
    buf.writeUInt16LE(wide ? VERSION_ZIP64 : VERSION_DEFLATE, 4);
    buf.writeUInt16LE(wide ? VERSION_ZIP64 : VERSION_DEFLATE, 6);
    buf.writeUInt16LE(FLAG_DESCRIPTOR | FLAG_UTF8, 8);
    buf.writeUInt16LE(record.method, 10);
    buf.writeUInt16LE(record.dosTime, 12);
    buf.writeUInt16LE(record.dosDate, 14);
    buf.writeUInt32LE(record.crc, 16);
    buf.writeUInt32LE(wide ? LIMIT_32 : record.compressedSize, 20);
    buf.writeUInt32LE(wide ? LIMIT_32 : record.size, 24);
    buf.writeUInt16LE(record.name.length, 28);
    buf.writeUInt16LE(extra.length, 30);
    buf.writeUInt16LE(0, 32); // comment
    buf.writeUInt16LE(0, 34); // disk
    buf.writeUInt16LE(0, 36); // internal attributes
    buf.writeUInt32LE(0, 38); // external attributes
    buf.writeUInt32LE(wide ? LIMIT_32 : record.offset, 42);
    record.name.copy(buf, 46);
    extra.copy(buf, 46 + record.name.length);
    return buf;
}

function endRecords(count: number, directoryOffset: number, directorySize: number, anyZip64: boolean): Buffer {
    const needZip64 =
        anyZip64 || count > LIMIT_16 || directoryOffset >= LIMIT_32 || directorySize >= LIMIT_32;
    const parts: Buffer[] = [];
    if (needZip64) {
        const zip64End = Buffer.alloc(56);
        zip64End.writeUInt32LE(SIG_ZIP64_END, 0);
        writeUInt64LE(zip64End, 44, 4); // size of the rest of this record
        zip64End.writeUInt16LE(VERSION_ZIP64, 12);
        zip64End.writeUInt16LE(VERSION_ZIP64, 14);
        zip64End.writeUInt32LE(0, 16); // this disk
        zip64End.writeUInt32LE(0, 20); // disk with the directory
        writeUInt64LE(zip64End, count, 24);
        writeUInt64LE(zip64End, count, 32);
        writeUInt64LE(zip64End, directorySize, 40);
        writeUInt64LE(zip64End, directoryOffset, 48);
        parts.push(zip64End);

        const locator = Buffer.alloc(20);
        locator.writeUInt32LE(SIG_ZIP64_LOCATOR, 0);
        locator.writeUInt32LE(0, 4);
        writeUInt64LE(locator, directoryOffset + directorySize, 8);
        locator.writeUInt32LE(1, 16);
        parts.push(locator);
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(SIG_END, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(Math.min(count, LIMIT_16), 8);
    end.writeUInt16LE(Math.min(count, LIMIT_16), 10);
    end.writeUInt32LE(Math.min(directorySize, LIMIT_32), 12);
    end.writeUInt32LE(Math.min(directoryOffset, LIMIT_32), 16);
    end.writeUInt16LE(0, 20);
    parts.push(end);
    return Buffer.concat(parts);
}

/* --------------------------------------------------------------- writing */

/** Whether an entry is stored as it is or deflated, by its extension. */
export function zipMethodFor(name: string): "store" | "deflate" {
    return STORED_EXTENSIONS[path.extname(name).toLowerCase()] ? "store" : "deflate";
}

/**
 * Writes `entries` into a zip at `target`, which must not exist yet.
 * Progress counts entries written.
 */
export async function writeZip(target: string, entries: ZipEntry[], onProgress?: ZipProgressListener): Promise<void> {
    if (exists(target)) {
        throw new Error("'" + target + "' already exists");
    }
    mkdirp(path.dirname(target));
    const partial = target + ".part";
    rmrf(partial);
    const out = new Output(partial);
    const records: CentralRecord[] = [];
    try {
        for (let i = 0; i < entries.length; i++) {
            const entry = entries[i];
            const stat = fs.statSync(entry.source);
            const record: CentralRecord = {
                name: Buffer.from(entry.name.replace(/\\/g, "/"), "utf8"),
                method: zipMethodFor(entry.name) === "store" ? METHOD_STORE : METHOD_DEFLATE,
                dosTime: dosDateTime(stat.mtime).time,
                dosDate: dosDateTime(stat.mtime).date,
                crc: 0,
                size: 0,
                compressedSize: 0,
                offset: out.offset,
                zip64: stat.size >= ZIP64_ENTRY_THRESHOLD
            };
            await out.write(localHeader(record));
            const sizes = await out.pipeFile(entry.source, record.method === METHOD_DEFLATE);
            record.crc = sizes.crc;
            record.size = sizes.size;
            record.compressedSize = sizes.compressedSize;
            await out.write(dataDescriptor(record));
            records.push(record);
            if (onProgress) {
                onProgress(i + 1, entries.length);
            }
        }

        const directoryOffset = out.offset;
        let anyZip64 = false;
        for (let i = 0; i < records.length; i++) {
            if (records[i].zip64 || records[i].offset >= LIMIT_32) {
                anyZip64 = true;
            }
            await out.write(centralHeader(records[i]));
        }
        await out.write(endRecords(records.length, directoryOffset, out.offset - directoryOffset, anyZip64));
        await out.finish();
    } catch (e) {
        out.abort();
        rmrf(partial);
        throw e;
    }
    fs.renameSync(partial, target);
}
