//! Detect and install the Composio CLI.
//!
//! The CLI is what actually connects a user's apps: `composio link gmail`
//! opens the provider's consent page. Composio publishes exactly one install
//! channel — a shell script served from their site — so installing it means
//! running code we did not write. That is the same trust the user already
//! extends by choosing Composio, but it is worth being precise about what
//! this module does and does not do with it:
//!
//! - **Download, then run. Never `curl … | sh`.** A pipe hands `sh` a stream,
//!   so a connection that drops mid-transfer executes the *prefix* of a
//!   script — a real failure mode, not a theoretical one, and the reason the
//!   two steps are separate here. `curl -f` fails the whole download on a
//!   non-2xx, and the file is checked for a shebang before anything runs.
//! - **No shell string is ever built.** The URL is a hardcoded constant and
//!   every argument is passed as argv, so there is no interpolation for input
//!   to escape from. Nothing here takes a parameter from the webview.
//! - **`--proto =https --tlsv1.2`** pins the transport across redirects too:
//!   without them a 302 to `http://` would be followed happily.
//! - **The script runs as the user, never elevated.** It installs into
//!   `~/.composio` and `~/.local/bin`, both user-owned; a version that asked
//!   for root would be a reason to stop shipping this button, not to add a
//!   privilege prompt.
//!
//! The scratch directory is created under the app's own data root rather than
//! `/tmp`, which is world-writable on Unix — a predictable name there lets a
//! local attacker pre-create a symlink and redirect the write.

use crate::error::{Error, Result};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;

/// Composio's published installer. Hardcoded on purpose: see the module note.
const INSTALL_URL: &str = "https://composio.dev/install";

/// Ceiling on the whole install. The script downloads a release bundle, so it
/// is not instant; without a deadline a stalled transfer leaves the UI saying
/// "Installing…" forever with no way back.
///
/// Fifteen minutes, not three: the 0.3.3 release took 8.9 minutes on a measured
/// slow connection, so the old deadline killed a working download.
const INSTALL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15 * 60);
const INSTALL_TIMEOUT_HELP: &str = "Composio was still downloading after 15 minutes, so it was stopped. On a slow connection, run `curl -fsSL https://composio.dev/install | sh` in a terminal instead — it has no time limit.";

/// How long the `--version` probe may take before we call the CLI absent.
const PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// `composio login --poll` waits up to ten minutes for the browser half of the
/// login. A minute of slack on top, so our deadline never fires *before* the
/// CLI gives its own answer — whichever ends first should be the CLI.
///
/// Ten minutes is not a guess: the cached login session carries its own
/// `expiresAt`, measured at exactly 10 minutes after `cachedAt`. Past that the
/// link is dead — and it dies *quietly*, because the dashboard only validates
/// the key after sign-in, so an already-signed-in user lands on a blank page
/// instead of an error. That is what "Open again" is for: it mints a fresh
/// key rather than retrying a dead one.
const LOGIN_POLL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(11 * 60);

/// The only host we will send a user to. Composio prints the login URL on
/// stdout and we hand it to the OS browser, so it is checked against this
/// prefix first: if a future release (or a tampered binary) prints somewhere
/// else, the flow fails instead of opening it. Matches the opener allowlist.
const LOGIN_URL_PREFIX: &str = "https://dashboard.composio.dev/";

/// Connecting an app lands on a different host than logging in — measured:
/// `link` returns `https://connect.composio.dev/link/lk_…`. It needs its own
/// prefix *and* its own entry in the opener allowlist; without both, the
/// connect button fails with an opaque refusal that looks like a dead click.
const LINK_URL_PREFIX: &str = "https://connect.composio.dev/";

/// Locate the `composio` entry point.
///
/// `PATH` first, then the installer's own defaults: a GUI-launched app on
/// macOS inherits a minimal `PATH` that will not include `~/.local/bin`, so
/// searching `PATH` alone reports "not installed" for a CLI that is sitting
/// right there — the same trap `find_ollama_binary` documents.
fn find_composio_binary() -> Option<PathBuf> {
    let binary = if cfg!(windows) {
        "composio.exe"
    } else {
        "composio"
    };

    if let Some(path) = std::env::var_os("PATH")
        && let Some(dir) = std::env::split_paths(&path).find(|dir| dir.join(binary).is_file())
    {
        return Some(dir.join(binary));
    }

    let home = std::env::var_os("HOME").map(PathBuf::from)?;
    // `COMPOSIO_BIN_DIR` default, then the legacy single-directory layout the
    // installer still supports.
    [
        home.join(".local/bin").join(binary),
        home.join(".composio").join(binary),
    ]
    .into_iter()
    .find(|candidate| candidate.is_file())
}

/// Whether a downloaded file is a shell script rather than something a web
/// server substituted for one.
///
/// A shebang is a weak signal, and deliberately so: this is not authenticating
/// the script — TLS to composio.dev does that — it is catching the case where
/// something *else* answered with a 200, which a captive portal and an error
/// page dressed as HTML both do.
fn looks_like_script(bytes: &[u8]) -> bool {
    bytes.starts_with(b"#!")
}

/// Run a command with a deadline and return its stdout.
///
/// Used instead of `Command::output()` everywhere in this module, because
/// `output()` has no timeout: a wedged CLI would leave the UI on "Checking…"
/// or "Opening…" for the life of the app with no way back. Reading the pipe
/// *after* the child exits is only safe for small outputs — a version line, a
/// login URL — since a child that fills the pipe buffer would block before
/// exiting. Do not reuse this for a chatty command.
fn capture_with_timeout(command: &mut Command, deadline: std::time::Duration) -> Result<String> {
    let mut child = command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|error| Error::Io(error.to_string()))?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| Error::Io("no output from the Composio CLI".into()))?;
    if !wait_with_timeout(child, deadline)? {
        return Err(Error::Io("the Composio CLI did not finish".into()));
    }
    let mut buffer = String::new();
    std::io::Read::read_to_string(&mut stdout, &mut buffer)
        .map_err(|error| Error::Io(error.to_string()))?;
    Ok(buffer)
}

/// First line of `--version` output, capped.
///
/// Some builds print "composio/0.3.1 …"; this keeps the whole first line but
/// never an unbounded blob, because the string goes straight into the UI.
fn version_line(text: &str) -> String {
    let line = text.trim().lines().next().unwrap_or_default().trim();
    if line.is_empty() {
        "installed".to_owned()
    } else {
        line.chars().take(80).collect()
    }
}

/// Run a child process to completion, killing it if it outlives `deadline`.
///
/// `wait()` has no timeout, so a hung installer would otherwise pin a thread
/// and a spinner for the life of the app.
fn wait_with_timeout(
    mut child: std::process::Child,
    deadline: std::time::Duration,
) -> Result<bool> {
    let started = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status.success()),
            Ok(None) => {}
            Err(error) => return Err(Error::Io(error.to_string())),
        }
        if started.elapsed() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(Error::ProcessTimeout);
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
}

/// Installed version string, or `None` when the CLI is not on this machine.
///
/// Asking the binary rather than trusting the path: a stale symlink left by a
/// removed install is a file that exists and cannot run, and reporting that as
/// "connected" would send the user to a Plugins screen that then fails.
#[tauri::command]
pub(crate) async fn composio_cli_version() -> Option<String> {
    tauri::async_runtime::spawn_blocking(|| {
        let binary = find_composio_binary()?;
        let text =
            capture_with_timeout(Command::new(binary).arg("--version"), PROBE_TIMEOUT).ok()?;
        Some(version_line(&text))
    })
    .await
    .ok()
    .flatten()
}

/// Whether the CLI holds a login.
///
/// Read from disk rather than by running a command, and that is a measured
/// choice: every authenticated CLI command tried here (`dev
/// connected-accounts list`, `dev projects list`, `search`) exits **0 with
/// empty output** when logged out. An exit-code probe would therefore report
/// "connected" to someone who never signed in — the exact false green this
/// function exists to avoid.
///
/// The credential is `api_key` in `user_data.json` — note the underscore — not
/// `config.json`, which the CLI writes on first run whether or not anyone has
/// signed in (it holds `developer`, `security` and friends, never a key). An
/// earlier version of this read `apiKey` from `config.json`, inferred from
/// strings in the binary, and so reported "not signed in" forever after a
/// perfectly good login. Both the file and the field name are now confirmed
/// against a real completed login; re-verify against the CLI, not the binary,
/// if this ever moves again.
#[tauri::command]
pub(crate) fn composio_signed_in() -> bool {
    let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else {
        return false;
    };
    let Ok(text) = std::fs::read_to_string(home.join(".composio/user_data.json")) else {
        return false;
    };
    let Ok(data) = serde_json::from_str::<serde_json::Value>(&text) else {
        return false;
    };
    has_api_key(&data)
}

/// The login check itself, split out so a test can pin the observed JSON shape
/// without needing a `$HOME` to write into.
fn has_api_key(data: &serde_json::Value) -> bool {
    data.get("api_key")
        .and_then(serde_json::Value::as_str)
        .is_some_and(|key| !key.trim().is_empty())
}

/// Begin a login and return the URL the user has to open.
///
/// `--no-wait` is what makes this usable from a GUI at all: it prints the URL
/// and the session key, then exits, instead of holding a terminal open. The
/// browser half is ours to open and the waiting half is `composio_login_poll`,
/// so no pseudo-terminal and no prompt scraping is involved.
///
/// `--no-browser` stops the CLI opening a browser itself — we do that through
/// the opener allowlist, which is the one path the app controls. `--yes` skips
/// the org picker, an interactive prompt with nobody to answer it.
///
/// `--no-skill-install` is not optional politeness: plain `composio login`
/// **installs a Claude Code skill** on the user's machine as a side effect.
/// Signing in to Blobbies must not silently write into another tool's config.
#[tauri::command]
pub(crate) async fn composio_login_start() -> Result<String> {
    tauri::async_runtime::spawn_blocking(|| {
        let binary = find_composio_binary()
            .ok_or_else(|| Error::Io("The Composio CLI is not installed yet.".into()))?;
        // Deadlined like every other spawn here: `--no-wait` should return at
        // once, but a stalled session request must not strand the UI on
        // "Opening\u2026".
        let text = capture_with_timeout(
            Command::new(binary).args([
                "login",
                "--no-wait",
                "--no-browser",
                "--no-skill-install",
                "--yes",
            ]),
            PROBE_TIMEOUT,
        )
        .map_err(|_| Error::Io("Could not start a Composio login.".into()))?;
        // Fail closed: only a URL on the expected host is ever returned, so a
        // release that starts printing somewhere else stops the flow rather
        // than sending someone to an unexpected site.
        text.split_whitespace()
            .find(|word| word.starts_with(LOGIN_URL_PREFIX))
            .map(str::to_owned)
            .ok_or_else(|| Error::Io("Composio did not return a login link.".into()))
    })
    .await
    .map_err(|error| Error::Io(error.to_string()))?
}

/// Wait for the user to finish logging in in their browser.
///
/// Reads the pending session the `--no-wait` call cached, so no key crosses
/// the IPC boundary. Resolves true once credentials are saved; false when the
/// CLI gives up, which is a real outcome (the user closed the tab) and not an
/// error worth a dialog.
#[tauri::command]
pub(crate) async fn composio_login_poll() -> bool {
    tauri::async_runtime::spawn_blocking(|| {
        let Some(binary) = find_composio_binary() else {
            return false;
        };
        let Ok(child) = Command::new(binary)
            .args(["login", "--poll", "--no-skill-install", "--yes"])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
        else {
            return false;
        };
        // The CLI's own success is not taken at face value — the credential
        // landing on disk is the thing the next screen depends on.
        wait_with_timeout(child, LOGIN_POLL_TIMEOUT).unwrap_or(false) && composio_signed_in()
    })
    .await
    .unwrap_or(false)
}

/// One connected account, as the Plugins detail view shows it.
#[derive(Serialize)]
pub(crate) struct ComposioAccount {
    /// Toolkit slug, e.g. `gmail`.
    pub toolkit: String,
    /// The CLI's own handle for this account, used to name it in `--account`.
    pub id: String,
    /// User-chosen name when they connected a second account, else empty.
    pub alias: String,
    /// Raw CLI status, shown as-is rather than reduced to a boolean.
    pub status: String,
    /// Whether this account can actually be used right now.
    pub active: bool,
}

/// Every connected account, across every toolkit.
///
/// `connections list` prints an object keyed by slug, each holding one entry
/// per account: `{"gmail":[{"status":"ACTIVE","alias":null,"word_id":…}]}`.
///
/// Every account is returned, not only the usable ones, because the detail
/// view has to *show* a broken account before the user can act on it. `active`
/// carries the judgement: only `ACTIVE` counts, since `link` writes its record
/// before the browser half runs (an unfinished connect sits at `INITIALIZING`)
/// and a lapsed one goes to `EXPIRED` — both measured. Anything that is not
/// exactly `ACTIVE` is treated as unusable, so a status Composio adds later
/// fails closed rather than showing a green tile that cannot work.
#[tauri::command]
pub(crate) async fn composio_accounts() -> Vec<ComposioAccount> {
    tauri::async_runtime::spawn_blocking(|| {
        let Some(binary) = find_composio_binary() else {
            return Vec::new();
        };
        let Ok(text) = capture_with_timeout(
            Command::new(binary).args(["connections", "list"]),
            PROBE_TIMEOUT,
        ) else {
            return Vec::new();
        };
        parse_accounts(&text)
    })
    .await
    .unwrap_or_default()
}

/// Parse `connections list` output.
///
/// Split out so the observed JSON shape is pinned by a test rather than by a
/// live account — the mistake that made `composio_signed_in` read the wrong
/// file for a whole session.
fn parse_accounts(text: &str) -> Vec<ComposioAccount> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
        return Vec::new();
    };
    let Some(map) = value.as_object() else {
        return Vec::new();
    };
    let mut accounts: Vec<ComposioAccount> = map
        .iter()
        .flat_map(|(toolkit, entries)| {
            entries
                .as_array()
                .map(Vec::as_slice)
                .unwrap_or_default()
                .iter()
                .filter_map(|entry| {
                    let status = entry
                        .get("status")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or_default();
                    let id = entry
                        .get("word_id")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or_default();
                    // No handle means nothing can be said about it and nothing
                    // can be done to it, so it is not worth a row.
                    if id.is_empty() {
                        return None;
                    }
                    Some(ComposioAccount {
                        toolkit: toolkit.clone(),
                        id: id.to_owned(),
                        alias: entry
                            .get("alias")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or_default()
                            .to_owned(),
                        status: status.to_owned(),
                        active: status == "ACTIVE",
                    })
                })
                .collect::<Vec<_>>()
        })
        .collect();
    // Sorted so repeated reads are comparable: the modal re-reads this while
    // polling, and unsorted output would look like a change on every tick.
    accounts.sort_by(|left, right| (&left.toolkit, &left.id).cmp(&(&right.toolkit, &right.id)));
    accounts
}

/// How long a tool call may run. Longer than a probe: these reach real APIs
/// (send an email, search a drive) over the network.
const EXECUTE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

/// Cap on CLI output handed back to the model.
///
/// This text is *remote content* — an inbox, a document, a CRM record — and it
/// lands in the transcript, so an unbounded response would let one tool call
/// fill the whole context window. Generous enough for a real page of results.
const EXECUTE_OUTPUT_LIMIT: usize = 60_000;

/// Find tools for a task, in Composio's own words.
///
/// `search` returns a ranked plan naming the tool slugs for a use case, which
/// is what makes three meta-tools enough: the model discovers `GMAIL_SEND_EMAIL`
/// at call time instead of us shipping 61 Gmail tool definitions in every
/// prompt. The query is user/model text and reaches argv, never a shell.
#[tauri::command]
pub(crate) async fn composio_search(query: String) -> Result<String> {
    if query.trim().is_empty() || query.len() > 400 {
        return Err(Error::Io(
            "Search for something between 1 and 400 characters.".into(),
        ));
    }
    run_cli(vec![
        "search".to_owned(),
        query,
        "--limit".to_owned(),
        "5".to_owned(),
    ])
    .await
}

/// The input schema for one tool, including Composio's own field descriptions.
#[tauri::command]
pub(crate) async fn composio_schema(tool: String) -> Result<String> {
    let tool = check_tool_slug(tool)?;
    run_cli(vec!["execute".to_owned(), tool, "--get-schema".to_owned()]).await
}

/// Run one Composio tool.
///
/// `arguments` is a JSON object the model composed. It is parsed here before
/// being passed on: a malformed blob should fail with something the model can
/// correct, not reach the CLI as a mystery argv entry.
#[tauri::command]
pub(crate) async fn composio_execute(tool: String, arguments: String) -> Result<String> {
    let tool = check_tool_slug(tool)?;
    let payload = if arguments.trim().is_empty() {
        "{}".to_owned()
    } else {
        let parsed: serde_json::Value = serde_json::from_str(&arguments)
            .map_err(|_| Error::Io("Arguments must be a JSON object.".into()))?;
        if !parsed.is_object() {
            return Err(Error::Io("Arguments must be a JSON object.".into()));
        }
        parsed.to_string()
    };
    let raw = run_cli(vec!["execute".to_owned(), tool, "-d".to_owned(), payload]).await?;
    Ok(resolve_spill(raw))
}

/// Follow a spilled result back to its contents.
///
/// Measured, and invisible without running it: a large result is **not**
/// returned inline. The CLI writes it to a temp file and answers with
/// `{"successful":true,"storedInFile":true,"outputFilePath":"/var/…"}` — a real
/// Gmail fetch spilled 39k tokens that way. Passed to a model unchanged that
/// reads as "it worked and the inbox was empty", which is the worst possible
/// answer: confidently wrong.
///
/// The path comes from our own subprocess, not from the model, and the
/// contents are capped like any other result.
fn resolve_spill(raw: String) -> String {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return raw;
    };
    if value
        .get("storedInFile")
        .and_then(serde_json::Value::as_bool)
        != Some(true)
    {
        return raw;
    }
    let Some(path) = value
        .get("outputFilePath")
        .and_then(serde_json::Value::as_str)
    else {
        return raw;
    };
    match std::fs::read_to_string(path) {
        Ok(text) => cap_result(text),
        // A path is useless to a model, so say what happened instead of
        // handing back something it cannot open.
        Err(_) => "The app returned a result too large to read back.".to_owned(),
    }
}

/// Cap a result, saying so when it is cut.
///
/// Silent truncation of JSON is worse than it sounds: the model receives a
/// structure that ends mid-object, reads it as the whole answer, and reports
/// what survived as if that were everything — measured with deepseek, which
/// answered "the tool returned only one email" after a two-email fetch was
/// clipped. One real Gmail message carries ~16KB of MIME `payload` nobody
/// reads, so this fires on ordinary requests, not just huge ones.
///
/// The note is plain text after the JSON: a model reads it, and it cannot be
/// mistaken for data inside the result.
fn cap_result(text: String) -> String {
    if text.chars().count() <= EXECUTE_OUTPUT_LIMIT {
        return text;
    }
    let kept: String = text.chars().take(EXECUTE_OUTPUT_LIMIT).collect();
    format!(
        "{kept}\n\n[This result was cut short here — it does not end cleanly. \
         Ask for fewer items or a narrower query to see the rest.]"
    )
}

/// Tool slugs are `UPPER_SNAKE` with digits, e.g. `GMAIL_FETCH_EMAILS`.
///
/// Checked rather than trusted: the slug is model-composed text heading for
/// argv, and a value shaped like a flag has no business being passed as a name.
fn check_tool_slug(tool: String) -> Result<String> {
    let ok = !tool.is_empty()
        && tool.len() <= 128
        && tool
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_');
    if ok {
        Ok(tool)
    } else {
        Err(Error::Io("That is not a valid tool name.".into()))
    }
}

/// Run the CLI with argv, a deadline, and a capped result.
async fn run_cli(args: Vec<String>) -> Result<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let binary = find_composio_binary()
            .ok_or_else(|| Error::Io("The Composio CLI is not installed.".into()))?;
        let mut command = Command::new(binary);
        command.args(&args);
        let text = capture_with_timeout(&mut command, EXECUTE_TIMEOUT)?;
        Ok(cap_result(text))
    })
    .await
    .map_err(|error| Error::Io(error.to_string()))?
}

/// The address or username behind one connected account.
///
/// `connections list` names accounts only by an internal handle
/// (`gmail_casava-tst`) — unguessable to the person who connected them, and
/// useless for telling two Gmail accounts apart. The identity lives one call
/// deeper, so the Plugins panel asks for it per account and falls back to the
/// handle when a toolkit has no such tool.
///
/// Best-effort by design: this runs for every connected account when a panel
/// opens, so a toolkit that cannot answer, or an expired account that no
/// longer can, must cost one empty string rather than an error.
#[tauri::command]
pub(crate) async fn composio_account_identity(toolkit: String, account: String) -> String {
    // `GMAIL_GET_PROFILE`-style tools are per-toolkit; only the ones we know
    // return an identity are worth a call.
    let tool = match toolkit.as_str() {
        "gmail" => "GMAIL_GET_PROFILE",
        _ => return String::new(),
    };
    if !is_safe_account(&account) {
        return String::new();
    }
    tauri::async_runtime::spawn_blocking(move || {
        let Some(binary) = find_composio_binary() else {
            return String::new();
        };
        let Ok(text) = capture_with_timeout(
            Command::new(binary).args(["execute", tool, "--account", &account, "-d", "{}"]),
            PROBE_TIMEOUT,
        ) else {
            return String::new();
        };
        identity_from(&text)
    })
    .await
    .unwrap_or_default()
}

/// Pull the human-readable identity out of a profile result.
///
/// Split out so the observed JSON shape is pinned by a test rather than by a
/// live account — the mistake that had `composio_signed_in` reading the wrong
/// file for a whole session.
fn identity_from(text: &str) -> String {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
        return String::new();
    };
    if value.get("successful").and_then(serde_json::Value::as_bool) != Some(true) {
        return String::new();
    }
    for key in ["emailAddress", "email", "username", "login"] {
        if let Some(found) = value
            .get("data")
            .and_then(|data| data.get(key))
            .and_then(serde_json::Value::as_str)
            .filter(|found| !found.trim().is_empty())
        {
            return found.chars().take(120).collect();
        }
    }
    String::new()
}

/// Account handles are `slug_word-word`: lowercase, digits, `_` and `-`.
///
/// Checked because it reaches argv from the webview, same as a toolkit slug.
fn is_safe_account(value: &str) -> bool {
    // Must *start* alphanumeric: `-` is legal inside a handle
    // (`gmail_casava-tst`), so allowing it anywhere let `--account` pass the
    // check and reach argv as a flag. Caught by its own test.
    value.len() <= 128
        && value
            .bytes()
            .next()
            .is_some_and(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        && value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_' || byte == b'-'
        })
}

/// Whether a webview-supplied string is safe to pass as one argv entry.
///
/// Composio slugs and aliases are lowercase words with digits and underscores.
/// Nothing here is interpolated into a shell — every call passes argv — but a
/// value that reaches a subprocess should still be shaped like what it claims
/// to be, so a leading `-` cannot turn into a flag.
fn is_safe_slug(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
}

/// Begin connecting one toolkit, returning the URL to open.
///
/// Same two-phase shape as login, and for the same reason: `--no-wait` returns
/// a URL and exits, `--no-browser` leaves the opening to us so it goes through
/// the app's allowlist rather than wherever the CLI would send it.
///
/// The slug comes from the webview, so it is checked against a strict pattern
/// before reaching argv. Composio slugs are lowercase words with underscores;
/// anything else is refused rather than passed to a subprocess.
#[tauri::command]
pub(crate) async fn composio_link_start(toolkit: String, alias: String) -> Result<String> {
    if !is_safe_slug(&toolkit) {
        return Err(Error::Io("That is not a valid app name.".into()));
    }
    // An alias is how a second Gmail is told apart from the first; the CLI
    // requires one for any additional account on the same toolkit. It is
    // user-typed, so it gets the same argv-safety treatment as the slug.
    if !alias.is_empty() && !is_safe_slug(&alias) {
        return Err(Error::Io(
            "Use lowercase letters, numbers and underscores for the account name.".into(),
        ));
    }
    tauri::async_runtime::spawn_blocking(move || {
        let binary = find_composio_binary()
            .ok_or_else(|| Error::Io("The Composio CLI is not installed yet.".into()))?;
        let mut command = Command::new(binary);
        command.args(["link", &toolkit, "--no-wait", "--no-browser"]);
        if !alias.is_empty() {
            command.args(["--alias", &alias]);
        }
        let text = capture_with_timeout(&mut command, PROBE_TIMEOUT)
            .map_err(|_| Error::Io("Could not start the connection.".into()))?;
        let value: serde_json::Value = serde_json::from_str(text.trim())
            .map_err(|_| Error::Io("Composio did not return a connection link.".into()))?;
        // `link` answers with JSON whose `redirect_url` points at
        // connect.composio.dev — a *different* host from login's dashboard URL,
        // so it has its own prefix. Reusing the login constant here would fail
        // closed on every connect.
        value
            .get("redirect_url")
            .and_then(serde_json::Value::as_str)
            .filter(|url| url.starts_with(LINK_URL_PREFIX))
            .map(str::to_owned)
            .ok_or_else(|| Error::Io("Composio did not return a connection link.".into()))
    })
    .await
    .map_err(|error| Error::Io(error.to_string()))?
}

/// True when this platform can run Composio's installer at all.
///
/// The installer is a POSIX `sh` script; on Windows it is a WSL-only path, so
/// the button is hidden there rather than failing after a click.
#[tauri::command]
pub(crate) fn composio_cli_installable() -> bool {
    !cfg!(windows)
}

/// Download Composio's installer, verify it looks like a script, and run it.
///
/// Returns the installed version on success. Takes no arguments by design —
/// nothing the webview can say changes what is fetched or executed.
#[tauri::command]
pub(crate) async fn composio_cli_install(app: tauri::AppHandle) -> Result<String> {
    let scratch = crate::store::data_root(&app)?.join("tmp");
    tauri::async_runtime::spawn_blocking(move || install_blocking(&scratch))
        .await
        .map_err(|error| Error::Io(error.to_string()))?
}

fn install_blocking(scratch: &Path) -> Result<String> {
    if cfg!(windows) {
        return Err(Error::Io(
            "Composio's installer needs a POSIX shell; install it from WSL or a terminal.".into(),
        ));
    }

    std::fs::create_dir_all(scratch).map_err(|error| Error::Io(error.to_string()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(scratch, std::fs::Permissions::from_mode(0o700))
            .map_err(|error| Error::Io(error.to_string()))?;
    }

    let script = scratch.join("composio-install.sh");
    // Remove any leftover first: `-o` truncates, but an attacker-planted
    // symlink at this path would have the write follow it elsewhere.
    let _ = std::fs::remove_file(&script);

    let curl = Command::new("curl")
        .args([
            "--proto",
            "=https",
            "--tlsv1.2",
            "--fail",
            "--silent",
            "--show-error",
            "--location",
            "--max-time",
            "60",
            "--output",
        ])
        .arg(&script)
        .arg(INSTALL_URL)
        .stdin(std::process::Stdio::null())
        .spawn()
        .map_err(|error| Error::Io(format!("could not run curl: {error}")))?;
    if !wait_with_timeout(curl, INSTALL_TIMEOUT)? {
        let _ = std::fs::remove_file(&script);
        return Err(Error::Io(
            "Could not download Composio's installer. Check your connection and try again.".into(),
        ));
    }

    // A 200 that is not a script (a captive-portal login page, an error page
    // served as HTML) must not reach `sh`.
    let downloaded = std::fs::read(&script).map_err(|error| Error::Io(error.to_string()))?;
    if !looks_like_script(&downloaded) {
        let _ = std::fs::remove_file(&script);
        return Err(Error::Io(
            "That download was not Composio's installer, so nothing was run.".into(),
        ));
    }

    let shell = Command::new("sh")
        .arg(&script)
        .current_dir(scratch)
        // Quiet: the script's progress output has nowhere to go here, and the
        // UI reports the outcome from the version probe below instead.
        .env("COMPOSIO_QUIET", "1")
        .stdin(std::process::Stdio::null())
        .spawn()
        .map_err(|error| Error::Io(format!("could not run the installer: {error}")))?;
    let ran = wait_with_timeout(shell, INSTALL_TIMEOUT);
    let _ = std::fs::remove_file(&script);
    match ran {
        Ok(true) => {}
        Ok(false) => {
            return Err(Error::Io(
                "Composio's installer did not finish. Try `curl -fsSL https://composio.dev/install | sh` in a terminal.".into(),
            ));
        }
        Err(Error::ProcessTimeout) => return Err(Error::Composio(INSTALL_TIMEOUT_HELP.into())),
        Err(error) => return Err(error),
    }

    let binary = find_composio_binary().ok_or_else(|| {
        Error::Io("Installer finished but the CLI is not on this machine.".into())
    })?;
    let text = capture_with_timeout(Command::new(binary).arg("--version"), PROBE_TIMEOUT)?;
    Ok(version_line(&text))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_shebang_file_is_allowed_to_run() {
        // The realistic failures: a captive portal or an error page answering
        // with a 200, and a truncated transfer. None may reach `sh`.
        assert!(!looks_like_script(b"<!DOCTYPE html><title>Sign in</title>"));
        assert!(!looks_like_script(b""));
        assert!(!looks_like_script(b"{\"error\":\"not found\"}"));
        assert!(looks_like_script(b"#!/bin/sh\nset -e\n"));
    }

    #[test]
    fn a_hung_child_is_killed_at_the_deadline() {
        // The install runs a downloaded script; if it never exits, the UI must
        // not wait on it forever. `sleep` stands in for a stalled installer.
        let child = Command::new("sleep")
            .arg("30")
            .stdin(std::process::Stdio::null())
            .spawn()
            .expect("sleep should spawn");
        let started = std::time::Instant::now();
        let outcome = wait_with_timeout(child, std::time::Duration::from_millis(300));
        assert!(
            matches!(outcome, Err(Error::ProcessTimeout)),
            "a child past its deadline must return the typed timeout"
        );
        assert!(
            started.elapsed() < std::time::Duration::from_secs(5),
            "the deadline must actually cut the wait short"
        );
    }

    #[test]
    fn install_timeout_is_generous_and_actionable() {
        assert_eq!(
            INSTALL_TIMEOUT,
            std::time::Duration::from_secs(15 * 60),
            "the reviewed installer ceiling is 15 minutes"
        );
        assert_eq!(
            Error::Composio(INSTALL_TIMEOUT_HELP.into()).to_string(),
            INSTALL_TIMEOUT_HELP,
            "the timeout must not regain the misleading storage-error prefix"
        );
        assert!(INSTALL_TIMEOUT_HELP.contains("still downloading after 15 minutes"));
        assert!(INSTALL_TIMEOUT_HELP.contains("curl -fsSL https://composio.dev/install | sh"));
    }

    // Detection itself is not unit-tested: it reads `PATH` and `HOME`, and
    // overriding those needs `unsafe` env mutation, which this crate forbids.
    // It is exercised for real by the Plugins tab on every open.

    #[test]
    fn a_version_line_is_bounded_and_never_empty() {
        // This string goes straight into the UI, so a chatty or empty build
        // must not produce a blank row or a wall of text.
        assert_eq!(
            version_line("composio/0.3.1 darwin-arm64"),
            "composio/0.3.1 darwin-arm64"
        );
        assert_eq!(version_line("  0.3.1  \nextra line\n"), "0.3.1");
        assert_eq!(version_line(""), "installed");
        assert_eq!(version_line(&"x".repeat(500)).chars().count(), 80);
    }

    #[test]
    fn windows_is_not_installable() {
        assert_eq!(composio_cli_installable(), !cfg!(windows));
    }

    #[test]
    fn only_the_expected_host_is_accepted_as_a_login_link() {
        // The URL is scraped from CLI stdout and handed to the OS browser, so
        // the prefix check is the thing standing between a changed (or
        // tampered) release and opening an unexpected site. A lookalike host
        // must not pass.
        assert!("https://dashboard.composio.dev/?cliKey=abc".starts_with(LOGIN_URL_PREFIX));
        assert!(
            !"https://dashboard.composio.dev.evil.test/?cliKey=abc".starts_with(LOGIN_URL_PREFIX)
        );
        assert!(!"http://dashboard.composio.dev/?cliKey=abc".starts_with(LOGIN_URL_PREFIX));
        // A bare host has no trailing slash and is refused too, which is why
        // the constant carries one — it also matches the opener allowlist.
        assert!(!"https://dashboard.composio.dev".starts_with(LOGIN_URL_PREFIX));
    }

    #[test]
    fn connecting_an_app_uses_its_own_host() {
        // Measured: `link` returns connect.composio.dev, login returns
        // dashboard.composio.dev. Sharing one constant would refuse every
        // connect link — a dead button with no error.
        assert!("https://connect.composio.dev/link/lk_abc".starts_with(LINK_URL_PREFIX));
        assert!(!"https://connect.composio.dev/link/lk_abc".starts_with(LOGIN_URL_PREFIX));
        assert!(!"https://connect.composio.dev.evil.test/link/x".starts_with(LINK_URL_PREFIX));
    }

    #[test]
    fn only_active_accounts_are_usable() {
        // Captured verbatim from a live account, including both failure states
        // seen there: INITIALIZING (link started, browser half never finished)
        // and EXPIRED (worked once, no longer). Neither may read as usable —
        // but both must still be *listed*, since the detail view cannot offer
        // to fix an account it refuses to show.
        let text = r#"{
            "gmail": [
                {"status": "ACTIVE", "alias": null, "word_id": "gmail_casava-tst"},
                {"status": "EXPIRED", "alias": null, "word_id": "gmail_finale-apium"}
            ],
            "slack": [{"status": "INITIALIZING", "alias": "work", "word_id": "slack_y"}]
        }"#;
        let accounts = parse_accounts(text);
        assert_eq!(accounts.len(), 3, "every account is listed, working or not");
        assert_eq!(
            accounts
                .iter()
                .filter(|account| account.active)
                .map(|account| account.id.as_str())
                .collect::<Vec<_>>(),
            vec!["gmail_casava-tst"],
        );
        assert_eq!(
            accounts.get(2).map(|account| account.alias.as_str()),
            Some("work"),
            "a named account keeps its name"
        );

        // A status Composio adds later must fail closed rather than look
        // usable, which is why this is an equality test and not a denylist.
        let future = parse_accounts(r#"{"gmail":[{"status":"PAUSED","word_id":"g"}]}"#);
        assert_eq!(
            future.first().map(|account| account.active),
            Some(false),
            "an unknown status is not usable"
        );

        // Nothing linked, junk, and an entry with no handle all mean "none":
        // never a crash, never a false green.
        assert!(parse_accounts("{}").is_empty());
        assert!(parse_accounts("not json").is_empty());
        assert!(parse_accounts(r#"{"gmail": []}"#).is_empty());
        assert!(parse_accounts(r#"{"gmail":[{"status":"ACTIVE"}]}"#).is_empty());
    }

    #[test]
    fn a_spilled_result_is_followed_to_its_contents() {
        // The CLI does not return large results: it writes them to a temp file
        // and answers with a pointer. Handing that to a model reads as "it
        // worked and there was nothing there" — confidently wrong, and only
        // visible by running a real fetch.
        let dir = std::env::temp_dir().join(format!("blobbies-spill-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("scratch dir");
        let path = dir.join("out.json");
        std::fs::write(&path, r#"{"messages":[{"subject":"Security alert"}]}"#).expect("write");

        let pointer = format!(
            r#"{{"successful":true,"storedInFile":true,"outputFilePath":"{}"}}"#,
            path.display()
        );
        assert!(resolve_spill(pointer).contains("Security alert"));

        // An ordinary inline result passes through untouched.
        let inline = r#"{"successful":true,"data":{"messages":[]}}"#.to_owned();
        assert_eq!(resolve_spill(inline.clone()), inline);

        // A pointer to a file that is gone must say so, not hand back a path.
        let missing = r#"{"storedInFile":true,"outputFilePath":"/nope/gone.json"}"#.to_owned();
        assert!(resolve_spill(missing).contains("too large"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_cut_result_says_that_it_was_cut() {
        // Silent truncation reads as a complete answer: deepseek reported "the
        // tool returned only one email" after a two-email fetch was clipped.
        // One Gmail message carries ~16KB of MIME payload, so this is the
        // ordinary case, not an edge one.
        let big = "x".repeat(EXECUTE_OUTPUT_LIMIT + 10);
        let capped = cap_result(big);
        assert!(capped.contains("cut short"), "the model must be told");
        assert!(
            capped.contains("narrower query"),
            "and told what to do about it"
        );

        // Anything that fits is returned byte-for-byte: no note, no noise.
        let small = r#"{"messages":[]}"#.to_owned();
        assert_eq!(cap_result(small.clone()), small);
    }

    #[test]
    fn an_identity_is_read_from_a_real_profile_result() {
        // Captured from `composio execute GMAIL_GET_PROFILE`. The panel showed
        // `gmail_casava-tst` before this — Composio's internal handle, which
        // tells the person who connected the account nothing.
        let real = r#"{"successful":true,"data":{"emailAddress":"someone@gmail.com","messagesTotal":8499},"error":null}"#;
        assert_eq!(identity_from(real), "someone@gmail.com");

        // Best-effort: a failed call, a toolkit with no identity field, and
        // junk all yield nothing, and the caller keeps showing the handle.
        assert_eq!(identity_from(r#"{"successful":false,"data":{}}"#), "");
        assert_eq!(
            identity_from(r#"{"successful":true,"data":{"threadsTotal":3}}"#),
            ""
        );
        assert_eq!(identity_from("not json"), "");
        assert_eq!(
            identity_from(r#"{"successful":true,"data":{"email":"  "}}"#),
            ""
        );
    }

    #[test]
    fn an_account_handle_cannot_smuggle_a_flag() {
        // Reaches argv, so it is shaped-checked like every other such value.
        assert!(is_safe_account("gmail_casava-tst"));
        assert!(!is_safe_account("--account"));
        assert!(!is_safe_account("-x"));
        assert!(!is_safe_account("gmail; ls"));
        assert!(!is_safe_account(""));
    }

    #[test]
    fn a_tool_slug_cannot_smuggle_a_flag() {
        // Model-composed text heading for argv.
        assert!(check_tool_slug("GMAIL_FETCH_EMAILS".to_owned()).is_ok());
        for bad in ["--help", "gmail_fetch", "GMAIL;ls", "", "A B"] {
            assert!(
                check_tool_slug(bad.to_owned()).is_err(),
                "{bad} must be refused"
            );
        }
    }

    #[test]
    fn a_slug_or_alias_cannot_smuggle_a_flag() {
        // Both reach argv. Nothing is interpolated into a shell, but a value
        // shaped like a flag has no business being passed as a name.
        assert!(is_safe_slug("gmail"));
        assert!(is_safe_slug("work_2"));
        assert!(!is_safe_slug("--no-browser"));
        assert!(!is_safe_slug("gmail; rm -rf /"));
        assert!(!is_safe_slug(""));
        assert!(!is_safe_slug(&"x".repeat(65)));
    }

    #[test]
    fn the_login_credential_is_api_key_in_user_data() {
        // Captured from a real completed login. The previous version of this
        // test asserted `apiKey` in `config.json` — a field that never exists —
        // so it passed while the app reported "not signed in" forever. Pin the
        // *observed* shape, snake_case and all.
        let signed_in = serde_json::json!({
            "api_key": "ak_live_example_value",
            "base_url": "https://backend.composio.dev",
            "org_id": "ok_example",
        });
        assert!(has_api_key(&signed_in), "a real login is recognised");

        // `config.json`'s actual contents: written on first run, logged in or
        // not. Reading this file is what caused the bug.
        let config_json = serde_json::json!({ "developer": "x", "security": "warn" });
        assert!(
            !has_api_key(&config_json),
            "config.json never proves a login"
        );

        assert!(!has_api_key(&serde_json::json!({ "api_key": "   " })));
        assert!(!has_api_key(&serde_json::json!({ "apiKey": "wrong-case" })));
    }
}
