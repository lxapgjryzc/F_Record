import { render } from "preact";
import { installBufferShims } from "../../../shared/compat";
import { installPolyfills } from "./polyfills";
import { installCssVariableFallback } from "./cssVars";
import { readPanelStylesheet } from "./psHost";
import { App } from "./App";
import "./styles.css";

// The oldest hosts first. Everything imported above only defines things;
// nothing calls Buffer.from, Object.assign or reads a key until the panel
// renders, which is after these have filled the gaps Chromium 41 and io.js
// 1.2 leave. All three are no-ops on any newer Photoshop.
installBufferShims(Buffer);
installPolyfills(window);
installCssVariableFallback(window, readPanelStylesheet);

const mount = document.getElementById("panel");
if (mount) {
    render(<App />, mount);
}
