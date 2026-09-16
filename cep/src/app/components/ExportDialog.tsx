import { JSX } from "preact";
import { useState } from "preact/hooks";
import {
    ExportDefaults,
    WatermarkSettings,
    normalizeExportDefaults,
    normalizeWatermark
} from "../../../../shared/protocol";
import { Translate, formatDuration } from "../i18n";
import { Dialog, Hint, Row, Select } from "./ui";
import { WatermarkFields } from "./Watermark";
import { DEFAULT_FPS, INTRO_SECONDS, OUTRO_SECONDS } from "../../node/export";

export interface ExportChoice {
    /** 0 means "match the canvas". */
    aspectRatio: number;
    /** null keeps the recording's own length. */
    targetDurationSec: number | null;
    /** For this export only; the stored default is left alone. */
    watermark: WatermarkSettings;
}

export interface ExportDialogProps {
    t: Translate;
    frameCount: number;
    /** The configured default, which this dialog may override for one export. */
    watermark: WatermarkSettings;
    /** Where to open: what the last export was confirmed with. */
    defaults: ExportDefaults;
    onConfirm: (choice: ExportChoice) => void;
    onCancel: () => void;
}

const ASPECTS: Array<{ value: string; label: string }> = [
    { value: "0", label: "" }, // filled in below with the translated label
    { value: "1.7778", label: "16:9" },
    { value: "1.3333", label: "4:3" },
    { value: "1", label: "1:1" },
    { value: "0.75", label: "3:4" },
    { value: "0.5625", label: "9:16" }
];

export function ExportDialog(props: ExportDialogProps): JSX.Element {
    const t = props.t;

    // What the recording lasts at one frame per output frame, plus bookends.
    const naturalSeconds = Math.floor(props.frameCount / DEFAULT_FPS) + INTRO_SECONDS + OUTRO_SECONDS;

    const durationOptions: Array<{ value: string; label: string }> = [];
    const presets = [15, 30, 60, 180];
    for (let i = 0; i < presets.length; i++) {
        if (presets[i] < naturalSeconds) {
            durationOptions.push({ value: String(presets[i]), label: presets[i] + t("unit.secondShort") });
        }
    }
    durationOptions.push({
        value: "0",
        label: t("export.duration.original", formatDuration(naturalSeconds, t))
    });

    const aspectOptions = ASPECTS.map((option) =>
        option.value === "0" ? { value: "0", label: t("export.aspect.canvas") } : option
    );

    // Reopened where it was left. Both are checked against the options this
    // recording actually offers rather than trusted: which durations appear
    // depends on how long *this* recording is, so "30s" remembered from an
    // hour-long session is not on the menu for a twenty-second one, and a
    // Select pointed at a value it has no option for shows an empty box.
    const remembered = normalizeExportDefaults(props.defaults);
    const [aspect, setAspect] = useState(() =>
        pick(aspectOptions, String(remembered.aspectRatio))
    );
    const [duration, setDuration] = useState(() =>
        pick(durationOptions, String(remembered.targetDurationSec === null ? 0 : remembered.targetDurationSec))
    );
    // Seeded from the stored default and edited freely from here on: this copy
    // never goes back to config, so a one-off signature stays a one-off.
    const [watermark, setWatermark] = useState<WatermarkSettings>(() =>
        normalizeWatermark(props.watermark)
    );

    return (
        <Dialog
            title={t("export.title")}
            onDismiss={props.onCancel}
            actions={
                <>
                    <button type="button" onClick={props.onCancel}>
                        {t("export.cancel")}
                    </button>
                    <button
                        type="button"
                        class="primary"
                        onClick={() =>
                            props.onConfirm({
                                aspectRatio: parseFloat(aspect),
                                targetDurationSec: duration === "0" ? null : parseInt(duration, 10),
                                // Normalised here rather than on every
                                // keystroke: half-typed text should not keep
                                // switching the mark off and back on.
                                watermark: normalizeWatermark(watermark)
                            })
                        }
                    >
                        {t("export.confirm")}
                    </button>
                </>
            }
        >
            <Row label={t("export.aspect")}>
                <Select
                    ariaLabel={t("export.aspect")}
                    value={aspect}
                    options={aspectOptions}
                    onChange={setAspect}
                />
            </Row>
            <Row label={t("export.duration")}>
                <Select
                    ariaLabel={t("export.duration")}
                    value={duration}
                    options={durationOptions}
                    onChange={setDuration}
                />
            </Row>
            <WatermarkFields
                t={t}
                value={watermark}
                scope="content"
                onChange={(patch) =>
                    setWatermark((current) => Object.assign({}, current, patch) as WatermarkSettings)
                }
            />
            {watermark.kind === "off" ? null : <Hint>{t("watermark.dialog.hint")}</Hint>}
        </Dialog>
    );
}

/**
 * `wanted` if this recording offers it, and "0" otherwise.
 *
 * "0" is the neutral choice in both lists -- match the canvas, keep the
 * original length -- and is the one option always present in each.
 */
function pick(options: Array<{ value: string }>, wanted: string): string {
    for (let i = 0; i < options.length; i++) {
        if (options[i].value === wanted) {
            return wanted;
        }
    }
    return "0";
}
