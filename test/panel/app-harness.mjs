/**
 * The whole panel, mounted, with everything outside the browser stood in for.
 *
 * App.tsx is tested through its own rendered markup -- real tabs, real
 * buttons, the real Dashboard and Sessions underneath it -- so what these
 * tests assert is what someone using the panel would see. Only the four things
 * that need Photoshop are replaced (see panel-harness), plus the filesystem
 * and the confirm dialog.
 *
 * There are several App test files rather than one because the file is large
 * and the areas are independent; coverage adds up across them.
 */

import { h } from "preact";

import { installDom, mount, rerender } from "./dom.mjs";
import { panelState, stubFs, stubPanel } from "./panel-harness.mjs";

/**
 * Stands the panel up. Call once per test file, at the top: the module stubs
 * have to be in place before app.mjs is imported.
 */
export async function bootPanel(mock) {
    const dom = installDom();
    const panel = stubPanel(mock);
    const disk = stubFs(mock);
    const { App } = await import("../../dist/modules/app.mjs");
    const { createTranslate } = await import("../../dist/modules/i18n.mjs");

    let container = null;

    /**
     * Mounts a fresh panel and, unless told otherwise, lets the generator
     * connect and push it a state.
     *
     * The previous panel is taken down first, so its bridge listener and its
     * window listeners do not answer for this one.
     */
    async function openPanel(state = panelState(), options = {}) {
        if (container) {
            rerender(container, null);
            container.remove();
        }
        panel.reset();
        panel.bridge.sessions = options.sessions || [];
        dom.asked.length = 0;
        dom.answerConfirm(true);
        disk.unlinked.length = 0;
        disk.broken = null;
        disk.files = new Set(options.files || []);
        disk.folders = new Map(Object.entries(options.folders || {}));
        // After the reset and before the mount, for the handful of host calls
        // the panel makes on its way up.
        Object.assign(panel.host, options.host || {});

        container = mount(dom, h(App, {}));
        await dom.flush();
        if (state) {
            panel.bridge.connect(state);
            await dom.flush();
        }
        return container;
    }

    return { dom, panel, disk, openPanel, t: createTranslate("en") };
}
