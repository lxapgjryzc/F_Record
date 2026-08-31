import { JSX } from "preact";
import { Config, LANGUAGES, Language, Resolution } from "../../../../shared/protocol";
import { Translate } from "../i18n";
import { LOCALE_NAMES, Locale } from "../locales";
import { Hint, Row, Select, Switch } from "./ui";
import { chooseFolder } from "../psHost";
import { describeNodeCompat } from "../../../../shared/compat";

export interface SettingsProps {
    t: Translate;
    config: Config | null;
    disabled: boolean;
    onPatch: (patch: Partial<Config>) => void;
    /** Null while a check is running, so the button can show progress. */
    updateBusy: boolean;
    onCheckUpdates: () => void;
    /** The generator process's Node, over the bridge. Null when disconnected. */
    generatorNode: string | null;
}

const RESOLUTIONS: Resolution[] = ["360", "720", "1080", "1440", "2160"];

export function Settings(props: SettingsProps): JSX.Element {
    const t = props.t;
    const config = props.config;

    if (!config) {
        return <div class="empty">{t("status.connecting")}</div>;
    }

    return (
        <div>
            <div class="section">
                <div class="row">
                    <span class="row-label">{t("settings.folder")}</span>
                </div>
                <div class="row">
                    <input
                        class="path-field"
                        type="text"
                        readOnly
                        value={config.processImageFolderPath}
                        title={config.processImageFolderPath}
                        aria-label={t("settings.folder")}
                    />
                    <button
                        type="button"
                        class="icon"
                        disabled={props.disabled}
                        onClick={() => {
                            const chosen = chooseFolder(t("settings.folder.choose"), config.processImageFolderPath);
                            if (chosen) {
                                props.onPatch({ processImageFolderPath: chosen });
                            }
                        }}
                    >
                        {t("settings.folder.choose")}
                    </button>
                </div>
                <Hint>{t("settings.folder.hint")}</Hint>
            </div>

            <div class="section">
                <Row label={t("settings.resolution")}>
                    <Select
                        ariaLabel={t("settings.resolution")}
                        value={config.resolution}
                        disabled={props.disabled}
                        options={RESOLUTIONS.map((value) => ({ value: value, label: value + "p" }))}
                        onChange={(value) => props.onPatch({ resolution: value as Resolution })}
                    />
                </Row>

                <Row label={t("settings.quality")}>
                    <Select
                        ariaLabel={t("settings.quality")}
                        value={String(nearestQuality(config.quality))}
                        disabled={props.disabled}
                        options={[
                            { value: "40", label: t("settings.quality.low") },
                            { value: "70", label: t("settings.quality.medium") },
                            { value: "90", label: t("settings.quality.high") }
                        ]}
                        onChange={(value) => props.onPatch({ quality: parseInt(value, 10) })}
                    />
                </Row>

                <Row label={t("settings.interval")}>
                    <Select
                        ariaLabel={t("settings.interval")}
                        value={String(config.minIntervalMs)}
                        disabled={props.disabled}
                        options={[
                            { value: "800", label: "0.8" + t("unit.secondShort") },
                            { value: "1500", label: "1.5" + t("unit.secondShort") },
                            { value: "3000", label: "3" + t("unit.secondShort") },
                            { value: "6000", label: "6" + t("unit.secondShort") }
                        ]}
                        onChange={(value) => props.onPatch({ minIntervalMs: parseInt(value, 10) })}
                    />
                </Row>
                <Hint>{t("settings.interval.hint")}</Hint>

                <Row label={t("settings.idle")}>
                    <Select
                        ariaLabel={t("settings.idle")}
                        value={String(config.idleTimeoutMinutes)}
                        disabled={props.disabled}
                        options={[
                            { value: "1", label: "1 " + t("unit.minute") },
                            { value: "5", label: "5 " + t("unit.minute") },
                            { value: "10", label: "10 " + t("unit.minute") },
                            { value: "30", label: "30 " + t("unit.minute") },
                            { value: "0", label: t("settings.idle.off") }
                        ]}
                        onChange={(value) => props.onPatch({ idleTimeoutMinutes: parseInt(value, 10) })}
                    />
                </Row>
                <Hint>{t("settings.idle.hint")}</Hint>
            </div>

            <div class="section">
                <div class="row">
                    <Switch
                        checked={config.autoStart}
                        disabled={props.disabled}
                        label={t("settings.autoStart")}
                        onChange={(next) => props.onPatch({ autoStart: next })}
                    />
                </div>
                <Hint>{t("settings.autoStart.hint")}</Hint>

                <div class="row">
                    <Switch
                        checked={config.autoStartNewDocuments}
                        disabled={props.disabled}
                        label={t("settings.autoNew")}
                        onChange={(next) => props.onPatch({ autoStartNewDocuments: next })}
                    />
                </div>
                <Hint>{t("settings.autoNew.hint")}</Hint>
            </div>

            <div class="section">
                <Row label={t("settings.language")}>
                    <Select
                        ariaLabel={t("settings.language")}
                        value={config.language}
                        disabled={props.disabled}
                        // Each language is listed in itself -- someone who has
                        // landed in the wrong one still has to find their way out.
                        options={LANGUAGES.map((code) => ({
                            value: code,
                            label:
                                code === "auto"
                                    ? t("settings.language.auto")
                                    : LOCALE_NAMES[code as Locale]
                        }))}
                        onChange={(value) => props.onPatch({ language: value as Language })}
                    />
                </Row>
            </div>

            <div class="section">
                <div class="row">
                    <Switch
                        checked={config.checkForUpdates}
                        disabled={props.disabled}
                        label={t("update.setting")}
                        onChange={(next) => props.onPatch({ checkForUpdates: next })}
                    />
                </div>
                <Hint>{t("update.setting.hint")}</Hint>
                {config.checkForUpdates ? (
                    <div class="row">
                        <button
                            type="button"
                            class="secondary"
                            disabled={props.disabled || props.updateBusy}
                            onClick={props.onCheckUpdates}
                        >
                            {props.updateBusy ? t("update.checking") : t("update.checkNow")}
                        </button>
                    </div>
                ) : null}
            </div>

            {/*
              * Both halves, because they are different Node builds: the panel
              * gets CEP's (8.6 on Photoshop 2020) and the generator gets its
              * own. An export bug that only happens on old Photoshop is almost
              * always one of these fallbacks, and this is the line to quote.
              * "Panel" and "Generator" stay untranslated -- Generator is what
              * Photoshop calls it in every language.
              */}
            <div class="section">
                <div class="row">
                    <span class="row-label">{t("settings.runtime")}</span>
                </div>
                <Hint>{"Panel · " + describeNodeCompat()}</Hint>
                <Hint>{"Generator · " + (props.generatorNode || "—")}</Hint>
                <Hint>{t("settings.runtime.hint")}</Hint>
            </div>
        </div>
    );
}

/** Maps an arbitrary stored quality onto the three offered presets. */
function nearestQuality(quality: number): number {
    const presets = [40, 70, 90];
    let best = presets[0];
    for (let i = 1; i < presets.length; i++) {
        if (Math.abs(presets[i] - quality) < Math.abs(best - quality)) {
            best = presets[i];
        }
    }
    return best;
}
