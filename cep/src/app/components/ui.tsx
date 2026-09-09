/** Small presentational primitives shared by the three tabs. */

import { ComponentChildren, JSX } from "preact";

/**
 * GitHub's mark, inlined as a path.
 *
 * Inline rather than an <img>: the panel is loaded from the local filesystem
 * and a strict CEP page has no business fetching a remote asset just to draw a
 * button. `currentColor` makes it follow the panel text colour, so it works in
 * all four of Photoshop's UI brightness levels without a second asset.
 */
export function GitHubIcon(props: { size?: number }): JSX.Element {
    const size = props.size || 14;
    return (
        <svg
            class="gh-icon"
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="currentColor"
            aria-hidden="true"
            focusable="false"
        >
            <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
        </svg>
    );
}

/**
 * The pictures on the recording rows.
 *
 * Outlines in the style of Feather (MIT), redrawn here so the panel has no
 * runtime asset to fetch. Stroked rather than filled: a 16px line icon stays
 * legible on every Photoshop UI brightness, and `currentColor` lets a button
 * simply set a colour -- red for delete, the accent for a toggle that is on.
 * The button that hosts one carries the spoken name; the drawing itself is
 * decorative.
 */
export type GlyphName =
    | "film"
    | "file"
    | "folder"
    | "trash"
    | "enter"
    | "archive"
    | "unarchive"
    | "paperclip"
    | "refresh"
    | "package";

const GLYPH_PATHS: Record<GlyphName, string> = {
    // A strip of film: what Export produces.
    film:
        "M4 3h16a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" +
        "M7 3v18M17 3v18M3 12h18M3 7.5h4M3 16.5h4M17 7.5h4M17 16.5h4",
    // A sheet with a folded corner: the document itself.
    file: "M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM13 2v7h7",
    folder: "M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z",
    trash:
        "M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" +
        "M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M10 11v6M14 11v6",
    // An arrow going in through a doorway: switch to this one.
    enter: "M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3",
    // A box with its lid on.
    archive: "M21 8v13H3V8M1 3h22v5H1zM10 12h4",
    // The same box, something coming back out of it.
    unarchive: "M21 8v13H3V8M1 3h22v5H1zM12 19v-7M9 15l3-3 3 3",
    // Attached to the document.
    paperclip:
        "M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66" +
        "l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48",
    refresh: "M23 4v6h-6M1 20v-6h6M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15",
    // A sealed box: the recording packed into a zip.
    package:
        "M16.5 9.4l-9-5.19M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8" +
        "a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16zM3.27 6.96L12 12.01l8.73-5.05M12 22.08V12"
};

export function Glyph(props: { name: GlyphName; size?: number }): JSX.Element {
    const size = props.size || 16;
    return (
        <svg
            class="glyph"
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
            focusable="false"
        >
            <path d={GLYPH_PATHS[props.name]} />
        </svg>
    );
}

/**
 * A square button that is nothing but a Glyph.
 *
 * `label` is what a screen reader says and the first line of the tooltip,
 * so it is the same translated string the old text button used to show. The
 * tooltip can carry more -- the open-document button appends the file's full
 * path, as the text version did -- but never less: a picture with no name is
 * a guess, and guessing is what the icons are meant to end.
 *
 * `active` marks a toggle that is on (the paperclip when the frames already
 * sit beside the document); `danger` is for delete.
 */
export function GlyphButton(props: {
    glyph: GlyphName;
    label: string;
    detail?: string;
    danger?: boolean;
    active?: boolean;
    disabled?: boolean;
    onClick: () => void;
}): JSX.Element {
    let className = "glyph-button";
    if (props.danger) {
        className += " danger";
    }
    if (props.active) {
        className += " active";
    }
    return (
        <button
            type="button"
            class={className}
            title={props.detail ? props.label + "\n" + props.detail : props.label}
            aria-label={props.label}
            aria-pressed={props.active === undefined ? undefined : props.active ? "true" : "false"}
            disabled={props.disabled}
            onClick={props.onClick}
        >
            <Glyph name={props.glyph} />
        </button>
    );
}

/**
 * "Report an Issue" -- the GitHub mark plus a label.
 *
 * Deliberately a button rather than an anchor: CEP panels cannot navigate, so
 * the click has to go through openURLInDefaultBrowser. An <a href> would either
 * do nothing or replace the panel with the page.
 */
export function IssueButton(props: { label: string; title?: string; onClick: () => void }): JSX.Element {
    return (
        <button type="button" class="link with-icon" title={props.title} onClick={props.onClick}>
            <GitHubIcon />
            <span>{props.label}</span>
        </button>
    );
}

export function Row(props: {
    label: ComponentChildren;
    children: ComponentChildren;
}): JSX.Element {
    return (
        <div class="row">
            <span class="row-label">{props.label}</span>
            <span class="row-value">{props.children}</span>
        </div>
    );
}

export function Hint(props: { children: ComponentChildren }): JSX.Element {
    return <p class="hint">{props.children}</p>;
}

/**
 * A tick box with no label of its own: the row it sits on is the label,
 * and `ariaLabel` carries the words for a screen reader.
 */
export function Checkbox(props: {
    checked: boolean;
    ariaLabel: string;
    disabled?: boolean;
    onChange: (next: boolean) => void;
}): JSX.Element {
    return (
        <input
            type="checkbox"
            class="tick"
            checked={props.checked}
            aria-label={props.ariaLabel}
            disabled={props.disabled}
            onChange={(event) => props.onChange((event.currentTarget as HTMLInputElement).checked)}
        />
    );
}

export function Switch(props: {
    checked: boolean;
    label: ComponentChildren;
    disabled?: boolean;
    onChange: (next: boolean) => void;
}): JSX.Element {
    return (
        <button
            type="button"
            class={"switch" + (props.checked ? " on" : "")}
            role="switch"
            aria-checked={props.checked ? "true" : "false"}
            disabled={props.disabled}
            onClick={() => props.onChange(!props.checked)}
        >
            <span class="switch-track">
                <span class="switch-knob" />
            </span>
            <span>{props.label}</span>
        </button>
    );
}

export interface Option {
    value: string;
    label: string;
}

export function Select(props: {
    value: string;
    options: Option[];
    ariaLabel: string;
    disabled?: boolean;
    narrow?: boolean;
    onChange: (next: string) => void;
}): JSX.Element {
    return (
        <select
            class={props.narrow === false ? "" : "control-narrow"}
            aria-label={props.ariaLabel}
            value={props.value}
            disabled={props.disabled}
            onChange={(event) => props.onChange((event.currentTarget as HTMLSelectElement).value)}
        >
            {props.options.map((option) => (
                <option key={option.value} value={option.value}>
                    {option.label}
                </option>
            ))}
        </select>
    );
}

export function Banner(props: {
    tone: "info" | "warn" | "error";
    title: ComponentChildren;
    body?: ComponentChildren;
    actions?: ComponentChildren;
}): JSX.Element {
    return (
        <div class={"banner " + props.tone}>
            <span class="banner-title">{props.title}</span>
            {props.body ? <span class="banner-body">{props.body}</span> : null}
            {props.actions ? <div class="banner-actions">{props.actions}</div> : null}
        </div>
    );
}

export function ProgressBar(props: { label: string; percent: number }): JSX.Element {
    const percent = Math.max(0, Math.min(100, props.percent));
    return (
        <div class="progress">
            <div class="progress-label">
                <span>{props.label}</span>
                <span>{percent}%</span>
            </div>
            <div class="progress-track">
                <div class="progress-fill" style={{ width: percent + "%" }} />
            </div>
        </div>
    );
}

export function Dialog(props: {
    title: ComponentChildren;
    children: ComponentChildren;
    actions: ComponentChildren;
    onDismiss: () => void;
}): JSX.Element {
    return (
        <div
            class="dialog-scrim"
            onClick={(event) => {
                if (event.target === event.currentTarget) {
                    props.onDismiss();
                }
            }}
        >
            <div class="dialog" role="dialog" aria-modal="true">
                <div class="dialog-title">{props.title}</div>
                {props.children}
                <div class="dialog-actions">{props.actions}</div>
            </div>
        </div>
    );
}

export interface Toast {
    id: number;
    tone: "info" | "positive" | "negative";
    text: string;
    actionLabel?: string;
    onAction?: () => void;
}

export function Toasts(props: {
    toasts: Toast[];
    onDismiss: (id: number) => void;
    dismissLabel: string;
}): JSX.Element | null {
    if (props.toasts.length === 0) {
        return null;
    }
    return (
        <div class="toasts">
            {props.toasts.map((toast) => (
                <div key={toast.id} class={"toast " + toast.tone}>
                    <span class="toast-text">{toast.text}</span>
                    {toast.actionLabel ? (
                        <button
                            type="button"
                            class="link"
                            onClick={() => {
                                if (toast.onAction) {
                                    toast.onAction();
                                }
                                props.onDismiss(toast.id);
                            }}
                        >
                            {toast.actionLabel}
                        </button>
                    ) : (
                        // Errors never auto-clear (see pushToast), so without
                        // this they would stay on screen with no way to close
                        // them. Give every actionless toast an explicit ✕.
                        <button
                            type="button"
                            class="toast-close"
                            title={props.dismissLabel}
                            aria-label={props.dismissLabel}
                            onClick={() => props.onDismiss(toast.id)}
                        >
                            ✕
                        </button>
                    )}
                </div>
            ))}
        </div>
    );
}
