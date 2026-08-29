import { JSX } from "preact";
import { useState } from "preact/hooks";
import { Translate, formatDuration } from "../i18n";
import { Dialog, Hint, Row, Select } from "./ui";
import { DEFAULT_FPS, INTRO_SECONDS, OUTRO_SECONDS, TimingMode } from "../../node/export";

export interface ExportChoice {
    /** 0 means "match the canvas". */
    aspectRatio: number;
    /** null keeps the recording's own length. */
    targetDurationSec: number | null;
    timing: TimingMode;
}

export interface ExportDialogProps {
    t: Translate;
    frameCount: number;
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
    const [aspect, setAspect] = useState("0");
    const [duration, setDuration] = useState("0");
    const [timing, setTiming] = useState<TimingMode>("fixed");

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
                                timing: timing
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
            <Row label={t("export.timing")}>
                <Select
                    ariaLabel={t("export.timing")}
                    value={timing}
                    options={[
                        { value: "fixed", label: t("export.timing.fixed") },
                        { value: "realtime", label: t("export.timing.realtime") }
                    ]}
                    onChange={(value) => setTiming(value as TimingMode)}
                />
            </Row>
            <Hint>{t("export.timing.hint")}</Hint>
        </Dialog>
    );
}
