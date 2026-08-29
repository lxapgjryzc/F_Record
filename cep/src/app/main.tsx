import { render } from "preact";
import { App } from "./App";
import "./styles.css";

const mount = document.getElementById("panel");
if (mount) {
    render(<App />, mount);
}
