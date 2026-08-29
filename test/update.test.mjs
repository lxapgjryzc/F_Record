/**
 * The update check.
 *
 * Two things matter here and neither involves the network: that a version
 * comparison never offers someone a downgrade or a release candidate, and that
 * the checker stays silent unless the user opted in. The HTTP call itself is
 * injected, so none of this touches GitHub.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
    CHECK_INTERVAL_MS,
    UpdateChecker,
    compareVersions,
    parseLatestRelease
} from "../dist/test/update.mjs";

/* ------------------------------------------------------- version compare */

test("newer versions compare greater, in every segment", () => {
    assert.ok(compareVersions("4.1.0", "4.0.0") > 0);
    assert.ok(compareVersions("4.0.1", "4.0.0") > 0);
    assert.ok(compareVersions("5.0.0", "4.9.9") > 0);
    assert.ok(compareVersions("4.0.0", "4.1.0") < 0);
    assert.equal(compareVersions("4.0.0", "4.0.0"), 0);
});

test("a leading v is ignored, since tags carry one and versions do not", () => {
    assert.equal(compareVersions("v4.0.0", "4.0.0"), 0);
    assert.ok(compareVersions("v4.1.0", "4.0.0") > 0);
});

test("missing segments count as zero", () => {
    assert.equal(compareVersions("4.1", "4.1.0"), 0);
    assert.ok(compareVersions("4.2", "4.1.9") > 0);
});

test("double-digit segments compare numerically, not as text", () => {
    assert.ok(compareVersions("4.10.0", "4.9.0") > 0, "4.10 is newer than 4.9");
    assert.ok(compareVersions("4.0.12", "4.0.9") > 0);
});

test("a release candidate is not offered as an upgrade", () => {
    // Segments that are not numbers read as 0, so 4.1.0-rc1 ties with 4.1.0
    // rather than beating it. Nobody gets nagged onto a pre-release.
    assert.equal(compareVersions("4.1.0-rc1", "4.1.0"), 0);
});

/* ---------------------------------------------------------- release parse */

test("a normal release payload yields version, url and date", () => {
    const info = parseLatestRelease({
        tag_name: "v4.1.0",
        html_url: "https://github.com/o/r/releases/tag/v4.1.0",
        published_at: "2026-08-29T10:00:00Z"
    });
    assert.equal(info.version, "4.1.0", "the v is stripped");
    assert.equal(info.url, "https://github.com/o/r/releases/tag/v4.1.0");
    assert.equal(typeof info.publishedAt, "number");
});

test("drafts and pre-releases are refused", () => {
    assert.equal(parseLatestRelease({ tag_name: "v9.0.0", draft: true }), null);
    assert.equal(parseLatestRelease({ tag_name: "v9.0.0", prerelease: true }), null);
});

test("junk in, null out -- never a throw", () => {
    assert.equal(parseLatestRelease(null), null);
    assert.equal(parseLatestRelease("nonsense"), null);
    assert.equal(parseLatestRelease({}), null, "no tag_name");
    assert.equal(parseLatestRelease({ tag_name: "" }), null);
});

test("a missing publish date is tolerated", () => {
    const info = parseLatestRelease({ tag_name: "4.1.0", html_url: "u" });
    assert.equal(info.publishedAt, null);
});

/* ----------------------------------------------------------- the checker */

function makeChecker(overrides) {
    const calls = { fetch: 0, changed: 0 };
    const options = Object.assign(
        {
            currentVersion: "4.0.0",
            isEnabled: () => true,
            dismissedVersion: () => null,
            onChange: () => calls.changed++,
            log: () => {},
            fetch: () => {
                calls.fetch++;
                return Promise.resolve({ version: "4.1.0", url: "u", publishedAt: 1 });
            },
            now: () => 1000
        },
        overrides
    );
    return { checker: new UpdateChecker(options), calls: calls };
}

test("nothing is reported until a check actually finds something newer", () => {
    const { checker } = makeChecker();
    assert.equal(checker.getState(), null, "silent before the first check");
});

test("a newer release becomes visible state", async () => {
    const { checker, calls } = makeChecker();
    const result = await checker.check();

    assert.equal(result.outcome, "newer");
    const state = checker.getState();
    assert.equal(state.latestVersion, "4.1.0");
    assert.equal(state.dismissed, false);
    assert.equal(calls.changed, 1, "the panel is told");
});

test("the same version is not an update", async () => {
    const { checker } = makeChecker({
        fetch: () => Promise.resolve({ version: "4.0.0", url: "u", publishedAt: 1 })
    });
    const result = await checker.check();
    assert.equal(result.outcome, "current");
    assert.equal(checker.getState(), null, "no banner for the version you are on");
});

test("an older release on GitHub never triggers a downgrade prompt", async () => {
    const { checker } = makeChecker({
        fetch: () => Promise.resolve({ version: "3.9.0", url: "u", publishedAt: 1 })
    });
    assert.equal((await checker.check()).outcome, "current");
    assert.equal(checker.getState(), null);
});

test("a dismissed version is remembered", async () => {
    const { checker } = makeChecker({ dismissedVersion: () => "4.1.0" });
    await checker.check();
    assert.equal(checker.getState().dismissed, true);
});

test("dismissing one version does not silence the next", async () => {
    const { checker } = makeChecker({
        dismissedVersion: () => "4.1.0",
        fetch: () => Promise.resolve({ version: "4.2.0", url: "u", publishedAt: 1 })
    });
    await checker.check();
    assert.equal(checker.getState().dismissed, false, "4.2.0 is still worth showing");
});

test("a failed check is reported, not thrown", async () => {
    const { checker } = makeChecker({
        fetch: () => Promise.reject(new Error("getaddrinfo ENOTFOUND"))
    });
    const result = await checker.check();
    assert.equal(result.outcome, "failed");
    assert.match(result.message, /ENOTFOUND/);
    assert.equal(checker.getState(), null);
});

test("opting out means no request is ever made", () => {
    const { checker, calls } = makeChecker({ isEnabled: () => false });
    checker.maybeCheck();
    checker.maybeCheck();
    assert.equal(calls.fetch, 0, "the network is never touched while switched off");
});

test("the scheduled check runs once, then waits out the interval", async () => {
    let clock = 1000;
    const { checker, calls } = makeChecker({ now: () => clock });

    checker.maybeCheck();
    await flush();
    assert.equal(calls.fetch, 1);

    // Same day: no second request.
    clock += CHECK_INTERVAL_MS - 1;
    checker.maybeCheck();
    await flush();
    assert.equal(calls.fetch, 1, "still inside the interval");

    clock += 2;
    checker.maybeCheck();
    await flush();
    assert.equal(calls.fetch, 2, "a day later it checks again");
});

test("a failure still starts the clock, so a broken network is not hammered", async () => {
    let clock = 1000;
    let attempts = 0;
    const { checker } = makeChecker({
        now: () => clock,
        fetch: () => {
            attempts++;
            return Promise.reject(new Error("offline"));
        }
    });

    checker.maybeCheck();
    await flush();
    checker.maybeCheck();
    await flush();
    assert.equal(attempts, 1, "the retry waits for the next interval, it does not spin");
});

test("forget() clears the banner when the setting is switched off", async () => {
    const { checker } = makeChecker();
    await checker.check();
    assert.ok(checker.getState());
    checker.forget();
    assert.equal(checker.getState(), null);
});

function flush() {
    return new Promise((resolve) => setTimeout(resolve, 0));
}
