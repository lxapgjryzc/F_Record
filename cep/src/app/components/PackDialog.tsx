import { JSX } from "preact";
import { useState } from "preact/hooks";
import { Translate } from "../i18n";
import { Dialog, Hint, Switch } from "./ui";

export interface PackDialogProps {
    t: Translate;
    count: number;
    folder: string;
    onConfirm: (deleteAfter: boolean) => void;
    onCancel: () => void;
}

/**
 * The last word before recordings are zipped: how many, where to, and
 * whether each is to be deleted -- document to the Recycle Bin, frames for
 * good -- once its zip is safely written. Off by default: packing is the
 * safe half, and the delete has to be asked for.
 */
export function PackDialog(props: PackDialogProps): JSX.Element {
    const t = props.t;
    const [deleteAfter, setDeleteAfter] = useState(false);

    return (
        <Dialog
            title={t("pack.title")}
            onDismiss={props.onCancel}
            actions={
                <>
                    <button type="button" onClick={props.onCancel}>
                        {t("export.cancel")}
                    </button>
                    <button type="button" class="primary" onClick={() => props.onConfirm(deleteAfter)}>
                        {t("pack.confirm")}
                    </button>
                </>
            }
        >
            <p class="dialog-text">{t("pack.body", props.count)}</p>
            <p class="dialog-text path" title={props.folder}>
                {props.folder}
            </p>
            <div class="row">
                <Switch checked={deleteAfter} label={t("pack.deleteAfter")} onChange={setDeleteAfter} />
            </div>
            <Hint>{t("pack.deleteAfter.hint")}</Hint>
        </Dialog>
    );
}
