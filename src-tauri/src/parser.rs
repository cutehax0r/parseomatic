//! A super-minimal stand-in for the real parser described in
//! `docs/planning.md`. All it does today is count lines -- but it does so
//! the way the real parser will need to: mmap the file, split it into
//! newline-aligned chunks, and count each chunk in parallel with rayon,
//! so opening a multi-gigabyte log is limited by disk/memory bandwidth,
//! not by per-line overhead. Counting also starts returning a usable
//! result immediately and keeps working in the background, so the UI
//! never blocks on it.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use memmap2::Mmap;
use rayon::prelude::*;

/// A parsed combat log. Currently just a path and a running line count.
/// `progress()` reflects whatever counting has completed so far --
/// callers should read it whenever they want the current state rather
/// than waiting for `spawn`'s background work to finish.
pub struct ParsedLog {
    pub path: PathBuf,
    progress: Mutex<Progress>,
}

#[derive(Clone, Copy, Default)]
pub struct Progress {
    pub lines: u64,
    /// 0.0..100.0, based on bytes scanned so far -- there's no way to know
    /// the eventual line count (and thus a true "N of M lines" figure)
    /// until counting finishes, so this is the honest signal available
    /// while it's running.
    pub percent: f64,
    pub done: bool,
}

impl ParsedLog {
    pub fn progress(&self) -> Progress {
        *self.progress.lock().unwrap()
    }
}

/// Chunks are capped at 1MB and (when a file is large enough to want more
/// than one thread's worth of work) sized to roughly filesize/numcpus,
/// whichever is smaller -- more, smaller chunks give rayon's work-stealing
/// scheduler better load balance than exactly-numcpus large ones.
const MAX_CHUNK_BYTES: usize = 1024 * 1024;

/// Starts counting lines in `path` on a background thread and returns
/// immediately with a `ParsedLog` -- callers should attach/display it
/// right away rather than waiting for counting to finish. `on_progress`
/// is called (from whichever thread just updated `progress()`, at most
/// ~10 times/sec, plus once more on completion) whenever the caller
/// should push an update to the UI. It's called concurrently from
/// multiple threads while counting is in flight, so it must be safe to
/// call from more than one thread at once.
pub fn spawn(
    path: PathBuf,
    on_progress: impl Fn() + Send + Sync + 'static,
) -> Arc<ParsedLog> {
    let log = Arc::new(ParsedLog {
        path: path.clone(),
        progress: Mutex::new(Progress::default()),
    });
    let on_progress = Arc::new(on_progress);

    let log_for_thread = log.clone();
    let on_progress_for_thread = on_progress.clone();
    std::thread::spawn(move || {
        let lines = count_lines(&path, &log_for_thread, &on_progress_for_thread).unwrap_or(0);

        let mut progress = log_for_thread.progress.lock().unwrap();
        progress.lines = lines;
        progress.percent = 100.0;
        progress.done = true;
        drop(progress);
        on_progress_for_thread();
    });

    log
}

fn count_lines<F: Fn() + Send + Sync>(
    path: &Path,
    log: &Arc<ParsedLog>,
    on_progress: &Arc<F>,
) -> std::io::Result<u64> {
    let file = std::fs::File::open(path)?;
    // SAFETY: mmap is unsound if the file is truncated by another process
    // mid-scan (can trigger a SIGBUS). parseomatic only opens files the
    // user just picked or dropped, and accepting that small risk in
    // exchange for mmap's speed on multi-gigabyte logs matches the
    // approach already chosen in docs/planning.md.
    let mmap = unsafe { Mmap::map(&file)? };
    let data: &[u8] = &mmap;
    let total_bytes = data.len() as u64;

    if data.is_empty() {
        return Ok(0);
    }

    let bytes_done = AtomicU64::new(0);
    let lines_done = AtomicU64::new(0);
    let last_emit = Mutex::new(Instant::now());

    let total: u64 = chunk_boundaries(data)
        .par_iter()
        .map(|&(start, end)| {
            let count = memchr::memchr_iter(b'\n', &data[start..end]).count() as u64;

            let bytes_so_far =
                bytes_done.fetch_add((end - start) as u64, Ordering::Relaxed) + (end - start) as u64;
            let lines_so_far = lines_done.fetch_add(count, Ordering::Relaxed) + count;

            // Throttled, and only one thread reports at a time -- try_lock
            // so the other rayon workers never block on this.
            if let Ok(mut last) = last_emit.try_lock() {
                if last.elapsed() >= Duration::from_millis(100) {
                    let percent = if total_bytes > 0 {
                        (bytes_so_far as f64 / total_bytes as f64) * 100.0
                    } else {
                        0.0
                    };
                    {
                        let mut progress = log.progress.lock().unwrap();
                        progress.lines = lines_so_far;
                        // Never claim 100% here -- only the final update
                        // (after every chunk completes) marks it done.
                        progress.percent = percent.min(99.0);
                    }
                    on_progress();
                    *last = Instant::now();
                }
            }

            count
        })
        .sum();

    Ok(total)
}

/// Splits `data` into chunks of roughly `filesize/numcpus` bytes (capped
/// at `MAX_CHUNK_BYTES`), each boundary snapped backward to the nearest
/// newline so no chunk ever splits a line across the boundary -- matching
/// docs/planning.md's chunking approach, ready to reuse once real
/// per-line parsing (not just counting) needs whole lines per chunk.
fn chunk_boundaries(data: &[u8]) -> Vec<(usize, usize)> {
    let len = data.len();
    let num_cpus = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(1);
    let naive = (len / num_cpus.max(1)).max(1);
    let chunk_size = naive.min(MAX_CHUNK_BYTES).max(1);

    let mut boundaries = Vec::new();
    let mut start = 0usize;
    while start < len {
        let naive_end = (start + chunk_size).min(len);
        let end = if naive_end >= len {
            len
        } else {
            match data[start..naive_end].iter().rposition(|&b| b == b'\n') {
                Some(rel_pos) => start + rel_pos + 1,
                // No newline anywhere in this stretch (one huge line) --
                // fall back to the naive cut; correctness of the line
                // *count* doesn't depend on chunk boundaries lining up
                // with newlines, only future per-line parsing would care.
                None => naive_end,
            }
        };
        boundaries.push((start, end));
        start = end;
    }
    boundaries
}
