# F_Record

[中文](./README.md)

A lightweight Photoshop plugin that records your drawing process. It grabs a
frame whenever the canvas changes, then stitches them into a video.

**Version**: 4.0 (a full rewrite of 3.x)
**Platform**: Windows
**Photoshop**: 2020 – 2026 (21.x – 27.x)

---

## Install

1. Download and extract the release.
2. Double-click `scripts\install.cmd`. It asks for administrator rights,
   because Photoshop lives under Program Files.

   The installer finds every Photoshop on the machine, reads each one's real
   version from `Photoshop.exe`, and installs the matching build — the `legacy`
   panel for Photoshop 2020, the `modern` one for 2021 and later. No manual
   folder copying.

   **About ffmpeg**: exporting needs it, but it is no longer bundled — the
   binary is 138 MB. The installer looks for one you already have (PATH,
   winget, chocolatey, the usual folders) and uses it if found. Only when
   there is none does it download the latest stable build from
   [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds/releases),
   verify its SHA-256, and place it in `%ProgramData%\F_Record\ffmpeg\`.

   A failed download does not abort the install: the panel and the capture
   plug-in go in as usual, exporting simply will not work, and the installer
   says so. Install ffmpeg yourself and run the installer again. Pass
   `-SkipFfmpeg` to keep it off the network entirely.

   To see what it would do, or to target one installation:

   ```bash
   powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -WhatIf
   ```

   ```bash
   powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -Path "D:\Adobe Photoshop 2024"
   ```

3. Quit Photoshop completely and start it again.
4. Check **Edit ▸ Preferences ▸ Plug-ins**:
   - **Enable Generator** must be ticked (this is what actually does the recording)
   - **Load Extension Panels** must be ticked, under Legacy Extensions

   If you had to tick either one, restart Photoshop again.

5. The panel is at **Window ▸ Extensions (legacy) ▸ F_Record**.

If something is wrong, the doctor script will tell you where it stopped:

```bash
powershell -ExecutionPolicy Bypass -File scripts\doctor.ps1
```

To uninstall, double-click `scripts\uninstall.cmd`. Your recordings live in
`%APPDATA%\F_Record` and are left alone.

---

## Using it

**Switch it on and forget about it.** Recording happens in Photoshop's own
background process, so the panel can be closed or hidden. Turn on "Start
recording when Photoshop opens" in Settings and you never have to touch it.

Each document's frames go in their own folder. **Save As under a new name,
rename, close and reopen, even restart Photoshop — the recording continues into
the same folder.** That was the main thing wrong with 3.x; see below.

The Recordings tab lists everything you have ever recorded, and any of them can
be exported, not just the document currently open.

### Settings worth knowing

| Setting | What it does |
|---|---|
| Frames folder | Defaults to the C: drive; move it somewhere with room. Changing it does not move existing recordings. |
| Resolution / Quality | Higher means a better final video and more disk used. Do not estimate disk usage from a blank canvas — JPEG size depends heavily on how busy the image is. |
| Capture interval | The *shortest* gap between frames. It is a floor only: the real interval adapts to how long capture actually takes, so heavy documents are sampled less often. |
| Idle timeout | Stops the clock after this long without drawing, so time-spent does not count staring at the screen. |

### Export

Two pacings:

- **Even** — every frame gets the same length, as in 3.x.
- **Real time** — uses the actual gaps between strokes, so pauses show (capped at
  2s per frame so it never stalls). This is possible because 4.0 records the
  capture time in each frame's filename.

---

## What changed in 4.0

### It no longer freezes silently while recording

The 3.x freeze was not mysterious. It was four things stacked together, all
fixed here:

1. **Two full layer walks per second, even with recording switched off.** The old
   code called `getDocumentInfo()` every 500ms with the default flags, which
   walks every layer, in ExtendScript, on Photoshop's main thread. It is now
   event-driven, and asks for `imageInfo` only — `layerInfo`, `compInfo` and
   `getTextStyles` are all switched off.
2. **Four document-info passes and two pixmap renders per frame.** It is now
   exactly **one** pixmap call, using `clipToDocumentBounds` so Photoshop crops
   to the canvas itself. That removes the old boundsOnly pre-pass and an entire
   block of padding/extract arithmetic.
3. **`isGettingImage` could stick at true forever.** The old `catch (error) { throw error }`
   sat above the reset, so one throw from the JSON bookkeeping killed recording
   for the rest of the Photoshop session. Every capture now has a 30-second
   watchdog and the flag is cleared in a `finally`.
4. **No throttling at all.** generator-core itself logs
   `WARNING the imageChanged event is expensive`, yet 3.x captured on every
   event. There is now an adaptive throttle: the next interval is the last
   capture's cost × 3, clamped between your configured floor and 15 seconds, and
   a burst of events collapses into one capture plus one trailing one.

Repeated failures **auto-pause recording and say why, on the panel** — instead
of just quietly stopping.

### Save As no longer loses the recording

Photoshop has a long-standing bug: saving under a new name wipes the document's
`generatorSettings`. 3.x kept the recording's identity only there, so a Save As
mid-drawing orphaned the recording and started a second folder.

4.0 writes the identity to three places with different failure modes:

| Where | Survives | Dies on |
|---|---|---|
| the PSD's generatorSettings | close and reopen | Save As |
| an in-memory documentId map | Save As | Photoshop restart |
| an on-disk recovery index | Photoshop restart | document rename |

Any one of them can re-identify the document, and **whenever the PSD copy is
found missing it is written straight back**. The manual patch in 3.x became an
automatic, permanent invariant.

When all three miss — say you restart Photoshop and open an unfamiliar file —
matching sessions are **offered as a choice, never adopted silently**. Picking
wrong corrupts a recording; a spurious new folder only costs disk space.

The storage layout changed to match:

- `session.json` lives **inside** the frames folder, so moving, backing up, or
  copying that folder to another machine loses nothing.
- Frames are named `<sequence>_<timestamp>.jpg`. **There is no separate counter
  file left to drift out of sync** — the frame count is whatever is in the
  directory. In 3.x the count lived in another JSON while the panel
  independently recomputed it with `readDir().length`, and the two disagreed.

### Photoshop 2020 through 2026

One source tree, two builds, because that span crosses three browser engines:

| PS | Year | CEP | Chromium | Node in CEP |
|---|---|---|---|---|
| 21.x | 2020 | CEP 9 | 61 | 8.6 |
| 22.x | 2021 | CEP 10 | 74 | 12.3 |
| 23.x – 25.11 | 2022–2024 | CEP 11 | 88 | 15.9 |
| 25.12+, 26.x, 27.x | 2024–2026 | CEP 12 | 99 | 17.7 |

Consequences:

- **React Spectrum is gone**, replaced by a hand-built UI (Preact plus written
  CSS). Spectrum cannot lay out correctly on Chromium 61/74: flex `gap` needs
  Chrome 84 and `:focus-visible` needs 86. The CSS targets the Chromium 61
  baseline, so the two builds differ only in JavaScript compile target.
- **A Node compatibility layer was added.** 3.x called `fs.rmSync` (Node 14.14+)
  from the panel, whose Node is 8.6 on 2020 and 12.3 on 2021 — export was
  actually broken outright on both. Those APIs are now feature-detected.

### A real channel between the two processes

3.x had the two processes shout at each other through JSON files, each polling
every 500ms. That raced, littered the data directory with temp files the panel
had to sweep up, and — worst — left the panel **unable to tell "not recording"
from "the recording process died"**. Both looked like numbers that stopped moving.

The Generator now serves a loopback-only HTTP endpoint and pushes state over
Server-Sent Events. The panel is a plain client: it renders what it is told and
sends commands, and says so plainly when it cannot connect.

On security: bound to the loopback interface, a random per-run bearer token, and
**every request carrying an `Origin` header is rejected**. A browser cannot omit
that header on a cross-origin request, while the panel talks through Node's http
module (CEP panels have Node enabled) and never sends one — which cleanly shuts
out any web page probing localhost.

### Export rebuilt

- **No longer needs the user to have Node.js installed.** 3.x spawned a worker
  with `spawn("node", ...)`, which only resolves if Node happens to be on PATH.
  Most Photoshop users do not have it, and export failed with a baffling
  "Worker exited". It now runs ffmpeg directly.
- **ffmpeg is no longer bundled.** Shipping a 75 MB ffmpeg.exe made the
  download almost entirely third-party binary for a plugin whose own code is
  419 KB, and it is why this repository grew to 165 MB. The installer now finds
  an existing ffmpeg, and downloads one only when there is none.
- **One ffmpeg invocation** instead of four (main .ts + intro .ts + outro .ts +
  concat).
- **Frames are no longer copied to a temp folder first**, halving disk I/O on
  long recordings.
- Damaged frames — a half-written file from a crash — are skipped rather than
  failing the whole export.

---

## Development

```bash
npm install
npm run build      # builds dist/ (generator + legacy panel + modern panel + scripts)
npm run check      # typecheck and full test suite
```

Tests run under `node --test` and need no Photoshop: session-identity scenarios,
the capture scheduler's state machine, pixmap channel decoding, export planning,
and the compatibility layer's fallbacks. `test/integration.test.mjs` loads the
**actual built generator bundle** and drives it with a mock Photoshop.

```
shared/          protocol, path layout, and the Node compatibility layer
generator/src/   the capture engine, running in Photoshop's Generator process
cep/src/         the panel (Preact) and the export pipeline
scripts/         build, install, uninstall, doctor
test/            unit and integration tests
```
