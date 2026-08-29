/** Small presentational primitives shared by the three tabs. */

import { ComponentChildren, JSX } from "preact";

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

export function Toasts(props: { toasts: Toast[]; onDismiss: (id: number) => void }): JSX.Element | null {
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
                    ) : null}
                </div>
            ))}
        </div>
    );
}
