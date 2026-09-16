/*
 * ExtendScript half of the panel.
 *
 * Kept as small as possible: everything that can be done from Node in the
 * panel, or from the Generator plugin, is done there. This exists only for the
 * things that genuinely need Photoshop's scripting DOM.
 *
 * ExtendScript is ES3 -- no let/const, no arrow functions, no JSON in older
 * hosts -- and this file ships unmodified to Photoshop 2020 through 2026, so
 * it must stay within that dialect.
 */

if (typeof $ === "undefined") {
    $ = {};
}

$.f_record = {
    /**
     * Writes a full-quality still of the finished artwork, used as the
     * recording's opening hold and closing fade.
     *
     * Returns "ok", "no-document", or "error:<message>" rather than throwing,
     * because evalScript surfaces a thrown error only as the opaque string
     * EvalScript_ErrMessage.
     */
    generateFinalJPG: function (encodedPath) {
        var target = decodeURIComponent(encodedPath);
        if (app.documents.length === 0) {
            return "no-document";
        }

        var previousDialogs = app.displayDialogs;
        app.displayDialogs = DialogModes.NO;
        try {
            var options = new ExportOptionsSaveForWeb();
            options.format = SaveDocumentType.JPEG;
            options.optimized = true;
            options.quality = 100;
            app.activeDocument.exportDocument(new File(target), ExportType.SAVEFORWEB, options);
            return "ok";
        } catch (exportError) {
            // Save For Web refuses documents beyond a certain size. Fall back to
            // a flattened duplicate, which has no such limit. The duplicate is
            // always closed, so the user's document is never modified.
            var duplicate = null;
            try {
                duplicate = app.activeDocument.duplicate();
                duplicate.flatten();
                var jpegOptions = new JPEGSaveOptions();
                jpegOptions.quality = 12;
                jpegOptions.embedColorProfile = true;
                duplicate.saveAs(new File(target), jpegOptions, true, Extension.LOWERCASE);
                return "ok";
            } catch (fallbackError) {
                return "error:" + fallbackError.toString();
            } finally {
                if (duplicate !== null) {
                    try {
                        duplicate.close(SaveOptions.DONOTSAVECHANGES);
                    } catch (closeError) {
                        // Leaving the duplicate open is bad, but throwing here
                        // would mask the real error above.
                    }
                }
            }
        } finally {
            app.displayDialogs = previousDialogs;
        }
    },

    /**
     * Opens a file in this Photoshop, or brings it to the front when it is
     * already open.
     *
     * Returns "ok", "missing" when the file is no longer where the recording
     * last saw it, or "error:<message>". Photoshop's own dialogs -- missing
     * fonts, a colour profile mismatch -- are deliberately left enabled: this
     * is the user opening a file, and they should see whatever File ▸ Open
     * would have shown them.
     */
    openDocument: function (encodedPath) {
        var outcome = $.f_record.openForReview(encodedPath);
        return outcome === "opened" || outcome === "already" ? "ok" : outcome;
    },

    /**
     * openDocument, but says which it did: "opened" the file, or found it
     * "already" open and brought it forward; otherwise "missing" or
     * "error:<message>". The clean-up review closes behind itself only what
     * it opened, so it needs to know.
     */
    openForReview: function (encodedPath) {
        var target = decodeURIComponent(encodedPath);
        var file = new File(target);
        if (!file.exists) {
            return "missing";
        }
        try {
            var open = $.f_record.findOpenDocument(file.fsName);
            if (open !== null) {
                app.activeDocument = open;
                return "already";
            }
            app.open(file);
            return "opened";
        } catch (openError) {
            return "error:" + openError.toString();
        }
    },

    /**
     * Closes the document at encodedPath if it is open. With discard the
     * changes go unsaved -- the file is about to be deleted, so there is
     * nothing to keep them for -- and otherwise Photoshop asks what to do
     * with them, as closing from the menu would. Returns "ok", "not-open",
     * "cancelled" when the user backed out of that question, or
     * "error:<message>".
     */
    closeDocument: function (encodedPath, discard) {
        var target = decodeURIComponent(encodedPath);
        try {
            var doc = $.f_record.findOpenDocument(target);
            if (doc === null) {
                return "not-open";
            }
            doc.close(discard || doc.saved ? SaveOptions.DONOTSAVECHANGES : SaveOptions.PROMPTTOSAVECHANGES);
            return "ok";
        } catch (closeError) {
            if ($.f_record.isUserCancel(closeError)) {
                return "cancelled";
            }
            return "error:" + closeError.toString();
        }
    },

    /** The open document saved at this path, or null. */
    findOpenDocument: function (fsPath) {
        var wanted = $.f_record.pathKey(fsPath);
        for (var i = 0; i < app.documents.length; i++) {
            var doc = app.documents[i];
            var openPath;
            try {
                // A document that has never been saved has no fullName
                // and throws here; it cannot be the one we are after.
                openPath = doc.fullName.fsName;
            } catch (unsaved) {
                continue;
            }
            if ($.f_record.pathKey(openPath) === wanted) {
                return doc;
            }
        }
        return null;
    },

    /** Path comparison key: Windows paths differ only by case and slash direction. */
    pathKey: function (p) {
        return String(p).replace(/\//g, "\\").toLowerCase();
    },

    /**
     * Saves and closes the document in front, then opens -- or brings
     * forward -- the one at encodedPath. The "switch" for an artist who keeps
     * one canvas open at a time and wants the next piece up in one click.
     *
     * Returns "ok", "missing" when the target file is gone, "cancelled" when
     * the user backed out of a dialog, or "error:<message>". Asking to switch
     * to the document already in front does nothing and reports "ok".
     *
     * Save behaves exactly like File ▸ Save: Photoshop's own dialogs stay
     * enabled, so a document that has never been saved gets Save As, and a
     * format with questions (Maximize Compatibility, TIFF options) gets them.
     * Cancelling any of those leaves the document open and untouched, and
     * nothing else happens -- the target is not opened either, because the
     * user has just said "wait".
     */
    switchToDocument: function (encodedPath) {
        var target = decodeURIComponent(encodedPath);
        var file = new File(target);
        if (!file.exists) {
            return "missing";
        }
        try {
            if (app.documents.length > 0) {
                var front = app.activeDocument;
                if ($.f_record.documentPathKey(front) === $.f_record.pathKey(file.fsName)) {
                    return "ok";
                }
                if (!front.saved) {
                    try {
                        $.f_record.saveLikeMenu(front);
                    } catch (saveError) {
                        if ($.f_record.isUserCancel(saveError)) {
                            return "cancelled";
                        }
                        return "error:" + saveError.toString();
                    }
                }
                // Still unsaved after a save that did not throw: the user
                // picked a format that cannot hold the document (a JPEG of a
                // layered file is written as a copy) and the layers exist
                // nowhere on disk. Let Photoshop ask before they are lost.
                try {
                    front.close(front.saved ? SaveOptions.DONOTSAVECHANGES : SaveOptions.PROMPTTOSAVECHANGES);
                } catch (closeError) {
                    if ($.f_record.isUserCancel(closeError)) {
                        return "cancelled";
                    }
                    return "error:" + closeError.toString();
                }
            }
            return $.f_record.openDocument(encodedPath);
        } catch (switchError) {
            return "error:" + switchError.toString();
        }
    },

    /**
     * File ▸ Save, exactly as the menu does it.
     *
     * Document.save() refuses a document that has never been saved -- it
     * throws "The document has not yet been saved" instead of asking where
     * to put it -- so an untitled document goes through the Action Manager,
     * which behaves like Ctrl+S: the Save As dialog comes up, and cancelling
     * it throws the user-cancel error the caller is watching for. A document
     * with a file keeps the plain save.
     */
    saveLikeMenu: function (doc) {
        if ($.f_record.documentPathKey(doc) !== null) {
            doc.save();
            return;
        }
        app.activeDocument = doc;
        executeAction(charIDToTypeID("save"), new ActionDescriptor(), DialogModes.ALL);
    },

    /** pathKey of the file a document was saved to, or null for one never saved. */
    documentPathKey: function (doc) {
        try {
            return $.f_record.pathKey(doc.fullName.fsName);
        } catch (unsaved) {
            return null;
        }
    },

    /**
     * True for the error Photoshop throws when the user cancels a dialog.
     * 8007 is its number; the text is checked too because not every host
     * version attaches the number.
     */
    isUserCancel: function (error) {
        return (error && error.number === 8007) || /cancel/i.test(String(error));
    },

    /** True when at least one document is open. */
    hasDocument: function () {
        return app.documents.length > 0 ? "yes" : "no";
    }
};
