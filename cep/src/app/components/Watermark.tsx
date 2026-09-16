/**
 * The watermark controls, shared by the Settings tab and the export dialog.
 *
 * One component rather than two so the two places cannot drift apart: what the
 * dialog offers is exactly the subset of what Settings stores, and `scope`
 * decides which. Settings edits the stored default; the dialog edits a copy
 * that lives for one export, which is why nothing here writes config itself --
 * both callers own their own state and are handed a patch.
 */

import { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import {
    WATERMARK_POSITIONS,
    WATERMARK_STYLES,
    WatermarkKind,
    WatermarkPosition,
    WatermarkSettings,
    WatermarkStyle
} from "../../../../shared/protocol";
import { Translate } from "../i18n";
import { Row, Select } from "./ui";
import { chooseImageFile } from "../psHost";

export interface WatermarkFieldsProps {
    t: Translate;
    value: WatermarkSettings;
    disabled?: boolean;
    /**
     * "all" is the Settings tab. "content" is the export dialog: what to stamp,
     * but not how it is laid out -- position, size and opacity are set once and
     * are not worth a row each in a dialog someone opens to hit Export.
     */
    scope: "all" | "content";
    onChange: (patch: Partial<WatermarkSettings>) => void;
}

/**
 * A corner mark is one badge and wants to be readable; an embossed one is
 * repeated across the frame and wants to be small, so the two styles offer
 * different sizes rather than one list that is wrong at both ends.
 */
const CORNER_SIZES = [4, 6, 8, 12, 20];
const EMBOSS_SIZES = [2, 3, 4, 6, 8];
const OPACITIES = [30, 50, 70, 100];

export function WatermarkFields(props: WatermarkFieldsProps): JSX.Element {
    const t = props.t;
    const mark = props.value;
    const disabled = props.disabled === true;

    // The text box keeps its own copy of what is being typed.
    //
    // In Settings every keystroke goes to the generator and comes back as a
    // fresh config a moment later, so the box cannot be driven by `mark.text`
    // directly: a reply overtaken by the next keystroke would put the older
    // text back, losing letters and throwing the caret to the end.
    //
    // 4.7.0 tried to catch that by remembering the last value sent and
    // ignoring an echo of it -- but the reply that causes the damage is
    // precisely the one that is *not* the newest, so it never matched the
    // guard and was adopted anyway.
    //
    // The rule here is about who is editing rather than about which value:
    // while the field has the caret, what it shows is what was typed, and
    // nothing else may write to it. Anything from outside -- a config reload,
    // the dialog reopening -- lands as soon as the field is left, which is
    // soon enough to see.
    const [draft, setDraft] = useState(mark.text);
    const editing = useRef(false);
    const composing = useRef(false);
    const sent = useRef(mark.text);
    if (!editing.current && mark.text !== draft) {
        sent.current = mark.text;
        setDraft(mark.text);
    }

    /** Hands the text upwards, unless that is what was handed up last. */
    function publish(next: string): void {
        if (next === sent.current) {
            return;
        }
        sent.current = next;
        props.onChange({ text: next });
    }

    // Composition is wired by hand rather than through JSX props.
    //
    // Preact only lowercases an `onXxx` prop when the element has a matching
    // `onxxx` property to prove the event exists, and no element has
    // `oncompositionstart`. An `onCompositionStart` prop would therefore be
    // registered for an event literally named "CompositionStart" and would
    // never fire -- with nothing to see, since the box would keep working and
    // only the IME handling would quietly be missing.
    //
    // `latest` is what keeps that honest: the listeners are attached once, but
    // the callback they reach through it is the current render's, so a
    // composition committed after the style or the size was changed still
    // patches on top of those rather than on top of a stale config.
    const box = useRef<HTMLInputElement | null>(null);
    const latest = useRef(publish);
    latest.current = publish;
    useEffect(() => {
        const input = box.current;
        if (input === null) {
            return undefined;
        }
        const started = () => {
            composing.current = true;
        };
        const ended = () => {
            composing.current = false;
            latest.current(input.value);
        };
        input.addEventListener("compositionstart", started);
        input.addEventListener("compositionend", ended);
        return () => {
            input.removeEventListener("compositionstart", started);
            input.removeEventListener("compositionend", ended);
        };
    }, [mark.kind]);

    return (
        <>
            <Row label={t("watermark")}>
                <Select
                    ariaLabel={t("watermark")}
                    value={mark.kind}
                    disabled={disabled}
                    options={[
                        { value: "off", label: t("watermark.off") },
                        { value: "text", label: t("watermark.text") },
                        { value: "image", label: t("watermark.image") }
                    ]}
                    onChange={(value) => props.onChange({ kind: value as WatermarkKind })}
                />
            </Row>

            {mark.kind === "text" ? (
                <div class="row">
                    <input
                        ref={box}
                        class="path-field"
                        type="text"
                        value={draft}
                        disabled={disabled}
                        maxLength={80}
                        placeholder={t("watermark.text.placeholder")}
                        aria-label={t("watermark.text.label")}
                        onFocus={() => {
                            editing.current = true;
                        }}
                        onBlur={(event) => {
                            editing.current = false;
                            composing.current = false;
                            // A composition abandoned by clicking away still
                            // leaves its letters in the box, so send whatever
                            // is actually there.
                            publish((event.currentTarget as HTMLInputElement).value);
                        }}
                        // An IME reports every stage of a candidate as an input
                        // event: "z", "zh", "zho", "zhong"... Sending those on
                        // would store half a syllable, write it to disk and hand
                        // it back mid-word, which shuts the candidate window. So
                        // the box shows the composition and nobody else hears
                        // about it until it is committed -- see the listeners
                        // above for where that is decided.
                        onInput={(event) => {
                            const next = (event.currentTarget as HTMLInputElement).value;
                            setDraft(next);
                            if (!composing.current) {
                                publish(next);
                            }
                        }}
                    />
                </div>
            ) : null}

            {mark.kind === "image" ? (
                <div class="row">
                    <input
                        class="path-field"
                        type="text"
                        readOnly
                        value={mark.imagePath}
                        title={mark.imagePath}
                        placeholder={t("watermark.image.none")}
                        aria-label={t("watermark.image.label")}
                    />
                    <button
                        type="button"
                        class="icon"
                        disabled={disabled}
                        onClick={() => {
                            const chosen = chooseImageFile(t("watermark.image.choose"), mark.imagePath);
                            if (chosen) {
                                props.onChange({ imagePath: chosen });
                            }
                        }}
                    >
                        {t("watermark.image.choose")}
                    </button>
                </div>
            ) : null}

            {props.scope === "all" && mark.kind !== "off" ? (
                <>
                    <Row label={t("watermark.style")}>
                        <Select
                            ariaLabel={t("watermark.style")}
                            value={mark.style}
                            disabled={disabled}
                            options={WATERMARK_STYLES.map((value) => ({
                                value: value,
                                label: t("watermark.style." + value)
                            }))}
                            onChange={(value) => props.onChange({ style: value as WatermarkStyle })}
                        />
                    </Row>

                    {/* The embossed style fills the frame, so there is no corner to pick. */}
                    {mark.style === "corner" ? (
                        <Row label={t("watermark.position")}>
                            <Select
                                ariaLabel={t("watermark.position")}
                                value={mark.position}
                                disabled={disabled}
                                options={WATERMARK_POSITIONS.map((value) => ({
                                    value: value,
                                    label: t("watermark.position." + value)
                                }))}
                                onChange={(value) =>
                                    props.onChange({ position: value as WatermarkPosition })
                                }
                            />
                        </Row>
                    ) : null}

                    <Row label={t("watermark.size")}>
                        <Select
                            ariaLabel={t("watermark.size")}
                            value={String(mark.sizePercent)}
                            disabled={disabled}
                            options={withStored(
                                mark.style === "emboss" ? EMBOSS_SIZES : CORNER_SIZES,
                                mark.sizePercent
                            ).map((value) => ({
                                value: String(value),
                                label: value + "%"
                            }))}
                            onChange={(value) => props.onChange({ sizePercent: parseInt(value, 10) })}
                        />
                    </Row>
                    <Row label={t("watermark.opacity")}>
                        <Select
                            ariaLabel={t("watermark.opacity")}
                            value={String(mark.opacityPercent)}
                            disabled={disabled}
                            options={withStored(OPACITIES, mark.opacityPercent).map((value) => ({
                                value: String(value),
                                label: value + "%"
                            }))}
                            onChange={(value) => props.onChange({ opacityPercent: parseInt(value, 10) })}
                        />
                    </Row>
                </>
            ) : null}
        </>
    );
}

/** The presets, plus a hand-edited config's own value in its place. */
function withStored(presets: number[], stored: number): number[] {
    if (presets.indexOf(stored) !== -1) {
        return presets;
    }
    return presets.concat([stored]).sort((a, b) => a - b);
}
