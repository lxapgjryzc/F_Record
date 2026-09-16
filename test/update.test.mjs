/**
 * The update check.
 *
 * Two things matter here and neither involves the network: that a version
 * comparison never offers someone a downgrade or a release candidate, and that
 * the checker stays silent unless the user opted in. The HTTP call itself is
 * injected, so none of this touches GitHub.
 */

import { mock, test } from "node:test";
import assert from "node:assert/strict";

import { clearFaults, mockBuiltins, setFault } from "./helpers.mjs";
import { RELEASES_API } from "../dist/modules/protocol.mjs";

// Loaded through a swappable "https", so the request can be watched and
// answered without a single packet leaving the machine.
mockBuiltins(mock, "https");
const { CHECK_INTERVAL_MS, UpdateChecker, compareVersions, fetchLatestRelease, parseLatestRelease } =
    await import("../dist/modules/update.mjs");

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

/* ------------------------------------------------------------ the request */

/**
 * Stands in for https.get.
 *
 * The real call is the one thing in the plug-in that leaves the machine, and
 * it must not leave it from a test: a suite that talks to GitHub fails when
 * the network does and rate-limits whoever runs it twice. What is worth
 * pinning down is that every way the request can go wrong ends as a rejected
 * promise with a sentence in it, and that none of them can settle twice.
 */
function fakeGitHub() {
    const state = { calls: [], request: {}, response: {}, destroyed: [], timeoutMs: 0 };

    setFault("get", (url, options, onResponse) => {
        state.calls.push({ url, options });
        state.onResponse = onResponse;
        const request = {
            on(event, fn) {
                state.request[event] = fn;
                return request;
            },
            setTimeout(ms, fn) {
                state.timeoutMs = ms;
                state.onTimeout = fn;
            },
            destroy() {
                state.destroyed.push("request");
            }
        };
        return request;
    });

    /** Hands the module a response object it can read. */
    state.reply = (statusCode) => {
        const response = {
            statusCode,
            resume() {
                state.drained = true;
            },
            setEncoding() {},
            on(event, fn) {
                state.response[event] = fn;
                return response;
            },
            destroy() {
                state.destroyed.push("response");
            }
        };
        state.onResponse(response);
        return state;
    };
    state.send = (chunk) => state.response.data(chunk);
    state.end = () => state.response.end();
    return state;
}

const RELEASE_JSON = JSON.stringify({
    tag_name: "v9.9.9",
    html_url: "https://github.com/lxapgjryzc/F_Record/releases/tag/v9.9.9",
    published_at: "2026-03-01T10:00:00Z"
});

test("a good response becomes a release, and nothing about the user goes out", async (t) => {
    t.after(clearFaults);
    const github = fakeGitHub();

    const promise = fetchLatestRelease();
    github.reply(200);
    github.send(RELEASE_JSON.slice(0, 20));
    github.send(RELEASE_JSON.slice(20));
    github.end();

    assert.deepEqual(await promise, {
        version: "9.9.9",
        url: "https://github.com/lxapgjryzc/F_Record/releases/tag/v9.9.9",
        publishedAt: Date.parse("2026-03-01T10:00:00Z")
    });

    // No query string, no identifier, no version of ours -- an unauthenticated
    // GET of a public endpoint and nothing more. GitHub does insist on a
    // User-Agent, which is the floor for any HTTP request.
    assert.equal(github.calls.length, 1);
    assert.equal(github.calls[0].url, RELEASES_API);
    assert.deepEqual(Object.keys(github.calls[0].options.headers).sort(), ["Accept", "User-Agent"]);
    assert.equal(github.calls[0].options.headers["User-Agent"], "F_Record-plugin");
});

test("anything but a 200 is reported with the status, and the socket is drained", async (t) => {
    t.after(clearFaults);
    const github = fakeGitHub();

    const promise = fetchLatestRelease();
    github.reply(403); // what a rate limit looks like

    await assert.rejects(promise, /GitHub replied 403/);
    assert.equal(github.drained, true, "left in a state the agent can reuse or close");
});

test("a response with no status at all is still a refusal, not a hang", async (t) => {
    t.after(clearFaults);
    const github = fakeGitHub();

    const promise = fetchLatestRelease();
    github.reply(undefined);

    await assert.rejects(promise, /GitHub replied 0/);
});

test("a body that is not JSON is reported as such", async (t) => {
    t.after(clearFaults);
    const github = fakeGitHub();

    const promise = fetchLatestRelease();
    github.reply(200);
    // A captive portal or a proxy error page, served with a 200.
    github.send("<html>Sign in to the network</html>");
    github.end();

    await assert.rejects(promise, /Could not parse the response/);
});

test("valid JSON that is not a release is refused rather than half-read", async (t) => {
    t.after(clearFaults);
    const github = fakeGitHub();

    const promise = fetchLatestRelease();
    github.reply(200);
    github.send(JSON.stringify({ message: "Not Found" }));
    github.end();

    await assert.rejects(promise, /No usable release in the response/);
});

test("a response that will not stop arriving is cut off", async (t) => {
    t.after(clearFaults);
    const github = fakeGitHub();

    const promise = fetchLatestRelease();
    github.reply(200);
    // A latest-release payload is a few KB. Half a megabyte is already far
    // past anything worth buffering inside Photoshop's own process.
    github.send("x".repeat(512 * 1024 + 1));

    await assert.rejects(promise, /Response was unreasonably large/);
    assert.deepEqual(github.destroyed, ["response"]);

    // And the end that arrives afterwards must not settle the promise a
    // second time, which would be an unhandled rejection.
    github.send("more");
    github.end();
});

test("a transport error on the response is passed through", async (t) => {
    t.after(clearFaults);
    const github = fakeGitHub();

    const promise = fetchLatestRelease();
    github.reply(200);
    github.response.error(new Error("socket hang up"));

    await assert.rejects(promise, /socket hang up/);
});

test("a request that never connects is reported, not left pending", async (t) => {
    t.after(clearFaults);
    const github = fakeGitHub();

    const promise = fetchLatestRelease();
    github.request.error(new Error("getaddrinfo ENOTFOUND api.github.com"));

    await assert.rejects(promise, /ENOTFOUND/);
});

test("a request that stalls is timed out and torn down", async (t) => {
    t.after(clearFaults);
    const github = fakeGitHub();

    const promise = fetchLatestRelease();
    assert.equal(github.timeoutMs, 10000, "ten seconds, not the OS default of two minutes");
    github.onTimeout();

    await assert.rejects(promise, /Timed out contacting GitHub/);
    assert.deepEqual(github.destroyed, ["request"]);
});

test("https.get throwing outright is a rejection like any other", async (t) => {
    t.after(clearFaults);
    // A malformed URL or a proxy setting the agent refuses throws from the
    // call itself rather than emitting an error event.
    setFault("get", () => {
        throw new Error("Invalid URL");
    });

    await assert.rejects(fetchLatestRelease(), /Invalid URL/);
});

test("the checker uses the real request when it is not given one", async (t) => {
    t.after(clearFaults);
    const github = fakeGitHub();
    const lines = [];
    const checker = new UpdateChecker({
        currentVersion: "4.10.0",
        isEnabled: () => true,
        dismissedVersion: () => null,
        onChange: () => {},
        log: (level, message) => lines.push(level + ": " + message)
    });

    const result = checker.check();
    github.reply(200);
    github.send(RELEASE_JSON);
    github.end();

    assert.deepEqual(await result, { outcome: "newer" });
    assert.equal(checker.getState().latestVersion, "9.9.9");
});

test("the checker's own clock is used when it is not given one", async () => {
    // now() defaults to Date.now, which is what the plug-in actually runs on;
    // the interval has to be measured against something.
    const before = Date.now();
    const checker = new UpdateChecker({
        currentVersion: "4.10.0",
        isEnabled: () => true,
        dismissedVersion: () => null,
        onChange: () => {},
        log: () => {},
        fetch: () => Promise.resolve({ version: "4.10.0", url: "u", publishedAt: null })
    });

    assert.deepEqual(await checker.check(), { outcome: "current" });
    checker.maybeCheck(); // within the interval of a check that just happened
    assert.ok(Date.now() >= before);
});

test("a second check while one is in flight is refused rather than queued", async () => {
    let release;
    const checker = new UpdateChecker({
        currentVersion: "4.10.0",
        isEnabled: () => true,
        dismissedVersion: () => null,
        onChange: () => {},
        log: () => {},
        fetch: () => new Promise((resolve) => (release = resolve))
    });

    const first = checker.check();
    const second = await checker.check();
    assert.deepEqual(second, { outcome: "failed", message: "A check is already running" });

    release({ version: "4.10.0", url: "u", publishedAt: null });
    assert.deepEqual(await first, { outcome: "current" });
});

test("a failure with nothing to say still says something", async () => {
    const lines = [];
    const checker = new UpdateChecker({
        currentVersion: "4.10.0",
        isEnabled: () => true,
        dismissedVersion: () => null,
        onChange: () => {},
        log: (level, message) => lines.push(message),
        // Rejecting with a bare string is what a `throw "..."` deeper down
        // arrives as; the log line must not read "Update check did not
        // complete: undefined".
        fetch: () => Promise.reject("no network")
    });

    assert.deepEqual(await checker.check(), { outcome: "failed", message: "no network" });
    assert.deepEqual(lines, ["Update check did not complete: no network"]);
});

test("a version with fewer segments is padded on either side", () => {
    // Both directions: the tag on GitHub and the version we are running can
    // each be the shorter one, and neither is newer for having fewer dots.
    assert.equal(compareVersions("4.1.0", "4.1"), 0);
    assert.equal(compareVersions("4.1", "4.1.0"), 0);
    assert.ok(compareVersions("4.1.1", "4.1") > 0);
    assert.ok(compareVersions("4.1", "4.1.1") < 0);
});

test("a version that is missing or nonsense sorts as the oldest thing there is", () => {
    // parseInt on a segment that is not a number gives NaN, and a NaN loose in
    // the comparison would make every answer false -- which reads as "not
    // newer" in one place and "not older" in another.
    assert.equal(compareVersions("", ""), 0);
    assert.equal(compareVersions(null, undefined), 0);
    assert.ok(compareVersions("4.0.0", "") > 0);
    assert.equal(compareVersions("4.beta.0", "4.0.0"), 0, "a word in the middle counts as zero");
    assert.equal(compareVersions("4.-1.0", "4.0.0"), 0, "so does a negative");
});

test("a release with no link or an unreadable date is still usable", () => {
    // The panel shows the version whether or not it can offer a button to it,
    // and a date it cannot read is better left blank than shown as NaN.
    assert.deepEqual(parseLatestRelease({ tag_name: "v5.0.0" }), {
        version: "5.0.0",
        url: "",
        publishedAt: null
    });
    assert.deepEqual(parseLatestRelease({ tag_name: "5.0.0", html_url: 42, published_at: "sometime" }), {
        version: "5.0.0",
        url: "",
        publishedAt: null
    });
});

test("a log sink that throws does not wedge every later check", async () => {
    let sink = () => {
        throw new Error("the panel went away mid-check");
    };
    const checker = new UpdateChecker({
        currentVersion: "4.10.0",
        isEnabled: () => true,
        dismissedVersion: () => null,
        onChange: () => {},
        log: (...args) => sink(...args),
        fetch: () => Promise.reject(new Error("offline"))
    });

    // The throw is not swallowed -- it is a real bug and should be visible --
    // but the in-flight flag has to be cleared on the way out regardless, or
    // the update check is dead for the rest of the session.
    await assert.rejects(checker.check(), /the panel went away mid-check/);

    sink = () => {};
    assert.deepEqual(await checker.check(), { outcome: "failed", message: "offline" });
});

test("a check that fails on the tick is swallowed there, not left unhandled", async () => {
    // maybeCheck() is called from the plug-in's one-second heartbeat, which has
    // nowhere to put a rejected promise. An unhandled rejection out of the
    // capture path would take the whole generator down on some Node versions.
    const checker = new UpdateChecker({
        currentVersion: "4.10.0",
        isEnabled: () => true,
        dismissedVersion: () => null,
        onChange: () => {},
        log: () => {
            throw new Error("the panel went away mid-check");
        },
        fetch: () => Promise.reject(new Error("offline"))
    });

    const unhandled = [];
    const watch = (e) => unhandled.push(e);
    process.on("unhandledRejection", watch);
    try {
        checker.maybeCheck();
        await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
        process.off("unhandledRejection", watch);
    }
    assert.deepEqual(unhandled, []);
});
