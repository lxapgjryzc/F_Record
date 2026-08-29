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

    /** True when at least one document is open. */
    hasDocument: function () {
        return app.documents.length > 0 ? "yes" : "no";
    }
};
