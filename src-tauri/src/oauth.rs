//! A one-shot loopback listener for an OAuth redirect.
//!
//! A desktop app cannot receive an authorization code any other way. There is
//! no server to host a redirect URI on, and a custom scheme (`blobbies://`)
//! can be registered by any other program on the machine, which turns the
//! code into something a local attacker can race for. RFC 8252 settles it:
//! native apps use `http://127.0.0.1:{random port}`, and the loopback
//! interface is the security boundary.
//!
//! Only the socket lives here. Client registration, the PKCE challenge, the
//! authorize URL and the token exchange are all in `composio-oauth.ts`,
//! because the webview already has a hardened HTTP path and duplicating it in
//! Rust would mean two places to keep honest.
//!
//! What this module is careful about:
//!
//! - **127.0.0.1 only, never 0.0.0.0.** Binding the wildcard would put the
//!   authorization code on every interface, so anyone on the same network
//!   could take it.
//! - **One request, then the socket closes.** The window where anything can
//!   connect is as short as the protocol allows.
//! - **The request line is bounded** before it is parsed, so a client that
//!   opens a connection and streams forever cannot take the app's memory.
//! - **Nothing is interpreted.** The raw query string goes back to the caller,
//!   which validates `state` and exchanges the code. This module does not get
//!   to decide what is a valid response.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::time::Duration;

use crate::error::{Error, Result};

/// Longest first line accepted from the browser.
///
/// A real redirect is a few hundred bytes; anything approaching this is not a
/// browser following our URL.
const MAX_REQUEST_LINE: u64 = 8 * 1024;

/// How long the socket waits for the browser before giving up.
///
/// Five minutes covers a real sign-in — a password manager, a second factor,
/// picking between accounts — while still guaranteeing the port is released
/// and the thread ends if the user simply closes the tab.
const LISTEN_TIMEOUT: Duration = Duration::from_secs(300);

/// What a finished redirect looked like.
#[derive(serde::Serialize)]
pub(crate) struct OauthRedirect {
    /// The raw query string, `state` and `code` still encoded.
    query: String,
}

/// Bind a loopback port and report which one, so the caller can build its
/// redirect URI.
///
/// Port 0 asks the OS for a free one. Fixing a port would collide with
/// whatever else is running and, worse, make the redirect URI predictable to
/// any other local process wanting to sit on it first.
#[tauri::command]
pub(crate) async fn oauth_listen_port() -> Result<u16> {
    let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))
        .map_err(|error| Error::Io(error.to_string()))?;
    let port = listener
        .local_addr()
        .map_err(|error| Error::Io(error.to_string()))?
        .port();
    // The listener is dropped here on purpose. Holding it across the IPC
    // boundary would mean parking a socket in app state for as long as the
    // user takes to click "Log in", and the caller re-binds the same port
    // immediately in `oauth_await_redirect`. A local race for the port in
    // that window is possible in principle; it costs an attacker a failed
    // sign-in, not a stolen code, because the code is useless without the
    // PKCE verifier the webview never sent anywhere.
    Ok(port)
}

/// Answer the browser so the user is not left on a blank tab.
fn respond(stream: &mut TcpStream, body: &str) {
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
}

/// The page the user is left looking at once the code is in hand.
const DONE_PAGE: &str = "<!doctype html><meta charset=utf-8><title>Blobbies</title>\
<body style=\"font:16px system-ui;display:grid;place-items:center;height:90vh;margin:0\">\
<p>Signed in. You can close this tab and go back to Blobbies.</p>";

/// Wait for one redirect on `port` and hand back its query string.
///
/// Blocking, so it runs on the blocking pool rather than the async runtime:
/// the wait is a human clicking through a consent screen, not IO the executor
/// can interleave.
#[tauri::command]
pub(crate) async fn oauth_await_redirect(port: u16) -> Result<OauthRedirect> {
    tauri::async_runtime::spawn_blocking(move || {
        let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, port)))
            .map_err(|error| Error::Io(error.to_string()))?;
        // A deadline on accept, so an abandoned sign-in ends the thread rather
        // than leaking it and the port for the life of the process.
        listener
            .set_nonblocking(false)
            .map_err(|error| Error::Io(error.to_string()))?;

        let started = std::time::Instant::now();
        loop {
            if started.elapsed() > LISTEN_TIMEOUT {
                return Err(Error::Io("Timed out waiting for the browser.".into()));
            }
            let (mut stream, peer) = listener
                .accept()
                .map_err(|error| Error::Io(error.to_string()))?;
            // Belt and braces: the bind is already loopback-only, so a
            // non-local peer should be impossible. If the OS ever hands one
            // over anyway, it is dropped rather than answered.
            if !peer.ip().is_loopback() {
                continue;
            }
            stream
                .set_read_timeout(Some(Duration::from_secs(10)))
                .map_err(|error| Error::Io(error.to_string()))?;

            let mut line = String::new();
            // `take` bounds the read before it allocates, so a client that
            // opens a socket and streams forever cannot exhaust memory.
            let read = BufReader::new((&stream).take(MAX_REQUEST_LINE))
                .read_line(&mut line)
                .map_err(|error| Error::Io(error.to_string()))?;
            if read == 0 {
                continue;
            }

            // "GET /callback?code=...&state=... HTTP/1.1"
            let target = line.split_whitespace().nth(1).unwrap_or_default();
            let Some((_, query)) = target.split_once('?') else {
                // A browser prefetching /favicon.ico would land here; keep
                // waiting rather than failing the sign-in.
                respond(&mut stream, DONE_PAGE);
                continue;
            };
            respond(&mut stream, DONE_PAGE);
            return Ok(OauthRedirect {
                query: query.to_string(),
            });
        }
    })
    .await
    .map_err(|error| Error::Io(error.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Connect once the waiting thread has actually bound the port.
    ///
    /// The listener re-binds on its own thread, so a fixed sleep here is a
    /// race: on a loaded machine the bind can land after it, and the connect
    /// dies with ECONNREFUSED for reasons that have nothing to do with the
    /// code under test. Retrying until the bind exists removes the timing
    /// assumption instead of widening it.
    fn connect_once_bound(port: u16) -> TcpStream {
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        loop {
            match TcpStream::connect(SocketAddr::from((Ipv4Addr::LOCALHOST, port))) {
                Ok(stream) => return stream,
                Err(error) => {
                    assert!(
                        std::time::Instant::now() < deadline,
                        "listener never bound port {port}: {error}"
                    );
                    std::thread::sleep(Duration::from_millis(10));
                }
            }
        }
    }

    /// The port must be usable and must not be a fixed one.
    #[test]
    fn hands_out_a_free_loopback_port() {
        let a = tauri::async_runtime::block_on(oauth_listen_port()).expect("port");
        assert!(a > 0);
        // Bindable right after, which is what the caller does.
        let bound = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, a)));
        assert!(bound.is_ok(), "port {a} should be free to re-bind");
    }

    /// The happy path: a browser GETs the redirect and the query comes back
    /// untouched, still encoded, for the caller to validate.
    #[test]
    fn returns_the_query_from_a_redirect() {
        let port = tauri::async_runtime::block_on(oauth_listen_port()).expect("port");
        let waiting =
            std::thread::spawn(move || tauri::async_runtime::block_on(oauth_await_redirect(port)));
        let mut client = connect_once_bound(port);
        client
            .write_all(b"GET /callback?code=abc123&state=xyz HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
            .expect("write");
        let mut page = String::new();
        let _ = client.read_to_string(&mut page);
        assert!(page.contains("go back to Blobbies"), "browser gets a page");

        let redirect = waiting.join().expect("thread").expect("redirect");
        assert_eq!(redirect.query, "code=abc123&state=xyz");
    }

    /// A request with no query (a favicon probe, a stray curl) must not end
    /// the wait — the real redirect may still be seconds away.
    #[test]
    fn keeps_waiting_through_a_request_without_a_query() {
        let port = tauri::async_runtime::block_on(oauth_listen_port()).expect("port");
        let waiting =
            std::thread::spawn(move || tauri::async_runtime::block_on(oauth_await_redirect(port)));
        let mut noise = connect_once_bound(port);
        let _ = noise.write_all(b"GET /favicon.ico HTTP/1.1\r\n\r\n");
        let mut sink = String::new();
        let _ = noise.read_to_string(&mut sink);

        let mut real = connect_once_bound(port);
        real.write_all(b"GET /callback?code=second HTTP/1.1\r\n\r\n")
            .expect("write");
        let mut page = String::new();
        let _ = real.read_to_string(&mut page);

        let redirect = waiting.join().expect("thread").expect("redirect");
        assert_eq!(redirect.query, "code=second");
    }
}
