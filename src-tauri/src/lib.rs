mod acp;
mod capture;
mod commands;
mod error;
mod home;
mod media;
mod notifications;
mod oauth;
mod ocr;
mod secrets;
mod shell;
mod skills;
mod store;
mod textutil;
mod tray;

pub use error::Error;

/// Build and run the Tauri application.
///
/// # Panics
/// Panics if the webview runtime cannot be initialised, which is unrecoverable.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
#[expect(
    clippy::expect_used,
    reason = "there is no UI left to report into if the webview runtime fails to start"
)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_notification::init())
        // Updater: checks this repo's GitHub Releases for a newer version and
        // installs it in place. Process: relaunches the app after an update.
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            commands::greet,
            commands::ollama_installed,
            commands::ollama_start,
            commands::host_is_public,
            shell::shell_allowed,
            shell::shell_run,
            store::store_read,
            store::store_write,
            store::channels_read,
            store::channels_write,
            store::store_delete_blob,
            store::store_list_blobs,
            store::store_export_blob,
            home::blob_home_list,
            home::blob_home_read,
            home::blob_home_write,
            home::blob_home_delete,
            ocr::ocr_image,
            capture::capture_list_windows,
            capture::capture_take,
            notifications::request_notification_permission,
            notifications::send_notification,
            oauth::oauth_listen_port,
            oauth::oauth_await_redirect,
            secrets::secret_get,
            secrets::secret_set,
            secrets::secret_delete,
            skills::skills_list,
            skills::skills_save,
            media::ffmpeg_present,
            media::media_info,
            media::media_clip,
            media::media_audio,
            acp::acp_start,
            acp::acp_stop,
            acp::acp_send,
            acp::acp_close,
            acp::acp_relay_path
        ])
        .setup(|app| {
            store::startup_maintenance(app.handle());
            skills::seed_bundled(app.handle());
            // Best-effort: an app with no tray icon is a smaller failure than
            // no app at all, and every tray action has an equivalent inside
            // the window.
            if let Err(error) = tray::init(app.handle()) {
                eprintln!("could not create the tray icon: {error}");
            }
            Ok(())
        });

    // macOS only, both of them: this exists to route ⌘Q through Tauri's own
    // exit, and elsewhere Tauri gives a window no menu bar at all. Attaching
    // one everywhere would hang a File/Edit/View strip across the top of the
    // Windows and Linux builds that nobody asked for.
    #[cfg(target_os = "macos")]
    let builder = builder.menu(tray::app_menu).on_menu_event(|app, event| {
        if event.id().as_ref() == tray::APP_QUIT_ID {
            app.exit(0);
        }
    });

    builder
        // Closing the window puts Blobbies in the tray rather than ending it:
        // routines run on a schedule and finished runs raise notifications, so
        // a red X that killed the process would silently switch those off.
        // Quitting — ⌘Q, the dock's Quit, the tray's Quit Blobbies — is the way
        // out, and really does end the process.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event
                && window.label() == "main"
            {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| match event {
            // Clicking the dock icon of a running-but-windowless app has to put
            // the window back: after a close the app is still there, and the
            // tray icon should not be the only way to find it again.
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => tray::show_main_window(app),
            // Release the model's memory (weights + KV-cache snapshots, gigabytes)
            // as soon as the app closes, instead of waiting out keep_alive.
            tauri::RunEvent::Exit => {
                // The ACP token names a port that dies with this process;
                // leaving it on disk only invites a stale editor to retry.
                acp::acp_stop();
                commands::ollama_unload_on_exit(app);
            }
            _ => {}
        });
}
