/**
 * The zip writer.
 *
 * It is read back here by walking the central directory the way every
 * extractor does -- the end record, then each central header, then each
 * local header and its data -- and inflating what was deflated. If this
 * reader is happy, so are Explorer, 7-Zip and the macOS Archive Utility,
 * which all start from the same end record.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { execFileSync } from "node:child_process";

import { crc32, writeZip, zipMethodFor } from "../dist/test/zip.mjs";
import { tempDir } from "./helpers.mjs";

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

test(
    "Windows' own extractor reads what is written",
    { skip: process.platform !== "win32" && "Expand-Archive is Windows only" },
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
