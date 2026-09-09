/**
 * The zip writer.
 *
 * It is read back here by walking the central directory the way every
 * extractor does -- the end record, then each central header, then each
 * local header and its data -- and inflating what was deflated. If this
 * reader is happy, so are Explorer, 7-Zip and the macOS Archive Utility,
 * which all start from the same end record.
 */

import { mock, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { execFileSync } from "node:child_process";
import { Readable, Transform, Writable } from "node:stream";

import { clearFaults, fsError, mockBuiltins, setFault, tempDir, withFaultAsync } from "./helpers.mjs";

// Loaded through a swappable filesystem and deflater. A zip writer's error
// handling is all about a disk that stops cooperating half way through a
// two-gigabyte archive, and none of it can be reached by writing real files
// that behave.
mockBuiltins(mock, "fs", "zlib");
const { crc32, writeZip, zipMethodFor } = await import("../dist/modules/zip.mjs");

/** A plain reader of the format as written: enough to check every field that matters. */
function readZip(file) {
    const buf = fs.readFileSync(file);
    let end = buf.length - 22;
    while (end >= 0 && buf.readUInt32LE(end) !== 0x06054b50) {
        end--;
    }
    assert.ok(end >= 0, "end of central directory record present");
    let count = buf.readUInt16LE(end + 10);
    let directorySize = buf.readUInt32LE(end + 12);
    let directoryOffset = buf.readUInt32LE(end + 16);
    let zip64 = false;
    if (count === 0xffff || directoryOffset === 0xffffffff) {
        // The zip64 locator sits just before the end record.
        const locator = end - 20;
        assert.equal(buf.readUInt32LE(locator), 0x07064b50, "zip64 locator");
        const z64 = Number(buf.readBigUInt64LE(locator + 8));
        assert.equal(buf.readUInt32LE(z64), 0x06064b50, "zip64 end record");
        count = Number(buf.readBigUInt64LE(z64 + 32));
        directorySize = Number(buf.readBigUInt64LE(z64 + 40));
        directoryOffset = Number(buf.readBigUInt64LE(z64 + 48));
        zip64 = true;
    }

    const entries = [];
    let at = directoryOffset;
    for (let i = 0; i < count; i++) {
        assert.equal(buf.readUInt32LE(at), 0x02014b50, "central header " + i);
        const flags = buf.readUInt16LE(at + 8);
        const method = buf.readUInt16LE(at + 10);
        const crc = buf.readUInt32LE(at + 16);
        let compressedSize = buf.readUInt32LE(at + 20);
        let size = buf.readUInt32LE(at + 24);
        const nameLength = buf.readUInt16LE(at + 28);
        const extraLength = buf.readUInt16LE(at + 30);
        const commentLength = buf.readUInt16LE(at + 32);
        let offset = buf.readUInt32LE(at + 42);
        const name = buf.toString("utf8", at + 46, at + 46 + nameLength);
        const extra = buf.subarray(at + 46 + nameLength, at + 46 + nameLength + extraLength);
        if (size === 0xffffffff || compressedSize === 0xffffffff || offset === 0xffffffff) {
            assert.equal(extra.readUInt16LE(0), 0x0001, "zip64 extra field");
            size = Number(extra.readBigUInt64LE(4));
            compressedSize = Number(extra.readBigUInt64LE(12));
            offset = Number(extra.readBigUInt64LE(20));
        }
        assert.equal(flags & 0x0800, 0x0800, "names are marked UTF-8");
        assert.equal(flags & 0x0008, 0x0008, "sizes live in a data descriptor");

        // Follow the offset to the local header and the bytes after it.
        assert.equal(buf.readUInt32LE(offset), 0x04034b50, "local header for " + name);
        const localNameLength = buf.readUInt16LE(offset + 26);
        const localExtraLength = buf.readUInt16LE(offset + 28);
        assert.equal(buf.toString("utf8", offset + 30, offset + 30 + localNameLength), name);
        const dataStart = offset + 30 + localNameLength + localExtraLength;
        const raw = buf.subarray(dataStart, dataStart + compressedSize);
        const data = method === 8 ? zlib.inflateRawSync(raw) : raw;
        assert.equal(data.length, size, name + ": uncompressed size");
        assert.equal(crc32(0, data), crc, name + ": CRC");
        // And the descriptor after the data says the same.
        const descriptor = dataStart + compressedSize;
        assert.equal(buf.readUInt32LE(descriptor), 0x08074b50, name + ": data descriptor");
        assert.equal(buf.readUInt32LE(descriptor + 4), crc);

        entries.push({ name, method, size, compressedSize, data });
        at += 46 + nameLength + extraLength + commentLength;
    }
    assert.equal(at - directoryOffset, directorySize, "directory size");
    return { entries, zip64 };
}

test("CRC-32 matches the reference values, incrementally too", () => {
    assert.equal(crc32(0, Buffer.from("")), 0);
    assert.equal(crc32(0, Buffer.from("123456789")), 0xcbf43926, "the check value from the standard");
    const whole = crc32(0, Buffer.from("The quick brown fox jumps over the lazy dog"));
    const halves = crc32(crc32(0, Buffer.from("The quick brown fox ")), Buffer.from("jumps over the lazy dog"));
    assert.equal(halves, whole, "feeding the bytes in two pieces gives the same answer");
});

test("frames are stored and everything else deflated", () => {
    assert.equal(zipMethodFor("dragon_frames/000001_1700000000000.jpg"), "store");
    assert.equal(zipMethodFor("x.JPEG"), "store");
    assert.equal(zipMethodFor("dragon.psd"), "deflate");
    assert.equal(zipMethodFor("dragon_frames/session.json"), "deflate");
});

test("a zip round-trips every entry, names in UTF-8 and nested paths included", async (t) => {
    const temp = tempDir();
    t.after(() => temp.cleanup());
    const psd = path.join(temp.dir, "龙.psd");
    const psdBytes = Buffer.alloc(200000);
    for (let i = 0; i < psdBytes.length; i++) {
        psdBytes[i] = (i * 7) & 0xff; // patterned, so deflate has something to do
    }
    fs.writeFileSync(psd, psdBytes);
    const frame = path.join(temp.dir, "000001_1700000000000.jpg");
    fs.writeFileSync(frame, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    const manifest = path.join(temp.dir, "session.json");
    fs.writeFileSync(manifest, JSON.stringify({ sessionId: "s-1" }));
    const empty = path.join(temp.dir, "empty.txt");
    fs.writeFileSync(empty, "");

    const target = path.join(temp.dir, "out", "龙.zip");
    const progress = [];
    await writeZip(
        target,
        [
            { name: "龙.psd", source: psd },
            { name: "龙_frames/000001_1700000000000.jpg", source: frame },
            { name: "龙_frames/notes/session.json", source: manifest },
            { name: "龙_frames/empty.txt", source: empty }
        ],
        (done, total) => progress.push([done, total])
    );

    assert.ok(fs.existsSync(target), "written into a folder that did not exist");
    assert.equal(fs.existsSync(target + ".part"), false, "the part file is renamed away");
    assert.deepEqual(progress, [[1, 4], [2, 4], [3, 4], [4, 4]]);

    const zip = readZip(target);
    assert.equal(zip.zip64, false, "small archives stay in the plain format");
    assert.deepEqual(
        zip.entries.map((e) => e.name),
        ["龙.psd", "龙_frames/000001_1700000000000.jpg", "龙_frames/notes/session.json", "龙_frames/empty.txt"]
    );
    assert.equal(zip.entries[0].method, 8, "the PSD is deflated");
    assert.ok(zip.entries[0].compressedSize < zip.entries[0].size, "and got smaller");
    assert.ok(zip.entries[0].data.equals(psdBytes));
    assert.equal(zip.entries[1].method, 0, "the frame is stored");
    assert.equal(zip.entries[1].compressedSize, 4);
    assert.ok(zip.entries[1].data.equals(Buffer.from([0xff, 0xd8, 0xff, 0xd9])));
    assert.equal(zip.entries[2].data.toString(), JSON.stringify({ sessionId: "s-1" }));
    assert.equal(zip.entries[3].size, 0, "an empty file is an entry too");
});

test("a failure part-way leaves no zip and no part file", async (t) => {
    const temp = tempDir();
    t.after(() => temp.cleanup());
    const good = path.join(temp.dir, "good.txt");
    fs.writeFileSync(good, "fine");
    const target = path.join(temp.dir, "out.zip");

    await assert.rejects(
        writeZip(target, [
            { name: "good.txt", source: good },
            { name: "missing.txt", source: path.join(temp.dir, "missing.txt") }
        ])
    );
    assert.equal(fs.existsSync(target), false);
    assert.equal(fs.existsSync(target + ".part"), false);
});

test("a zip is never written over one that is there", async (t) => {
    const temp = tempDir();
    t.after(() => temp.cleanup());
    const target = path.join(temp.dir, "taken.zip");
    fs.writeFileSync(target, "mine");
    await assert.rejects(writeZip(target, []), /already exists/);
    assert.equal(fs.readFileSync(target, "utf8"), "mine");
});

/**
 * Whether this machine's own extractor can be asked at all.
 *
 * The point of the test below is that Windows reads our archive, so it is
 * worth nothing on a machine whose Microsoft.PowerShell.Archive module will
 * not load -- a broken PowerShell install, not a broken zip. Probed rather
 * than assumed, so a real Expand-Archive failure still fails the test.
 */
function windowsExtractorWorks() {
    if (process.platform !== "win32") {
        return false;
    }
    try {
        execFileSync("powershell.exe", [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Import-Module Microsoft.PowerShell.Archive -ErrorAction Stop"
        ], { stdio: "ignore" });
        return true;
    } catch (e) {
        return false;
    }
}

const EXTRACTOR = windowsExtractorWorks();
test(
    "Windows' own extractor reads what is written",
    { skip: !EXTRACTOR && "this machine has no working Expand-Archive" },
    async (t) => {
        const temp = tempDir();
        t.after(() => temp.cleanup());
        const psd = path.join(temp.dir, "piece.psd");
        fs.writeFileSync(psd, Buffer.alloc(5000, 1));
        const frame = path.join(temp.dir, "000001_1700000000000.jpg");
        fs.writeFileSync(frame, Buffer.from("jpeg bytes"));
        const target = path.join(temp.dir, "piece.zip");
        await writeZip(target, [
            { name: "piece.psd", source: psd },
            { name: "piece_frames/000001_1700000000000.jpg", source: frame }
        ]);

        const out = path.join(temp.dir, "unpacked");
        execFileSync("powershell.exe", [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Expand-Archive -LiteralPath '" + target + "' -DestinationPath '" + out + "'"
        ]);
        assert.ok(fs.readFileSync(path.join(out, "piece.psd")).equals(Buffer.alloc(5000, 1)));
        assert.equal(
            fs.readFileSync(path.join(out, "piece_frames", "000001_1700000000000.jpg"), "utf8"),
            "jpeg bytes"
        );
    }
);

/* ------------------------------------------------- when the disk gives out */

/**
 * A destination stream the test can break at a chosen point.
 *
 * `failOnChunk` makes that write's callback report an error, the way a full
 * disk does. `errorAfterChunk` instead lets the write succeed and then emits
 * an error on the stream, which is what a volume disappearing looks like: the
 * writer only finds out on the next call.
 */
function brittleSink({ failOnChunk = 0, errorAfterChunk = 0, destroyThrows = false } = {}) {
    let seen = 0;
    const sink = new Writable({
        write(chunk, encoding, callback) {
            seen++;
            if (seen === failOnChunk) {
                callback(fsError("ENOSPC", "the disk filled up"));
                return;
            }
            if (seen === errorAfterChunk) {
                process.nextTick(() => sink.emit("error", fsError("EIO", "the volume went away")));
            }
            callback();
        }
    });
    if (destroyThrows) {
        sink.destroy = () => {
            throw new Error("the handle was already gone");
        };
    }
    return sink;
}

/** One small entry, written for real, with the sink swapped out. */
async function zipInto(temp, sink, entryCount = 1) {
    const entries = [];
    for (let i = 1; i <= entryCount; i++) {
        const source = path.join(temp.dir, "note" + i + ".txt");
        fs.writeFileSync(source, "entry " + i);
        entries.push({ name: "note" + i + ".txt", source });
    }
    const target = path.join(temp.dir, "out.zip");
    await withFaultAsync("createWriteStream", () => sink, () => writeZip(target, entries));
    return target;
}

test("a write that reports a full disk takes the part file with it", async (t) => {
    const temp = tempDir();
    t.after(() => temp.cleanup());
    t.after(clearFaults);

    await assert.rejects(zipInto(temp, brittleSink({ failOnChunk: 1 })), /disk filled up/);

    assert.deepEqual(
        fs.readdirSync(temp.dir).filter((n) => n.indexOf("out.zip") === 0),
        [],
        "neither the zip nor its .part survives"
    );
});

test("a volume that goes away is noticed on the next call rather than half-written", async (t) => {
    const temp = tempDir();
    t.after(() => temp.cleanup());
    t.after(clearFaults);

    // The local header goes out fine and the stream fails immediately after,
    // so the failure is waiting when the file's own bytes are about to be
    // streamed in. Reading a whole PSD into a stream that is already dead is
    // exactly the waste this guard avoids.
    await assert.rejects(zipInto(temp, brittleSink({ errorAfterChunk: 1 })), /volume went away/);
});

test("a stream that dies between two entries stops the archive there", async (t) => {
    const temp = tempDir();
    t.after(() => temp.cleanup());
    t.after(clearFaults);

    // Header, data, descriptor -- then the failure, so the second entry's
    // header is the write that finds it.
    await assert.rejects(zipInto(temp, brittleSink({ errorAfterChunk: 3 }), 2), /volume went away/);
});

test("a stream that dies while a file is being streamed in is not waited on", async (t) => {
    const temp = tempDir();
    t.after(() => temp.cleanup());
    t.after(clearFaults);

    await assert.rejects(zipInto(temp, brittleSink({ errorAfterChunk: 2 })), /volume went away/);
});

test("a stream that dies after the end record still fails the archive", async (t) => {
    const temp = tempDir();
    t.after(() => temp.cleanup());
    t.after(clearFaults);

    // Header, data, descriptor, central header, end record: everything is out,
    // but nothing is flushed. Renaming the part file into place now would
    // publish an archive whose last bytes never reached the disk.
    await assert.rejects(zipInto(temp, brittleSink({ errorAfterChunk: 5 })), /volume went away/);
    assert.equal(fs.existsSync(path.join(temp.dir, "out.zip")), false);
});

test("a handle that will not close does not replace the error that caused it", async (t) => {
    const temp = tempDir();
    t.after(() => temp.cleanup());
    t.after(clearFaults);

    // The stream reports the failure as an event rather than through the
    // write callback, so nothing has torn it down before the archive tries to.
    await assert.rejects(
        zipInto(temp, brittleSink({ errorAfterChunk: 1, destroyThrows: true })),
        /volume went away/
    );
});

test("a frame deleted while the archive is being written fails it cleanly", async (t) => {
    const temp = tempDir();
    t.after(() => temp.cleanup());
    t.after(clearFaults);

    const ghost = path.join(temp.dir, "000001_1700000001000.jpg");
    const target = path.join(temp.dir, "out.zip");

    // Housekeeping can delete a recording while a pack of it is in flight, so
    // the file is there when it is measured and gone when it is read.
    const realStat = fs.statSync(temp.dir);
    setFault("statSync", (p, ...rest) => (p === ghost ? realStat : fs.statSync(p, ...rest)));

    await assert.rejects(writeZip(target, [{ name: "a.jpg", source: ghost }]), /ENOENT/);
    assert.equal(fs.existsSync(target + ".part"), false);
});

test("an old Node's read stream is closed the only way it can be", async (t) => {
    const temp = tempDir();
    t.after(() => temp.cleanup());
    t.after(clearFaults);

    // Photoshop 2020's Node has no stream.destroy(); close() is all there is.
    // Getting this wrong leaks a file handle per failed pack on exactly the
    // host least able to spare one.
    let closed = 0;
    setFault("createReadStream", () => {
        const reader = new Readable({ read() {} });
        Object.defineProperty(reader, "destroy", { value: undefined, configurable: true });
        reader.close = () => {
            closed++;
        };
        process.nextTick(() => reader.emit("error", fsError("EIO", "the read failed")));
        return reader;
    });

    const source = path.join(temp.dir, "note.txt");
    fs.writeFileSync(source, "hello");
    await assert.rejects(
        writeZip(path.join(temp.dir, "out.zip"), [{ name: "note.txt", source }]),
        /the read failed/
    );
    assert.equal(closed, 1);
});

test("a read stream that throws on the way out does not mask the read error", async (t) => {
    const temp = tempDir();
    t.after(() => temp.cleanup());
    t.after(clearFaults);

    setFault("createReadStream", () => {
        const reader = new Readable({ read() {} });
        reader.destroy = () => {
            throw new Error("already torn down");
        };
        process.nextTick(() => reader.emit("error", fsError("EIO", "the read failed")));
        return reader;
    });

    const source = path.join(temp.dir, "note.txt");
    fs.writeFileSync(source, "hello");
    await assert.rejects(
        writeZip(path.join(temp.dir, "out.zip"), [{ name: "note.txt", source }]),
        /the read failed/
    );
});

test("a file that finishes and then reports an error is not counted twice", async (t) => {
    const temp = tempDir();
    t.after(() => temp.cleanup());
    t.after(clearFaults);

    // The bytes all arrived and then the handle complained on the way out.
    // The failure is what the archive goes by, and the completion that follows
    // must not resolve a promise that has already been rejected.
    setFault("createReadStream", () => {
        const reader = new Readable({ read() {} });
        reader.push(Buffer.from("hello"));
        reader.push(null);
        process.nextTick(() => reader.emit("error", fsError("EIO", "the handle complained")));
        return reader;
    });

    const source = path.join(temp.dir, "note.txt");
    fs.writeFileSync(source, "hello");
    await assert.rejects(
        writeZip(path.join(temp.dir, "out.zip"), [{ name: "note.txt", source }]),
        /the handle complained/
    );
});

/* ------------------------------------------------------------------ zip64 */

test("an entry too big for the classic format gets zip64 fields, and still reads", async (t) => {
    const temp = tempDir();
    t.after(() => temp.cleanup());
    t.after(clearFaults);

    const big = path.join(temp.dir, "dragon.psd");
    fs.writeFileSync(big, "a very large document, allegedly");
    const small = path.join(temp.dir, "session.json");
    fs.writeFileSync(small, "{}");
    const target = path.join(temp.dir, "out.zip");

    // Reported as just under 4 GB rather than actually being so: what is being
    // checked is the format written for such a file, and a real one would make
    // this test cost four gigabytes of disk and a minute of CRC.
    setFault("statSync", (p, ...rest) => {
        const stat = fs.statSync(p, ...rest);
        if (p === big) {
            stat.size = 4026531840;
        }
        return stat;
    });

    await writeZip(target, [
        { name: "dragon.psd", source: big },
        { name: "session.json", source: small }
    ]);
    clearFaults();

    // The zip64 end record and its locator both go in, in front of the
    // classic one an old extractor still finds.
    const bytes = fs.readFileSync(target);
    assert.notEqual(bytes.indexOf(Buffer.from([0x50, 0x4b, 0x06, 0x06])), -1, "zip64 end record");
    assert.notEqual(bytes.indexOf(Buffer.from([0x50, 0x4b, 0x06, 0x07])), -1, "zip64 locator");

    const zip = readZip(target);
    assert.deepEqual(zip.entries.map((e) => e.name), ["dragon.psd", "session.json"]);
    assert.equal(zip.entries[0].data.toString("utf8"), "a very large document, allegedly");
    assert.equal(zip.entries[1].data.toString("utf8"), "{}");
});

test("two different failures on one entry settle it once", async (t) => {
    const temp = tempDir();
    t.after(() => temp.cleanup());
    t.after(clearFaults);

    // A volume going away is noticed at both ends: the write stream reports it
    // and the read stream does too, moments apart. Each is wired to the same
    // handler, and the second arrival has nothing left to do.
    let seen = 0;
    const sink = new Writable({
        write(chunk, encoding, callback) {
            if (++seen === 2) {
                process.nextTick(() => sink.emit("error", fsError("EIO", "the volume went away")));
            }
            callback();
        }
    });
    setFault("createReadStream", (...args) => {
        const reader = fs.createReadStream(...args);
        reader.destroy = () => {};
        setTimeout(() => reader.emit("error", fsError("EIO", "and the read failed too")), 5);
        return reader;
    });

    const source = path.join(temp.dir, "note.txt");
    fs.writeFileSync(source, "hello");
    await withFaultAsync("createWriteStream", () => sink, () =>
        assert.rejects(
            writeZip(path.join(temp.dir, "out.zip"), [{ name: "note.txt", source }]),
            /the volume went away/
        )
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
});

test("a file that finishes after the archive gave up on it is ignored", async (t) => {
    const temp = tempDir();
    t.after(() => temp.cleanup());
    t.after(clearFaults);

    // The read is over and the deflater is still flushing when the handle
    // reports a problem -- a window of a tick or two in real life, held open
    // here by standing in for the deflater. The entry then finishes, after the
    // archive has already been rejected, and resolving at that point would
    // write a failed entry into the central directory as a good one.
    let releaseFlush = null;
    setFault("createDeflateRaw", () => {
        return new Transform({
            transform(chunk, encoding, callback) {
                callback(null, chunk);
            },
            flush(callback) {
                releaseFlush = callback;
            }
        });
    });

    let reader = null;
    setFault("createReadStream", (...args) => {
        reader = fs.createReadStream(...args);
        // Tearing the reader down is best effort; here it does nothing, so
        // the rest of the pipeline runs on behind the failure.
        reader.destroy = () => {};
        return reader;
    });

    const source = path.join(temp.dir, "dragon.psd");
    fs.writeFileSync(source, "x".repeat(4096));

    const failed = assert.rejects(
        writeZip(path.join(temp.dir, "out.zip"), [{ name: "dragon.psd", source }]),
        /the handle complained/
    );

    // Wait for the read to be over and the deflater to be sitting in flush.
    while (releaseFlush === null) {
        await new Promise((resolve) => setImmediate(resolve));
    }
    reader.emit("error", fsError("EIO", "the handle complained"));
    await failed;

    releaseFlush();
    await new Promise((resolve) => setTimeout(resolve, 20));
});
