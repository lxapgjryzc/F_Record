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
