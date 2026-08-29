//! The clock behind scheduled routines.
//!
//! The scheduler itself lives in the webview (`src/lib/scheduler.ts`), because
//! firing a routine means running a turn — model, tools, transcript — and all
//! of that is TypeScript. But its `setInterval` only ticks while the page is
//! being rendered: closing the window hides it (see `lib.rs`), and a hidden
//! `WKWebView` has its timers throttled or suspended by the OS, so a 7am routine
//! sat there until the window was opened again.
//!
//! So the clock moves out here, onto a plain OS thread that keeps its own time
//! regardless of what the webview is allowed to do, and pokes the page. The
//! page still owns the decision of what is due — this only says "look now".

use std::{thread, time::Duration};

use tauri::{AppHandle, Emitter, Runtime};

/// Emitted on every beat. `src/lib/scheduler.ts` listens and runs one pass.
pub(crate) const TICK_EVENT: &str = "scheduler://tick";

/// How often the page is asked to look for due routines.
///
/// Matches `TICK_MS` in `src/lib/scheduler.ts`, which keeps its own interval as
/// the fallback for a plain browser (`pnpm dev`) where this thread does not
/// exist. Both firing is harmless: a tick that finds nothing due does nothing,
/// and the claim-before-run rule in the scheduler makes a double tick a no-op.
const BEAT: Duration = Duration::from_secs(30);

/// Start the beat. Returns immediately; the thread ends with the process.
pub(crate) fn start<R: Runtime>(app: &AppHandle<R>) {
    let app = app.clone();
    thread::spawn(move || {
        loop {
            thread::sleep(BEAT);
            // A failed emit means the webview is gone (shutting down, or not
            // created yet). Neither is worth ending the beat over — the next
            // one is 30 seconds away.
            let _ = app.emit(TICK_EVENT, ());
        }
    });
}
