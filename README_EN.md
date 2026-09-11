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

Each document's frames go in their own folder. **Rename, close and reopen, even
restart Photoshop — the recording continues into the same folder.** That was the
main thing wrong with 3.x; see below. Save As splits it instead: the new file
gets a complete copy of the recording so far, and the file left on disk keeps
the original.

The Recordings tab lists everything you have ever recorded, and any of them can
be exported, not just the document currently open. A recording whose document
was saved to disk can also open that file straight into Photoshop from here
("Open PSD"; if it is already open it just comes to the front), and with
recording on it carries on into the same folder. "Switch" saves and closes the
document in front first, for anyone who keeps one canvas open at a time. The
buttons are icons; hover for the words.

Finished pieces go to the Archive tab with one click, so Recordings only lists
what is still being drawn; draw on an archived piece again and it comes back
on its own. The take in progress is pinned to the top of the list. The
paperclip carries the frames folder next to the PSD (`dragon.psd` gets a
`dragon_frames` beside it) and back again; a recording that has been carried
off is still listed, continued, exported and deleted like any other.

When the folder has grown into hundreds of recordings, "Archive stale (N)" on
the Recordings tab files away every recording with too few frames or created
too long ago in one click (both thresholds live in Settings). The Archive tab
has tick boxes: "Select stale" ticks the same set in one click, and the ticked
rows can be opened in Photoshop all at once, zipped (one zip each, `dragon.psd`
plus `dragon_frames/`, optionally deleted once written), deleted, or deleted
together with their documents. "Clean up…" opens each recording's PSD in
Photoshop in turn so you decide with the picture in front of you, then applies
everything behind one confirmation. Documents go to the Recycle Bin, never
straight to deletion.

### Settings worth knowing

| Setting | What it does |
|---|---|
| Frames folder | Defaults to the C: drive; move it somewhere with room. Changing it does not move existing recordings. |
| Resolution / Quality | Higher means a better final video and more disk used. Do not estimate disk usage from a blank canvas — JPEG size depends heavily on how busy the image is. |
| Capture interval | The *shortest* gap between frames. It is a floor only: the real interval adapts to how long capture actually takes, so heavy documents are sampled less often. |
| Idle timeout | Stops the clock after this long without drawing, so time-spent does not count staring at the screen. |
| Stale recordings | The thresholds behind "Archive stale" and "Select stale": fewer frames than this, or created more than this many days ago. Either alone is enough. Defaults to 20 frames and 30 days; Off ignores that rule. |
| Watermark | Stamps your name or a logo on exported videos, and on the canvas copied to the clipboard. See the export section below. |
| Copied canvas size | How big Copy canvas makes what it puts on the clipboard, by the same rule as the recording resolution. 1080p by default; Original for every pixel. See the copy canvas section below. |
| Language | Follows Photoshop by default; can be set by hand. See the language section below. |
| Check for updates | **Off by default.** When on, asks GitHub about once a day whether a newer version exists. |

### Export

Pick an aspect ratio and a target length. Playback is always even: every frame
gets the same length, as in 3.x.

Both are remembered, so the dialog opens where the last export left it. When
this recording is too short to offer the remembered length — 30s remembered
from an hour-long session, opened on a three-second one — the length falls back
to the original and the aspect ratio is kept.

Asking for a length shorter than the recording speeds it up by dropping frames
in proportion rather than by shortening them, so nothing stutters. The first and
last frames are always kept, so the video still ends on the finished artwork.
Earlier versions also offered a "real time" pacing; it has been removed.

**Watermark**: either a line of text (your name, your handle) or an image (a
logo, a PNG of your signature). Settings holds the kind, the content, the style,
the size and the opacity. Size is a percentage of the video height, so it does
not need retuning when you export at another resolution. The export dialog can
swap the words or the file for one video, or leave the mark off that once,
without touching what is stored.

There are two styles. **Corner** is one mark parked against an edge (or in the
middle); Settings picks which. **Embossed** tiles the mark diagonally across the
whole frame and draws it as a relief — nothing but highlight and shadow, like a
seal pressed into the paper. It has no position to pick, since what it covers is
the picture. Size is then the height of a single mark, and 2–8% suits it.

The relief is the Photoshop move — a neutral-grey layer in a blend mode — with
the blend mode swapped. Photoshop's Overlay returns pure white and pure black
unchanged, and these frames are white paper with near-black lines on them, so an
overlaid emboss would be invisible over almost all of it. An additive blend
(ffmpeg's `grainmerge`) reads on both the paper and the ink. The relief is the
same in every frame, so it is rendered once and frozen: exporting with it costs
no more than exporting without.

Opacity means something different here than it does for a corner badge. The
blend is additive, so the number is how far the mark pushes a pixel, and 100%
of that would move brightness by half the range — a black-and-white stamp
printed over the drawing rather than something pressed into the paper. The
percentage is therefore mapped onto the range this style can actually use:
100% is the anti-theft end, plainly there but still a relief, and 30% is a
whisper. The video is of the drawing; the mark should not compete with it.

The mark goes on last, so it covers the opening and closing stills too. Corner
text is drawn white with a dark outline: frames are flattened onto white, and
plain white lettering would be invisible on exactly the drawings this plug-in is
for. The font is a system one (Microsoft YaHei first on Windows, so Chinese,
Japanese and Korean all render); point `F_RECORD_FONT` at a .ttf/.ttc to choose
another. A PNG keeps its transparency instead of becoming a translucent
rectangle; embossed, a transparent pixel is simply one that is not raised, so a
cut-out logo presses in as its own shape rather than as its bounding box.

### Copy canvas

**Copy canvas**, next to Export on the recording tab, puts the canvas —
watermarked — straight on the clipboard, ready to paste into a chat window. The
recording is not involved: it works with recording off and before a single
frame has been captured, as long as a document is open.

The mark is the one stored in Settings — same style, position, size and opacity
— drawn by the same ffmpeg filters an export uses, so what you paste carries
the same signature the video would.

**Whether it is marked at all is a setting**: "Mark the copied canvas", under
the watermark block. Off copies the picture as it stands and leaves exports
marked as before. It is a setting rather than a question asked each time
because the button's whole point is that it is one click — an export is a
deliberate act that already opens a dialog to be asked in, while copying the
canvas mid-drawing has the same answer nearly every time. The switch is hidden
when the watermark itself is off, since there is then nothing to add.

**It is not the original by default.** The button is for showing someone where
the work stands, and the clipboard holds an uncompressed bitmap: a 6000-pixel
canvas is a hundred-odd megabytes that every chat window then has to swallow.
Only pixels make that smaller — a JPEG quality would change how the picture
looks, not what it costs to paste — so the setting is "Copied canvas size", in
the recording's own resolutions and by the recording's own rule: about the
pixels of a 16:9 frame of that height, a smaller canvas copied as it is, and
1080p exactly the size of a 1080p frame. 1080p is the default; nothing is
visibly lost until it is zoomed into. Choose Original for every pixel. The
scaling happens before the mark goes on, so the mark is sized against what
lands on the clipboard, in the same proportion it has on the video.

Capture is paused for the moment it takes, so the copy is not filed away as a
frame of the recording. Windows goes through PowerShell and macOS through
AppleScript, both of which are already on the machine.

---

## New in 4.1

### The panel speaks ten languages

It follows Photoshop's own UI language by default and falls back to English when
that is something it does not ship. You can also pick one by hand:

English · 简体中文 · 繁體中文 · 日本語 · 한국어 · Deutsch · Français · Español ·
Português (Brasil) · Русский

Regional variants resolve to the closest match: `zh_HK` and `zh_MO` get
traditional Chinese, `zh_SG` gets simplified, `de_AT` / `fr_CA` / `es_MX` fall to
de / fr / es, and `pt_PT` gets pt-BR. Anything unrecognised falls back to English
rather than showing raw keys.

> Everything except English and Chinese is machine-translated, checked only for
> terminology and against the real Photoshop menu names. Corrections are very
> welcome — open an issue, or edit the file under `cep/src/app/locales/`. One
> file per language, and adding a new one touches no other code.

### Update notices (off by default)

When switched on, the plug-in asks GitHub about once a day whether a newer
release exists and shows a strip at the top of the panel if so. Dismissing it
silences that one version; the next release will still say something. Settings
also has a "Check now" button.

**It is off until you turn it on**, and nothing touches the network before then.
Once on, it is a single unauthenticated GET of a public endpoint: nothing about
you, your documents, or your usage is sent.

### Report an Issue

There is a button in the panel footer that opens the GitHub issue tracker.

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
   exactly **one** pixmap call, using `inputRect` + `outputRect` +
   `clipToDocumentBounds` together so Photoshop crops to the canvas and renders
   it at the size asked for. That removes the old boundsOnly pre-pass and an
   entire block of padding/extract arithmetic. All three settings are required:
   with `maxDimension` in the request instead, `clipToDocumentBounds` is
   silently ignored -- which is what caused the padding bug that 4.3.0 fixes.
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

The recovery index is the odd one out: it remembers a *file*, not a document,
and finds whatever sits at that path now. File names get reused far more
readily than drawings do — a new piece saved under an old name, one PSD copied
over another in Explorer — and the path is the same while the drawing is not.
So the index only counts when two things hold: the document was **opened from**
that file (one just saved to the path is a new piece, and its own recording, if
any, is already in the first two places), and the canvas is the size the
recording was last seen at. The id inside the PSD is never overruled by the
index — it travels with the pixels, wherever the file is copied or renamed to.

When all three miss — say you restart Photoshop and open an unfamiliar file —
matching sessions are **offered as a choice, never adopted silently**. Picking
wrong corrupts a recording; a spurious new folder only costs disk space.

### Save As leaves two recordings

Before 4.2, both files pointed at one recording after a Save As: the document
you carried on drawing in was recording, and the file left on disk still held
the same id. Reopen it to try a different direction and two documents wrote
frames into one folder, so the export cut two different drawings together.

Now Save As splits them. **The open document gets a complete copy of everything
drawn so far** and records on its own from there; the file left behind keeps the
original folder, frozen at the moment it was saved away from. Both files have a
full process video, neither is missing its first half. Saving one file under a
new name repeatedly works the same way: every name keeps a recording of its own.

Which side moves is not a free choice. Photoshop only allows `generatorSettings`
to be written to the document that is open, so only that one can be stamped with
a new id on the spot; the file on disk carries the old id and therefore keeps the
original folder. Folders ending up named after their files is a happy accident.

The copy is made with hard links where the filesystem allows, so splitting a
10,000 frame recording costs neither disk space nor a wait — and the two folders
are still independent: delete, rename or export either one and the other is
untouched. Filesystems without hard links (exFAT, network shares) fall back to a
real copy.

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
