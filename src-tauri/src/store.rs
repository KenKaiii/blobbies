//! Versioned JSON slice storage under the app data directory.
//!
//! One JSON file per slice, each wrapped as `{"schemaVersion": N, "value": …}`.
//! All writes are atomic (tmp file + rename) and every path is validated
//! against an allowlist before touching the filesystem, so the webview can
//! never escape the data root or invent new files.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};

/// Newest slice schema this build understands.
const SCHEMA_VERSION: u64 = 1;

/// Upper bound on any slice file we are willing to read (bytes).
const MAX_SLICE_BYTES: u64 = 8 * 1024 * 1024;

/// Trash entries older than this are purged on startup (30 days).
const TRASH_TTL_MS: u128 = 30 * 24 * 60 * 60 * 1000;

/// Wire format for every slice file.
#[derive(Debug, Serialize, Deserialize)]
struct Slice {
    #[serde(rename = "schemaVersion")]
    schema_version: u64,
    value: serde_json::Value,
}

/// Marker dropped into a trashed Blob directory.
#[derive(Debug, Serialize, Deserialize)]
struct TrashMarker {
    #[serde(rename = "deletedAt")]
    deleted_at_ms: u128,
}

/// Slices that live at the data root. `user` holds memories shared by every
/// Blob (per-Blob memories live in that Blob's `config`); `groups` holds the
/// group-chat list (names and ids only — transcripts are their own slices);
/// `acp` is the editor bridge's on/off state, deliberately its own slice so a
/// half-written settings blob can never switch it on.
///
/// This list is the frontend's contract: `lib/store.ts` names these keys, and
/// a key it uses but this array omits is rejected at the IPC boundary — the
/// read rejects, the startup `Promise.all` that hydrates roster, settings and
/// groups rejects with it, and the app comes up empty. Adding a slice means
/// adding it here in the same change (`store.test.ts` fails the drift).
const ROOT_SLICES: [&str; 7] = [
    "settings",
    "ui-layout",
    "roster",
    "user",
    "groups",
    "acp",
    // Unsent composer text, keyed by conversation. Its own slice rather than
    // part of a transcript: a keystroke must never rewrite a conversation.
    "drafts",
];

/// Slices that live inside a Blob directory. `recap` is the rolling summary of
/// the conversation's compacted head (see `lib/recap.ts`).
const BLOB_SLICES: [&str; 5] = ["config", "routines", "transcript", "runs", "recap"];

/// Slices that live inside a group-chat directory.
const GROUP_SLICES: [&str; 2] = ["transcript", "recap"];

/// Slices that live inside a channel directory (the Labs successor to group
/// chats; same shape, so transcripts and recaps key identically).
const CHANNEL_SLICES: [&str; 2] = ["transcript", "recap"];

/// True for `transcript-1`, `transcript-2`, … — the sealed older halves of a
/// long conversation.
///
/// A conversation is rewritten in full on every save, so one ever-growing
/// slice makes each keystroke cost more than the last (measured: 14ms and 8MB
/// of disk per save at 7,000 messages, 83ms and 64MB at 55,000) and finally
/// trips `MAX_SLICE_BYTES`, at which point nothing saves at all. Rolling the
/// old messages into numbered slices keeps the live one small and cheap;
/// archives are written once and never touched again.
///
/// Deliberately not a general pattern: digits only, no separators, and a
/// length bound, so this widens the allowlist by exactly one shape and cannot
/// express a traversal.
fn is_transcript_archive(slice: &str) -> bool {
    slice.strip_prefix("transcript-").is_some_and(|number| {
        !number.is_empty()
            && number.len() <= 6
            && number.bytes().all(|byte| byte.is_ascii_digit())
            && !number.starts_with('0')
    })
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis())
        .unwrap_or_default()
}

/// True when `id` looks like a hyphenated UUID (lowercase hex, 8-4-4-4-12).
/// Group ids are minted the same way and validated with this too.
fn is_valid_blob_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    bytes.iter().enumerate().all(|(index, byte)| match index {
        8 | 13 | 18 | 23 => *byte == b'-',
        _ => byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase(),
    })
}

/// Resolve a slice key to its on-disk path, rejecting anything not on the
/// allowlist. Keys are `<root-slice>`, `blobs/<uuid>/<blob-slice>` or
/// `groups/<uuid>/<group-slice>`, or
/// `channels/<uuid>/threads/<message-uuid>/<channel-slice>`.
fn resolve_slice_path(data_root: &Path, key: &str) -> Result<PathBuf> {
    if ROOT_SLICES.contains(&key) {
        return Ok(data_root.join(format!("{key}.json")));
    }
    if let Some(rest) = key.strip_prefix("blobs/")
        && let Some((id, slice)) = rest.split_once('/')
        && is_valid_blob_id(id)
        && (BLOB_SLICES.contains(&slice) || is_transcript_archive(slice))
    {
        return Ok(data_root
            .join("blobs")
            .join(id)
            .join(format!("{slice}.json")));
    }
    if let Some(rest) = key.strip_prefix("groups/")
        && let Some((id, slice)) = rest.split_once('/')
        && is_valid_blob_id(id)
        && (GROUP_SLICES.contains(&slice) || is_transcript_archive(slice))
    {
        return Ok(data_root
            .join("groups")
            .join(id)
            .join(format!("{slice}.json")));
    }
    if let Some(rest) = key.strip_prefix("channels/")
        && let Some((id, slice)) = rest.split_once('/')
        && is_valid_blob_id(id)
    {
        if CHANNEL_SLICES.contains(&slice) || is_transcript_archive(slice) {
            return Ok(data_root
                .join("channels")
                .join(id)
                .join(format!("{slice}.json")));
        }
        if let Some(thread) = slice.strip_prefix("threads/")
            && let Some((message_id, thread_slice)) = thread.split_once('/')
            && is_valid_blob_id(message_id)
            && (CHANNEL_SLICES.contains(&thread_slice) || is_transcript_archive(thread_slice))
        {
            return Ok(data_root
                .join("channels")
                .join(id)
                .join("threads")
                .join(message_id)
                .join(format!("{thread_slice}.json")));
        }
    }
    Err(Error::InvalidSliceKey)
}

/// Read and validate a slice file. `Ok(None)` when it does not exist yet.
fn read_slice_file(path: &Path) -> Result<Option<serde_json::Value>> {
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(Error::Io(error.to_string())),
    };
    if metadata.len() > MAX_SLICE_BYTES {
        return Err(Error::SliceTooLarge);
    }
    let raw = fs::read(path).map_err(|error| Error::Io(error.to_string()))?;
    let slice: Slice =
        serde_json::from_slice(&raw).map_err(|error| Error::Corrupt(error.to_string()))?;
    if slice.schema_version > SCHEMA_VERSION {
        return Err(Error::SchemaTooNew {
            found: slice.schema_version,
            supported: SCHEMA_VERSION,
        });
    }
    Ok(Some(slice.value))
}

/// Atomically write a slice file: serialize to `<path>.tmp`, fsync, rename.
fn write_slice_file(path: &Path, value: serde_json::Value) -> Result<()> {
    let parent = path.parent().ok_or(Error::InvalidSliceKey)?;
    fs::create_dir_all(parent).map_err(|error| Error::Io(error.to_string()))?;

    let slice = Slice {
        schema_version: SCHEMA_VERSION,
        value,
    };
    let serialized =
        serde_json::to_vec_pretty(&slice).map_err(|error| Error::Corrupt(error.to_string()))?;
    // A slice too big to read back must never be written: `read_slice_file`
    // refuses anything over MAX_SLICE_BYTES, so writing it anyway would leave a
    // transcript that can never load again — and the next save, starting from
    // the now-empty state, would overwrite it and take the whole conversation
    // with it. Refusing here keeps the last good file on disk: the newest
    // change is not persisted, everything before it still is.
    if serialized.len() as u64 > MAX_SLICE_BYTES {
        return Err(Error::SliceTooLarge);
    }

    let tmp = path.with_extension("json.tmp");
    {
        let mut file = fs::File::create(&tmp).map_err(|error| Error::Io(error.to_string()))?;
        file.write_all(&serialized)
            .and_then(|()| file.sync_all())
            .map_err(|error| Error::Io(error.to_string()))?;
    }
    fs::rename(&tmp, path).map_err(|error| Error::Io(error.to_string()))
}

/// Move a Blob directory into the trash with a deletion timestamp.
fn delete_blob_dir(data_root: &Path, id: &str) -> Result<()> {
    if !is_valid_blob_id(id) {
        return Err(Error::InvalidSliceKey);
    }
    let source = data_root.join("blobs").join(id);
    if !source.is_dir() {
        return Err(Error::BlobNotFound);
    }
    let trash_root = data_root.join("trash");
    fs::create_dir_all(&trash_root).map_err(|error| Error::Io(error.to_string()))?;
    let target = trash_root.join(id);
    if target.exists() {
        // Re-deleting the same id: replace the stale trash entry.
        fs::remove_dir_all(&target).map_err(|error| Error::Io(error.to_string()))?;
    }
    fs::rename(&source, &target).map_err(|error| Error::Io(error.to_string()))?;

    let marker = TrashMarker {
        deleted_at_ms: now_ms(),
    };
    let serialized =
        serde_json::to_vec_pretty(&marker).map_err(|error| Error::Corrupt(error.to_string()))?;
    fs::write(target.join("deleted.json"), serialized).map_err(|error| Error::Io(error.to_string()))
}

/// Remove trash entries older than [`TRASH_TTL_MS`]. Best-effort: errors on
/// individual entries are ignored so one bad dir can't block startup.
fn purge_trash_dir(data_root: &Path) {
    let trash_root = data_root.join("trash");
    let Ok(entries) = fs::read_dir(&trash_root) else {
        return;
    };
    let now = now_ms();
    for entry in entries.flatten() {
        let dir = entry.path();
        let marker_path = dir.join("deleted.json");
        let expired = fs::read(&marker_path)
            .ok()
            .and_then(|raw| serde_json::from_slice::<TrashMarker>(&raw).ok())
            .is_none_or(|marker| now.saturating_sub(marker.deleted_at_ms) > TRASH_TTL_MS);
        if expired {
            let _ = fs::remove_dir_all(&dir);
        }
    }
}

/// List ids of all live (non-trashed) Blob directories.
fn list_blob_ids(data_root: &Path) -> Vec<String> {
    let Ok(entries) = fs::read_dir(data_root.join("blobs")) else {
        return Vec::new();
    };
    let mut ids: Vec<String> = entries
        .flatten()
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|name| is_valid_blob_id(name))
        .collect();
    ids.sort();
    ids
}

/// Everything the user owns lives here: rosters, chats, per-Blob home
/// folders. A visible dotfolder in `$HOME` rather than
/// `~/Library/Application Support/<bundle id>/` so the answer to "where is my
/// data" is one path the user can type, back up, sync or delete without
/// knowing the bundle identifier — and so it survives a rename of the app.
///
/// Pure: every store read and write resolves through here, so it stays a
/// path lookup with no filesystem side effects. The one-time migration below
/// runs from `startup_maintenance` instead.
pub(crate) fn data_root(app: &tauri::AppHandle) -> Result<PathBuf> {
    use tauri::Manager;
    app.path()
        .home_dir()
        .map(|dir| dir.join(".blobbies"))
        .map_err(|error| Error::Io(error.to_string()))
}

/// Bring a pre-`~/.blobbies` install across, once, at startup.
///
/// Copy, never move: the legacy tree is left untouched on disk, so a failure
/// halfway (full disk, permissions) costs the user nothing and the old data
/// is still there to retry from. An already-present root is what makes this
/// once — without that check a user who deleted something would find it
/// restored on the next launch.
fn migrate_legacy_root(app: &tauri::AppHandle, root: &Path) {
    use tauri::Manager;
    if root.exists() {
        return;
    }
    // Derived from the bundle identifier, which is why that identifier is not
    // free to change: renaming it moves this directory, and a user still
    // holding pre-`~/.blobbies` data under the old name would find nothing to
    // migrate — chats that look deleted while sitting safely on disk.
    let Ok(legacy) = app.path().app_data_dir().map(|dir| dir.join("data")) else {
        return;
    };
    if !legacy.is_dir() {
        return;
    }
    // Into a staging path first, renamed into place at the end: an interrupted
    // copy must not leave a half-populated `~/.blobbies` that the check above
    // would then treat as a finished migration.
    let staging = root.with_extension("migrating");
    let _ = fs::remove_dir_all(&staging);
    if copy_dir(&legacy, &staging).is_ok() {
        let _ = fs::rename(&staging, root);
    } else {
        let _ = fs::remove_dir_all(&staging);
    }
}

/// Recursive directory copy; files only, no symlink following.
pub(crate) fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        // `file_type` does not follow symlinks, so a link inside the legacy
        // tree is skipped rather than copied through to somewhere else.
        let kind = entry.file_type()?;
        if kind.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else if kind.is_file() {
            fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

/// How many date-stamped backup directories to keep; older ones are pruned.
const BACKUP_DIRS_TO_KEEP: usize = 5;

/// A migration step: takes the slice's `value` at version `n + 1` (1-based,
/// index `n` in a slice's migration table) and returns the value at version
/// `n + 2`. Ordered — the runner applies them in sequence until the slice
/// reaches the slice's latest version.
type SliceMigration = fn(serde_json::Value) -> std::result::Result<serde_json::Value, String>;

/// The three slices added by the agent-army work. Each carries its own
/// `schemaVersion` and its own migration table so they can evolve
/// independently of the legacy root slices above.
pub(crate) mod slice_names {
    pub(crate) const CHANNELS: &str = "channels.json";
    pub(crate) const PROJECTS: &str = "projects.json";
    pub(crate) const WORKFLOWS: &str = "workflows.json";
}

/// Every versioned slice is currently at schema 1, so the migration tables
/// are empty — but the runner below is exercised by tests with a fake table
/// so the machinery is proven before any real migration exists.
const CHANNELS_LATEST: u32 = 1;
const PROJECTS_LATEST: u32 = 1;
const WORKFLOWS_LATEST: u32 = 1;
const NO_MIGRATIONS: &[SliceMigration] = &[];

/// Typed payloads for the three new slices. Empty vec-backed for now; concrete
/// element types arrive in later steps.
pub(crate) type Channels = Vec<serde_json::Value>;
pub(crate) type Projects = Vec<serde_json::Value>;
pub(crate) type Workflows = Vec<serde_json::Value>;

/// Apply ordered migrations to a slice's value until it reaches `latest`.
/// Migration `i` in the table upgrades version `i + 1` to `i + 2`.
///
/// A version newer than `latest` is refused with an error naming the file —
/// the file is from a newer build and must never be silently dropped or
/// rewritten by this one.
fn run_slice_migrations(
    file: &str,
    mut value: serde_json::Value,
    found: u32,
    latest: u32,
    migrations: &[SliceMigration],
) -> Result<serde_json::Value> {
    if found > latest {
        return Err(Error::SliceSchemaTooNew {
            file: file.to_owned(),
            found,
            supported: latest,
        });
    }
    if found == 0 || found == latest {
        return Ok(value);
    }
    let needed = (latest - found) as usize;
    let start = (found - 1) as usize;
    if start + needed > migrations.len() {
        return Err(Error::Corrupt(format!(
            "{file}: no migration from schema {found} to {latest}"
        )));
    }
    for step in &migrations[start..start + needed] {
        value = step(value).map_err(Error::Corrupt)?;
    }
    Ok(value)
}

/// Today's date as `YYYY-MM-DD` (UTC), used to date-stamp backup dirs.
fn today_utc() -> String {
    let secs = u64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|elapsed| elapsed.as_secs())
            .unwrap_or_default(),
    )
    .unwrap_or_default();
    // Civil-from-days (Howard Hinnant's algorithm); no chrono dependency needed.
    let days = (secs / 86_400) as i64;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { year + 1 } else { year };
    format!("{year:04}-{month:02}-{day:02}")
}

/// Copy a slice file to `backups/<YYYY-MM-DD>/<file>` before migrating it,
/// atomically (temp file + rename), so the pre-migration bytes survive even a
/// crash mid-migration. Never touches the original.
fn backup_before_migration(data_root: &Path, slice_path: &Path, file: &str) -> Result<PathBuf> {
    let dir = data_root.join("backups").join(today_utc());
    fs::create_dir_all(&dir).map_err(|error| Error::Io(error.to_string()))?;
    // Same-day second migration: never clobber the earlier backup.
    let mut target = dir.join(file);
    for attempt in 1.. {
        if !target.exists() {
            break;
        }
        target = dir.join(file.replace(".json", &format!("-{attempt}.json")));
    }
    let tmp = target.with_extension("json.tmp");
    fs::copy(slice_path, &tmp).map_err(|error| Error::Io(error.to_string()))?;
    fs::rename(&tmp, &target).map_err(|error| Error::Io(error.to_string()))?;
    Ok(target)
}

/// Keep only the [`BACKUP_DIRS_TO_KEEP`] most recent date-stamped backup dirs.
/// Best-effort: individual failures are ignored, like the trash purge.
fn prune_backup_dirs(data_root: &Path) {
    let Ok(entries) = fs::read_dir(data_root.join("backups")) else {
        return;
    };
    let mut dated: Vec<String> = entries
        .flatten()
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|name| {
            name.len() == 10
                && name.as_bytes()[4] == b'-'
                && name.as_bytes()[7] == b'-'
                && name
                    .bytes()
                    .enumerate()
                    .all(|(index, byte)| index == 4 || index == 7 || byte.is_ascii_digit())
        })
        .collect();
    dated.sort(); // ISO dates sort chronologically as text.
    let excess = dated.len().saturating_sub(BACKUP_DIRS_TO_KEEP);
    for name in &dated[..excess] {
        let _ = fs::remove_dir_all(data_root.join("backups").join(name));
    }
}

/// Atomically write a versioned slice file (`{schemaVersion, value}` wrapper).
fn write_versioned_slice(
    path: &Path,
    schema_version: u32,
    value: &serde_json::Value,
) -> Result<()> {
    let payload = serde_json::json!({ "schemaVersion": schema_version, "value": value });
    let serialized =
        serde_json::to_vec_pretty(&payload).map_err(|error| Error::Corrupt(error.to_string()))?;
    if serialized.len() as u64 > MAX_SLICE_BYTES {
        return Err(Error::SliceTooLarge);
    }
    let parent = path.parent().ok_or(Error::InvalidSliceKey)?;
    fs::create_dir_all(parent).map_err(|error| Error::Io(error.to_string()))?;
    let tmp = path.with_extension("json.tmp");
    {
        let mut file = fs::File::create(&tmp).map_err(|error| Error::Io(error.to_string()))?;
        file.write_all(&serialized)
            .and_then(|()| file.sync_all())
            .map_err(|error| Error::Io(error.to_string()))?;
    }
    fs::rename(&tmp, path).map_err(|error| Error::Io(error.to_string()))
}

/// Load a versioned slice: `Ok(None)` when the file does not exist yet;
/// migrate (backing up first) when its schemaVersion is behind; refuse with an
/// error naming the file when it is ahead. The original file is left readable
/// unless the migrated version has been written successfully.
fn load_versioned_slice(
    data_root: &Path,
    file: &str,
    latest: u32,
    migrations: &[SliceMigration],
) -> Result<Option<serde_json::Value>> {
    let path = data_root.join(file);
    let metadata = match fs::metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(Error::Io(error.to_string())),
    };
    if metadata.len() > MAX_SLICE_BYTES {
        return Err(Error::SliceTooLarge);
    }
    let raw = fs::read(&path).map_err(|error| Error::Io(error.to_string()))?;
    let slice: Slice =
        serde_json::from_slice(&raw).map_err(|error| Error::Corrupt(error.to_string()))?;
    let found = u32::try_from(slice.schema_version).map_err(|_| Error::SliceSchemaTooNew {
        file: file.to_owned(),
        found: u32::MAX,
        supported: latest,
    })?;
    if found > latest {
        return Err(Error::SliceSchemaTooNew {
            file: file.to_owned(),
            found,
            supported: latest,
        });
    }
    if found == latest {
        return Ok(Some(slice.value));
    }
    backup_before_migration(data_root, &path, file)?;
    let migrated = run_slice_migrations(file, slice.value, found, latest, migrations)?;
    write_versioned_slice(&path, latest, &migrated)?;
    prune_backup_dirs(data_root);
    Ok(Some(migrated))
}

pub(crate) fn load_channels(data_root: &Path) -> Result<Option<Channels>> {
    Ok(load_versioned_slice(
        data_root,
        slice_names::CHANNELS,
        CHANNELS_LATEST,
        NO_MIGRATIONS,
    )?
    .map(|value| serde_json::from_value(value).unwrap_or_default()))
}

pub(crate) fn save_channels(data_root: &Path, channels: &Channels) -> Result<()> {
    let value =
        serde_json::to_value(channels).map_err(|error| Error::Corrupt(error.to_string()))?;
    write_versioned_slice(
        &data_root.join(slice_names::CHANNELS),
        CHANNELS_LATEST,
        &value,
    )
}

pub(crate) fn load_projects(data_root: &Path) -> Result<Option<Projects>> {
    Ok(load_versioned_slice(
        data_root,
        slice_names::PROJECTS,
        PROJECTS_LATEST,
        NO_MIGRATIONS,
    )?
    .map(|value| serde_json::from_value(value).unwrap_or_default()))
}

pub(crate) fn save_projects(data_root: &Path, projects: &Projects) -> Result<()> {
    let value =
        serde_json::to_value(projects).map_err(|error| Error::Corrupt(error.to_string()))?;
    write_versioned_slice(
        &data_root.join(slice_names::PROJECTS),
        PROJECTS_LATEST,
        &value,
    )
}

pub(crate) fn load_workflows(data_root: &Path) -> Result<Option<Workflows>> {
    Ok(load_versioned_slice(
        data_root,
        slice_names::WORKFLOWS,
        WORKFLOWS_LATEST,
        NO_MIGRATIONS,
    )?
    .map(|value| serde_json::from_value(value).unwrap_or_default()))
}

pub(crate) fn save_workflows(data_root: &Path, workflows: &Workflows) -> Result<()> {
    let value =
        serde_json::to_value(workflows).map_err(|error| Error::Corrupt(error.to_string()))?;
    write_versioned_slice(
        &data_root.join(slice_names::WORKFLOWS),
        WORKFLOWS_LATEST,
        &value,
    )
}

/// Migrate a legacy data root, then purge expired trash. Once, from `run()`,
/// before any command can touch the store.
pub(crate) fn startup_maintenance(app: &tauri::AppHandle) {
    if let Ok(root) = data_root(app) {
        migrate_legacy_root(app, &root);
        purge_trash_dir(&root);
        prune_backup_dirs(&root);
    }
}

#[tauri::command]
#[expect(
    clippy::needless_pass_by_value,
    reason = "tauri commands must take AppHandle by value"
)]
pub(crate) fn store_read(app: tauri::AppHandle, key: &str) -> Result<Option<serde_json::Value>> {
    let root = data_root(&app)?;
    read_slice_file(&resolve_slice_path(&root, key)?)
}

#[tauri::command]
#[expect(
    clippy::needless_pass_by_value,
    reason = "tauri commands must take AppHandle by value"
)]
pub(crate) fn store_write(
    app: tauri::AppHandle,
    key: &str,
    value: serde_json::Value,
) -> Result<()> {
    let root = data_root(&app)?;
    write_slice_file(&resolve_slice_path(&root, key)?, value)
}

#[tauri::command]
#[expect(
    clippy::needless_pass_by_value,
    reason = "tauri commands must take AppHandle by value"
)]
pub(crate) fn store_delete_blob(app: tauri::AppHandle, id: &str) -> Result<()> {
    let root = data_root(&app)?;
    delete_blob_dir(&root, id)
}

#[tauri::command]
#[expect(
    clippy::needless_pass_by_value,
    reason = "tauri commands must take AppHandle by value"
)]
pub(crate) fn store_list_blobs(app: tauri::AppHandle) -> Result<Vec<String>> {
    let root = data_root(&app)?;
    Ok(list_blob_ids(&root))
}

/// The channel list (a versioned slice, unlike the legacy root slices — see
/// `slice_names`). Dedicated commands rather than `store_read`/`store_write`,
/// because the versioned wrapper means the file is not a bare slice.
#[tauri::command]
#[expect(
    clippy::needless_pass_by_value,
    reason = "tauri commands must take AppHandle by value"
)]
pub(crate) fn channels_read(app: tauri::AppHandle) -> Result<Option<Channels>> {
    let root = data_root(&app)?;
    load_channels(&root)
}

#[tauri::command]
#[expect(
    clippy::needless_pass_by_value,
    reason = "tauri commands must take AppHandle by value"
)]
pub(crate) fn channels_write(app: tauri::AppHandle, channels: Channels) -> Result<()> {
    let root = data_root(&app)?;
    save_channels(&root, &channels)
}

/// Characters allowed in the filename built from a Blob's name.
///
/// The name is user-supplied and lands in a path, so it is filtered to an
/// allowlist rather than checked for the separators we happen to think of.
fn safe_file_stem(name: &str) -> String {
    let stem: String = name
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    let trimmed = stem.trim_matches('-');
    if trimmed.is_empty() {
        "blob".to_owned()
    } else {
        trimmed.chars().take(40).collect()
    }
}

/// Collect every slice a Blob owns into one JSON object.
///
/// Home-folder *files* are not included: they are already plain files the
/// user can see in Finder, and inlining them would turn a readable export
/// into a base64 blob. Their location is named in the bundle instead.
///
/// Split out from the command so it can be tested without an `AppHandle`.
fn build_export_bundle(root: &Path, id: &str) -> Result<serde_json::Value> {
    if !is_valid_blob_id(id) {
        return Err(Error::InvalidSliceKey);
    }
    let mut bundle = serde_json::Map::new();
    bundle.insert("exportedAt".to_owned(), now_ms().to_string().into());
    bundle.insert("blobId".to_owned(), id.into());
    bundle.insert(
        "homeFolder".to_owned(),
        root.join("blobs")
            .join(id)
            .join("home")
            .to_string_lossy()
            .into_owned()
            .into(),
    );
    for slice in BLOB_SLICES {
        let path = resolve_slice_path(root, &format!("blobs/{id}/{slice}"))?;
        // A slice the Blob never wrote exports as null rather than being
        // absent, so the shape of the file does not depend on its history.
        bundle.insert(
            slice.to_owned(),
            read_slice_file(&path)?.unwrap_or(serde_json::Value::Null),
        );
    }
    // Sealed older halves of a long conversation. Enumerated from disk rather
    // than from a fixed list because their count grows with the conversation;
    // without this an export of a long chat would quietly contain only its
    // most recent messages, which is the data loss this whole mechanism
    // exists to prevent.
    for (index, archive) in transcript_archives(root, id)?.into_iter().enumerate() {
        bundle.insert(
            format!("transcript-{}", index + 1),
            read_slice_file(&archive)?.unwrap_or(serde_json::Value::Null),
        );
    }
    Ok(serde_json::Value::Object(bundle))
}

/// Every `transcript-<n>.json` a Blob owns, ordered oldest first.
///
/// Ordered by the number itself, not by filename: `transcript-10` sorts before
/// `transcript-9` as text, which would interleave a conversation's history.
fn transcript_archives(root: &Path, id: &str) -> Result<Vec<PathBuf>> {
    let dir = root.join("blobs").join(id);
    let mut found: Vec<(u32, PathBuf)> = Vec::new();
    let entries = match fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(Error::Io(error.to_string())),
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(stem) = name.to_str().and_then(|name| name.strip_suffix(".json")) else {
            continue;
        };
        if !is_transcript_archive(stem) {
            continue;
        }
        if let Some(number) = stem
            .strip_prefix("transcript-")
            .and_then(|number| number.parse::<u32>().ok())
        {
            found.push((number, entry.path()));
        }
    }
    found.sort_by_key(|(number, _)| *number);
    Ok(found.into_iter().map(|(_, path)| path).collect())
}

/// Where an export lands: a filtered stem plus a fixed suffix, inside
/// `downloads`. Errors if the result would sit anywhere else.
fn export_target(downloads: &Path, name: &str) -> Result<PathBuf> {
    let target = downloads.join(format!(
        "blobbies-{}-{}.json",
        safe_file_stem(name),
        now_ms()
    ));
    // Belt and braces: `safe_file_stem` already strips separators, so this
    // can only fire if that guarantee is ever weakened.
    if target.parent() != Some(downloads) {
        return Err(Error::InvalidSliceKey);
    }
    Ok(target)
}

/// Bundle every slice a Blob owns into one JSON file in Downloads.
#[tauri::command]
#[expect(
    clippy::needless_pass_by_value,
    reason = "tauri commands must take AppHandle by value"
)]
pub(crate) fn store_export_blob(app: tauri::AppHandle, id: &str, name: &str) -> Result<PathBuf> {
    use tauri::Manager;

    let root = data_root(&app)?;
    let bundle = build_export_bundle(&root, id)?;
    let downloads = app
        .path()
        .download_dir()
        .map_err(|error| Error::Io(error.to_string()))?;
    let target = export_target(&downloads, name)?;
    let serialized =
        serde_json::to_vec_pretty(&bundle).map_err(|error| Error::Corrupt(error.to_string()))?;
    fs::write(&target, serialized).map_err(|error| Error::Io(error.to_string()))?;
    Ok(target)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(name: &str) -> PathBuf {
        let dir = std::env::temp_dir()
            .join("blobbies-store-tests")
            .join(format!("{name}-{}", now_ms()));
        fs::create_dir_all(&dir).unwrap_or_else(|_| panic!("create temp dir"));
        dir
    }

    const BLOB_ID: &str = "61ec34f1-9ba5-4eff-b8e1-7acefb2148ea";

    #[test]
    fn resolves_root_and_blob_slices() {
        let root = Path::new("/data");
        assert!(resolve_slice_path(root, "roster").is_ok());
        assert!(resolve_slice_path(root, "user").is_ok());
        assert!(resolve_slice_path(root, &format!("blobs/{BLOB_ID}/config")).is_ok());
        assert!(resolve_slice_path(root, &format!("blobs/{BLOB_ID}/runs")).is_ok());
        assert!(resolve_slice_path(root, "groups").is_ok());
        assert!(resolve_slice_path(root, &format!("groups/{BLOB_ID}/transcript")).is_ok());
        // Conversation recaps, for a Blob's own chat and for a group's.
        assert!(resolve_slice_path(root, &format!("blobs/{BLOB_ID}/recap")).is_ok());
        assert!(resolve_slice_path(root, &format!("groups/{BLOB_ID}/recap")).is_ok());
        // Sealed halves of a long conversation, for Blobs and groups alike.
        assert_eq!(
            resolve_slice_path(root, &format!("blobs/{BLOB_ID}/transcript-1"))
                .unwrap_or_else(|_| panic!("archive")),
            root.join("blobs").join(BLOB_ID).join("transcript-1.json")
        );
        assert!(resolve_slice_path(root, &format!("blobs/{BLOB_ID}/transcript-42")).is_ok());
        assert!(resolve_slice_path(root, &format!("groups/{BLOB_ID}/transcript-7")).is_ok());
        // Channels key exactly like groups, under their own root.
        assert!(resolve_slice_path(root, &format!("channels/{BLOB_ID}/transcript")).is_ok());
        assert!(resolve_slice_path(root, &format!("channels/{BLOB_ID}/recap")).is_ok());
        assert!(resolve_slice_path(root, &format!("channels/{BLOB_ID}/transcript-3")).is_ok());
        let message_id = "9f1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d";
        assert_eq!(
            resolve_slice_path(
                root,
                &format!("channels/{BLOB_ID}/threads/{message_id}/transcript")
            )
            .unwrap_or_else(|_| panic!("thread")),
            root.join("channels")
                .join(BLOB_ID)
                .join("threads")
                .join(message_id)
                .join("transcript.json")
        );
        assert!(
            resolve_slice_path(
                root,
                &format!("channels/{BLOB_ID}/threads/{message_id}/recap")
            )
            .is_ok()
        );
    }

    #[test]
    fn copies_the_legacy_tree_without_touching_it() {
        let base = temp_root("migrate");
        let legacy = base.join("legacy");
        fs::create_dir_all(legacy.join("blobs").join(BLOB_ID)).expect("legacy tree");
        fs::write(legacy.join("roster.json"), b"[]").expect("roster");
        fs::write(
            legacy.join("blobs").join(BLOB_ID).join("config.json"),
            b"{}",
        )
        .expect("config");

        let root = base.join("new");
        let staging = root.with_extension("migrating");
        copy_dir(&legacy, &staging).expect("copy");
        fs::rename(&staging, &root).expect("rename into place");

        // Every file arrived...
        assert_eq!(
            fs::read(root.join("roster.json")).expect("new roster"),
            b"[]"
        );
        assert!(
            root.join("blobs")
                .join(BLOB_ID)
                .join("config.json")
                .is_file()
        );
        // ...and the old copy is still there to fall back on.
        assert!(legacy.join("roster.json").is_file());
        assert!(!staging.exists());
    }

    #[test]
    fn accepts_every_root_slice_the_app_writes() {
        // The `acp` slice shipped with the editor bridge but never reached this
        // allowlist, so every launch rejected `store_read("acp")` — an
        // unhandled "unknown storage slice" that took the whole startup
        // hydration down with it.
        let root = Path::new("/data");
        for key in ROOT_SLICES {
            assert_eq!(
                resolve_slice_path(root, key).ok(),
                Some(root.join(format!("{key}.json"))),
                "expected {key} to resolve"
            );
        }
    }

    #[test]
    fn rejects_traversal_and_unknown_keys() {
        let root = Path::new("/data");
        for key in [
            "../roster",
            "settings/../../etc/passwd",
            "blobs/../evil/config",
            "blobs/not-a-uuid/config",
            &format!("blobs/{BLOB_ID}/unknown"),
            &format!("groups/{BLOB_ID}/config"),
            "groups/not-a-uuid/transcript",
            "groups/../evil/transcript",
            &format!("channels/{BLOB_ID}/config"),
            "channels/not-a-uuid/transcript",
            &format!("channels/{BLOB_ID}/threads/not-a-uuid/transcript"),
            &format!("channels/{BLOB_ID}/threads/../transcript"),
            &format!("channels/{BLOB_ID}/threads/{BLOB_ID}/unknown"),
            &format!("channels/{BLOB_ID}/threads/{BLOB_ID}/transcript/../../evil"),
            "unknown",
            "users",
            "user/x",
            "",
            // The archive suffix widens the allowlist by one shape, and only
            // that shape: anything else wearing the prefix stays out.
            &format!("blobs/{BLOB_ID}/transcript-"),
            &format!("blobs/{BLOB_ID}/transcript-0"),
            &format!("blobs/{BLOB_ID}/transcript-01"),
            &format!("blobs/{BLOB_ID}/transcript-1x"),
            &format!("blobs/{BLOB_ID}/transcript-1.1"),
            &format!("blobs/{BLOB_ID}/transcript-9999999"),
            &format!("blobs/{BLOB_ID}/transcript-1/../../evil"),
            &format!("blobs/{BLOB_ID}/routines-1"),
        ] {
            assert!(
                matches!(resolve_slice_path(root, key), Err(Error::InvalidSliceKey)),
                "expected rejection for {key:?}"
            );
        }
    }

    #[test]
    fn export_file_stem_cannot_escape_its_directory() {
        // The Blob name is user-supplied and ends up in a path.
        for name in [
            "../../etc/passwd",
            "..",
            "/absolute",
            "C:\\windows",
            "a/b\\c",
            "name\u{0}with-nul",
        ] {
            let stem = safe_file_stem(name);
            let joined = Path::new("/downloads").join(format!("blobbies-{stem}-1.json"));
            assert_eq!(
                joined.parent(),
                Some(Path::new("/downloads")),
                "escaped for {name:?}"
            );
            assert!(!stem.contains(['/', '\\', '.']), "unsafe stem for {name:?}");
        }
        assert_eq!(safe_file_stem("Ken's Coach"), "ken-s-coach");
        // A name with nothing usable still yields a filename.
        assert_eq!(safe_file_stem("???"), "blob");
        assert!(safe_file_stem(&"x".repeat(500)).len() <= 40);
    }

    #[test]
    fn export_bundle_carries_every_slice_the_blob_owns() {
        let root = temp_root("export-bundle");
        let write = |slice: &str, value: serde_json::Value| {
            let path = resolve_slice_path(&root, &format!("blobs/{BLOB_ID}/{slice}"))
                .unwrap_or_else(|_| panic!("path"));
            write_slice_file(&path, value).unwrap_or_else(|_| panic!("write"));
        };
        // Two of the four slices written; the export must still describe all
        // four, so the file's shape does not depend on what the Blob did.
        write("config", serde_json::json!({ "name": "Ken" }));
        write(
            "routines",
            serde_json::json!([{ "id": "r1", "name": "Morning" }]),
        );

        let bundle = build_export_bundle(&root, BLOB_ID).unwrap_or_else(|_| panic!("bundle"));
        let at = |pointer: &str| bundle.pointer(pointer).cloned().unwrap_or_default();
        assert_eq!(at("/blobId"), serde_json::json!(BLOB_ID));
        assert_eq!(at("/config/name"), serde_json::json!("Ken"));
        assert_eq!(at("/routines/0/name"), serde_json::json!("Morning"));
        // Never written, so exported as null rather than missing.
        assert_eq!(at("/transcript"), serde_json::Value::Null);
        assert_eq!(at("/runs"), serde_json::Value::Null);
        // Files are left on disk; the bundle only points at them.
        assert!(
            at("/homeFolder")
                .as_str()
                .unwrap_or_default()
                .ends_with("home")
        );
        // Secrets live in the keychain and settings are app-wide: neither is
        // a per-Blob slice, so neither can ride along in an exported file.
        assert!(bundle.get("settings").is_none());
    }

    #[test]
    fn export_carries_the_archived_half_of_a_long_conversation() {
        // The archives hold everything older than the last few hundred
        // messages, so an export that skipped them would hand the user their
        // most recent chat and call it their history.
        let root = temp_root("export-archives");
        let write = |slice: &str, value: serde_json::Value| {
            let path = resolve_slice_path(&root, &format!("blobs/{BLOB_ID}/{slice}"))
                .unwrap_or_else(|_| panic!("path"));
            write_slice_file(&path, value).unwrap_or_else(|_| panic!("write"));
        };
        // Written out of order, and past ten, so text sorting would interleave
        // them: `transcript-10` precedes `transcript-9` as a string.
        write("transcript-10", serde_json::json!([{ "id": "tenth" }]));
        write("transcript-1", serde_json::json!([{ "id": "first" }]));
        write("transcript-9", serde_json::json!([{ "id": "ninth" }]));
        write("transcript", serde_json::json!([{ "id": "live" }]));

        let bundle = build_export_bundle(&root, BLOB_ID).unwrap_or_else(|_| panic!("bundle"));
        let at = |pointer: &str| bundle.pointer(pointer).cloned().unwrap_or_default();
        // Renumbered densely in age order, whatever the files were called.
        assert_eq!(at("/transcript-1/0/id"), serde_json::json!("first"));
        assert_eq!(at("/transcript-2/0/id"), serde_json::json!("ninth"));
        assert_eq!(at("/transcript-3/0/id"), serde_json::json!("tenth"));
        assert_eq!(at("/transcript/0/id"), serde_json::json!("live"));
    }

    #[test]
    fn export_rejects_a_blob_id_that_is_not_a_uuid() {
        let root = temp_root("export-id");
        for id in ["../../etc", "not-a-uuid", ""] {
            assert!(build_export_bundle(&root, id).is_err(), "accepted {id:?}");
        }
    }

    #[test]
    fn export_target_stays_inside_downloads() {
        let downloads = Path::new("/downloads");
        for name in ["Ken", "../../etc/passwd", "/absolute", ".."] {
            let target = export_target(downloads, name).unwrap_or_else(|_| panic!("target"));
            assert_eq!(target.parent(), Some(downloads), "escaped for {name:?}");
            assert_eq!(
                target.extension().and_then(|value| value.to_str()),
                Some("json")
            );
        }
    }

    #[test]
    fn write_then_read_round_trips() {
        let root = temp_root("round-trip");
        let path = resolve_slice_path(&root, "roster").unwrap_or_else(|_| panic!("path"));
        let value = serde_json::json!({ "rows": [{ "id": BLOB_ID, "name": "Ken" }] });
        write_slice_file(&path, value.clone()).unwrap_or_else(|_| panic!("write"));
        let read = read_slice_file(&path).unwrap_or_else(|_| panic!("read"));
        assert_eq!(read, Some(value));
    }

    #[test]
    fn an_oversized_write_is_refused_and_the_old_file_survives() {
        let root = temp_root("size-cap");
        let path = resolve_slice_path(&root, "roster").unwrap_or_else(|_| panic!("path"));
        let good = serde_json::json!({ "rows": [] });
        write_slice_file(&path, good.clone()).unwrap_or_else(|_| panic!("write"));

        // Past the cap once serialized pretty (the wrapper adds bytes, so pad
        // well beyond it).
        let huge = serde_json::json!({
            "rows": [],
            "pad": "x".repeat(usize::try_from(MAX_SLICE_BYTES).unwrap_or(usize::MAX) + 64),
        });
        let refused = write_slice_file(&path, huge).expect_err("must refuse");
        assert!(matches!(refused, Error::SliceTooLarge), "got: {refused}");

        // The load side still works and still holds the last good value — this
        // pair is the whole point of the write-side cap. Without it, the file
        // would be written, every future read would fail with SliceTooLarge,
        // and the next save from the (empty) loaded state would destroy it.
        let read = read_slice_file(&path).unwrap_or_else(|_| panic!("read"));
        assert_eq!(read, Some(good));
    }

    #[test]
    fn missing_slice_reads_as_none() {
        let root = temp_root("missing");
        let path = resolve_slice_path(&root, "settings").unwrap_or_else(|_| panic!("path"));
        assert_eq!(
            read_slice_file(&path).unwrap_or_else(|_| panic!("read")),
            None
        );
    }

    #[test]
    fn rejects_newer_schema_without_overwrite() {
        let root = temp_root("schema");
        let path = root.join("settings.json");
        fs::write(&path, br#"{"schemaVersion": 99, "value": {}}"#)
            .unwrap_or_else(|_| panic!("seed"));
        assert!(matches!(
            read_slice_file(&path),
            Err(Error::SchemaTooNew { found: 99, .. })
        ));
    }

    #[test]
    fn rejects_corrupt_json() {
        let root = temp_root("corrupt");
        let path = root.join("roster.json");
        fs::write(&path, b"not json").unwrap_or_else(|_| panic!("seed"));
        assert!(matches!(read_slice_file(&path), Err(Error::Corrupt(_))));
    }

    #[test]
    fn delete_moves_to_trash_and_purge_removes_expired() {
        let root = temp_root("delete");
        let config = resolve_slice_path(&root, &format!("blobs/{BLOB_ID}/config"))
            .unwrap_or_else(|_| panic!("path"));
        write_slice_file(&config, serde_json::json!({ "name": "Ken" }))
            .unwrap_or_else(|_| panic!("write"));

        delete_blob_dir(&root, BLOB_ID).unwrap_or_else(|_| panic!("delete"));
        assert!(!root.join("blobs").join(BLOB_ID).exists());
        let trashed = root.join("trash").join(BLOB_ID);
        assert!(trashed.join("config.json").exists());
        assert!(trashed.join("deleted.json").exists());

        // Fresh marker: purge keeps it.
        purge_trash_dir(&root);
        assert!(trashed.exists());

        // Expired marker: purge removes it.
        let marker = TrashMarker {
            deleted_at_ms: now_ms().saturating_sub(TRASH_TTL_MS + 1),
        };
        fs::write(
            trashed.join("deleted.json"),
            serde_json::to_vec(&marker).unwrap_or_else(|_| panic!("serialize")),
        )
        .unwrap_or_else(|_| panic!("seed marker"));
        purge_trash_dir(&root);
        assert!(!trashed.exists());
    }

    #[test]
    fn deleting_missing_blob_errors() {
        let root = temp_root("delete-missing");
        assert!(matches!(
            delete_blob_dir(&root, BLOB_ID),
            Err(Error::BlobNotFound)
        ));
    }

    #[test]
    fn lists_only_valid_blob_dirs() {
        let root = temp_root("list");
        let config = resolve_slice_path(&root, &format!("blobs/{BLOB_ID}/config"))
            .unwrap_or_else(|_| panic!("path"));
        write_slice_file(&config, serde_json::json!({})).unwrap_or_else(|_| panic!("write"));
        fs::create_dir_all(root.join("blobs").join("junk")).unwrap_or_else(|_| panic!("junk"));
        assert_eq!(list_blob_ids(&root), vec![BLOB_ID.to_owned()]);
    }

    #[test]
    fn blob_id_validation() {
        assert!(is_valid_blob_id(BLOB_ID));
        assert!(!is_valid_blob_id("61EC34F1-9BA5-4EFF-B8E1-7ACEFB2148EA"));
        assert!(!is_valid_blob_id("../../../etc"));
        assert!(!is_valid_blob_id("61ec34f19ba54effb8e17acefb2148ea"));
    }

    // A stand-in migration (v1 value -> v2 value) so the runner can be
    // exercised before any real migration exists.
    fn test_v1_to_v2(value: serde_json::Value) -> std::result::Result<serde_json::Value, String> {
        let mut object = value.as_object().cloned().unwrap_or_default();
        object.insert("migratedTo".to_owned(), 2.into());
        Ok(serde_json::Value::Object(object))
    }

    #[test]
    fn migrates_v1_data_and_writes_the_new_version_back() {
        let root = temp_root("slice-migrate");
        fs::write(
            root.join(slice_names::CHANNELS),
            br#"{"schemaVersion": 1, "value": {"rows": []}}"#,
        )
        .unwrap_or_else(|_| panic!("seed"));

        let loaded = load_versioned_slice(
            &root,
            slice_names::CHANNELS,
            2,
            &[test_v1_to_v2 as SliceMigration],
        )
        .unwrap_or_else(|_| panic!("load"));
        let value = loaded.expect("some");
        assert_eq!(value.pointer("/migratedTo"), Some(&serde_json::json!(2)));
        assert_eq!(value.pointer("/rows"), Some(&serde_json::json!([])));

        // The migrated file now carries the new version, so a second load is
        // a plain read with no further backup.
        let raw: Slice = serde_json::from_slice(
            &fs::read(root.join(slice_names::CHANNELS)).unwrap_or_else(|_| panic!("re-read")),
        )
        .unwrap_or_else(|_| panic!("parse"));
        assert_eq!(raw.schema_version, 2);
    }

    #[test]
    fn migration_leaves_a_backup_of_the_original_bytes() {
        let root = temp_root("slice-backup");
        let original = br#"{"schemaVersion": 1, "value": {"keep": true}}"#;
        fs::write(root.join(slice_names::PROJECTS), original).unwrap_or_else(|_| panic!("seed"));

        load_versioned_slice(
            &root,
            slice_names::PROJECTS,
            2,
            &[test_v1_to_v2 as SliceMigration],
        )
        .unwrap_or_else(|_| panic!("load"));

        let today = today_utc();
        let backup = root
            .join("backups")
            .join(&today)
            .join(slice_names::PROJECTS);
        assert_eq!(
            fs::read(&backup).unwrap_or_else(|_| panic!("backup exists")),
            original.to_vec()
        );
    }

    #[test]
    fn a_failed_migration_leaves_the_original_readable() {
        let root = temp_root("slice-failed-migration");
        fs::write(
            root.join(slice_names::WORKFLOWS),
            br#"{"schemaVersion": 1, "value": {}}"#,
        )
        .unwrap_or_else(|_| panic!("seed"));

        // Table promises v1 -> v3 but is empty: the runner must refuse rather
        // than guess, and the file must still be readable as-is.
        let refused =
            load_versioned_slice(&root, slice_names::WORKFLOWS, 3, &[]).expect_err("must refuse");
        assert!(matches!(refused, Error::Corrupt(_)), "got: {refused}");
        let raw: Slice = serde_json::from_slice(
            &fs::read(root.join(slice_names::WORKFLOWS)).unwrap_or_else(|_| panic!("re-read")),
        )
        .unwrap_or_else(|_| panic!("parse"));
        assert_eq!(raw.schema_version, 1);
    }

    #[test]
    fn a_newer_schema_is_refused_and_the_file_is_untouched() {
        let root = temp_root("slice-too-new");
        let original = br#"{"schemaVersion": 99, "value": {"future": true}}"#;
        let path = root.join(slice_names::CHANNELS);
        fs::write(&path, original).unwrap_or_else(|_| panic!("seed"));

        let refused = load_channels(&root).expect_err("must refuse");
        assert!(
            matches!(
                &refused,
                Error::SliceSchemaTooNew { file, found: 99, .. }
                    if file == slice_names::CHANNELS
            ),
            "got: {refused}"
        );
        // Not rewritten, not backed up, still readable.
        assert_eq!(
            fs::read(&path).unwrap_or_else(|_| panic!("untouched")),
            original.to_vec()
        );
        assert!(!root.join("backups").exists());
    }

    #[test]
    fn retention_keeps_only_the_five_most_recent_backup_days() {
        let root = temp_root("slice-retention");
        for day in [
            "2020-01-01",
            "2021-01-01",
            "2022-01-01",
            "2023-01-01",
            "2024-01-01",
            "2025-01-01",
        ] {
            fs::create_dir_all(root.join("backups").join(day))
                .unwrap_or_else(|_| panic!("backup dir {day}"));
            fs::write(
                root.join("backups").join(day).join(slice_names::CHANNELS),
                b"{}",
            )
            .unwrap_or_else(|_| panic!("seed {day}"));
        }

        prune_backup_dirs(&root);

        assert!(!root.join("backups").join("2020-01-01").exists());
        for day in ["2021-01-01", "2025-01-01"] {
            assert!(root.join("backups").join(day).is_dir(), "pruned {day}");
        }
    }

    #[test]
    fn typed_load_save_round_trips_and_missing_reads_as_none() {
        let root = temp_root("slice-typed");
        assert_eq!(
            load_channels(&root).unwrap_or_else(|_| panic!("load")),
            None
        );
        assert_eq!(
            load_projects(&root).unwrap_or_else(|_| panic!("load")),
            None
        );
        assert_eq!(
            load_workflows(&root).unwrap_or_else(|_| panic!("load")),
            None
        );

        let channels: Channels = vec![serde_json::json!({ "id": "c1" })];
        save_channels(&root, &channels).unwrap_or_else(|_| panic!("save"));
        assert_eq!(
            load_channels(&root).unwrap_or_else(|_| panic!("reload")),
            Some(channels)
        );

        let raw: Slice = serde_json::from_slice(
            &fs::read(root.join(slice_names::CHANNELS)).unwrap_or_else(|_| panic!("read")),
        )
        .unwrap_or_else(|_| panic!("parse"));
        assert_eq!(raw.schema_version, 1);
    }
}
