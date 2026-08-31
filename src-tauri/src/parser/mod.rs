//! Parses a combat log: mmap the file, split it into newline-aligned
//! chunks, tokenize+intern+store each chunk fully in parallel (zero
//! contention -- each chunk gets its own local intern tables and event
//! store), then merge the chunk results into one global `ParsedData`. See
//! `docs/planning.md` for the overall design and `docs/combat-log-format.md`
//! for the line format this is built against.

pub mod event;
pub mod intern;
pub mod reports;
pub mod tokenizer;

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use memmap2::Mmap;
use rayon::prelude::*;

use event::EventStore;
use intern::InternTables;
use reports::Reports;

/// A fully parsed combat log: interned lookup tables, the columnar event
/// stream, and the derived reports (encounters, deaths, gear) built from
/// them. Immutable once built -- `ParsedLog::data()` only exposes it after
/// parsing finishes.
pub struct ParsedData {
    pub tables: InternTables,
    pub events: EventStore,
    pub reports: Reports,
}

/// A combat log file: its mmap (retained for the log's full lifetime, not
/// just during parsing -- `raw_fields` byte spans need it to stay alive),
/// live progress, and the parsed data once the background job finishes.
pub struct ParsedLog {
    pub path: PathBuf,
    mmap: Mmap,
    progress: Mutex<Progress>,
    data: OnceLock<Arc<ParsedData>>,
}

#[derive(Clone, Copy, Default)]
pub struct Progress {
    pub lines: u64,
    /// 0.0..100.0, based on bytes scanned so far -- there's no way to know
    /// the eventual line count (and thus a true "N of M lines" figure)
    /// until parsing finishes, so this is the honest signal available
    /// while it's running.
    pub percent: f64,
    pub done: bool,
}

impl ParsedLog {
    pub fn progress(&self) -> Progress {
        *self.progress.lock().unwrap()
    }

    /// The parsed tables + event store, once parsing has finished.
    pub fn data(&self) -> Option<&Arc<ParsedData>> {
        self.data.get()
    }
}

/// Chunks are capped at 1MB and (when a file is large enough to want more
/// than one thread's worth of work) sized to roughly filesize/numcpus,
/// whichever is smaller -- more, smaller chunks give rayon's work-stealing
/// scheduler better load balance than exactly-numcpus large ones.
const MAX_CHUNK_BYTES: usize = 1024 * 1024;

/// Opens and mmaps `path`, then starts parsing it on a background thread
/// and returns immediately with a `ParsedLog` -- callers should
/// attach/display it right away rather than waiting for parsing to finish.
/// `on_progress` is called (from whichever thread just updated
/// `progress()`, at most ~10 times/sec, plus once more on completion)
/// whenever the caller should push an update to the UI. It's called
/// concurrently from multiple threads while parsing is in flight, so it
/// must be safe to call from more than one thread at once.
pub fn spawn(
    path: PathBuf,
    on_progress: impl Fn() + Send + Sync + 'static,
) -> std::io::Result<Arc<ParsedLog>> {
    let file = std::fs::File::open(&path)?;
    // SAFETY: mmap is unsound if the file is truncated by another process
    // mid-parse (can trigger a SIGBUS). parseomatic only opens files the
    // user just picked or dropped, and accepting that small risk in
    // exchange for mmap's speed on multi-gigabyte logs matches the
    // approach already chosen in docs/planning.md. The mmap is now kept
    // for the ParsedLog's full lifetime (not just during this function),
    // since raw_fields spans resolve against it on demand.
    let mmap = unsafe { Mmap::map(&file)? };

    let log = Arc::new(ParsedLog {
        path: path.clone(),
        mmap,
        progress: Mutex::new(Progress::default()),
        data: OnceLock::new(),
    });
    let on_progress = Arc::new(on_progress);

    let log_for_thread = log.clone();
    let on_progress_for_thread = on_progress.clone();
    std::thread::spawn(move || {
        let parsed = parse_all(&log_for_thread, &on_progress_for_thread);
        let _ = log_for_thread.data.set(Arc::new(parsed));

        let mut progress = log_for_thread.progress.lock().unwrap();
        progress.percent = 100.0;
        progress.done = true;
        drop(progress);
        on_progress_for_thread();
    });

    Ok(log)
}

/// Parses the whole file: parallel per-chunk tokenize+intern+store, then a
/// sequential merge of the chunk results. The merge is cheap relative to
/// the parallel map phase -- it's proportional to the number of *distinct*
/// units/spells/zones, not to line count, so doing it single-threaded
/// after a fully parallel per-chunk pass is the right tradeoff rather than
/// a more complex parallel tree-reduce.
fn parse_all<F: Fn() + Send + Sync>(log: &Arc<ParsedLog>, on_progress: &Arc<F>) -> ParsedData {
    let data: &[u8] = &log.mmap;
    let total_bytes = data.len() as u64;

    if data.is_empty() {
        return ParsedData {
            tables: InternTables::default(),
            events: EventStore::default(),
            reports: Reports::default(),
        };
    }

    let bytes_done = AtomicU64::new(0);
    let lines_done = AtomicU64::new(0);
    let last_emit = Mutex::new(Instant::now());

    let chunk_results: Vec<(InternTables, EventStore)> = chunk_boundaries(data)
        .par_iter()
        .map(|&(start, end)| {
            let mut tables = InternTables::default();
            let mut store = EventStore::default();
            let mut local_lines: u64 = 0;

            for (line_start, line) in tokenizer::iter_lines(data, start, end) {
                event::parse_line(data, line_start, line, &mut tables, &mut store);
                local_lines += 1;
            }

            let bytes_so_far =
                bytes_done.fetch_add((end - start) as u64, Ordering::Relaxed) + (end - start) as u64;
            let lines_so_far = lines_done.fetch_add(local_lines, Ordering::Relaxed) + local_lines;

            // Throttled, and only one thread reports at a time -- try_lock
            // so the other rayon workers never block on this.
            if let Ok(mut last) = last_emit.try_lock() {
                if last.elapsed() >= Duration::from_millis(100) {
                    let percent = (bytes_so_far as f64 / total_bytes as f64) * 100.0;
                    {
                        let mut progress = log.progress.lock().unwrap();
                        progress.lines = lines_so_far;
                        // Never claim 100% here -- only the final update
                        // (after every chunk completes and the merge below
                        // runs) marks it done.
                        progress.percent = percent.min(99.0);
                    }
                    on_progress();
                    *last = Instant::now();
                }
            }

            (tables, store)
        })
        .collect();

    let mut tables = InternTables::default();
    let mut events = EventStore::default();
    for (chunk_tables, chunk_events) in chunk_results {
        let remap = tables.merge(chunk_tables);
        events.append_remapped(chunk_events, &remap);
    }

    let reports = reports::build_reports(data, &events, &mut tables);

    {
        let mut progress = log.progress.lock().unwrap();
        progress.lines = events.len() as u64;
    }

    ParsedData {
        tables,
        events,
        reports,
    }
}

/// Splits `data` into chunks of roughly `filesize/numcpus` bytes (capped
/// at `MAX_CHUNK_BYTES`), each boundary snapped backward to the nearest
/// newline so no chunk ever splits a line across the boundary.
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
                // fall back to the naive cut; a chunk boundary landing
                // mid-line only matters for correctness if it splits a
                // line's bytes across two chunks, which iter_lines handles
                // by treating each chunk's tail/head as its own (possibly
                // truncated) line rather than stitching across chunks --
                // acceptable for one pathological line in an otherwise
                // newline-dense file, same tradeoff already accepted by
                // the original line-counting implementation.
                None => naive_end,
            }
        };
        boundaries.push((start, end));
        start = end;
    }
    boundaries
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Runs the real parallel mmap+chunk+parse+merge pipeline against the
    /// 547MB real fixture log (gitignored, see .gitignore and
    /// src-tauri/tests/fixtures/) -- the same code path `spawn` uses for a
    /// live app, at production scale. Ignored by default since it needs
    /// that file present; run explicitly with `cargo test -- --ignored
    /// --nocapture` to see line/unit/spell/zone counts and timing.
    #[test]
    #[ignore = "needs the real fixture log; run with `cargo test -- --ignored --nocapture`"]
    fn parses_real_fixture_without_panicking_and_stays_fast() {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/WoWCombatLog-072526_205235.txt");

        let start = Instant::now();
        let log = spawn(path, || {}).expect("mmap+spawn should succeed against a real file");
        while !log.progress().done {
            std::thread::sleep(Duration::from_millis(10));
        }
        let elapsed = start.elapsed();

        let data = log.data().expect("data must be set once progress.done is true");
        println!(
            "parsed {} lines -> {} units, {} spells, {} zones, {} encounters ({} trash), {} deaths, {} combatant snapshots in {:?}",
            data.events.len(),
            data.tables.guids.len(),
            data.tables.spells.len(),
            data.tables.zones.len(),
            data.reports.encounters.len(),
            data.reports.encounters.iter().filter(|e| e.is_trash).count(),
            data.reports.deaths.len(),
            data.reports.combatants.len(),
            elapsed,
        );

        // One row per input line is a hard invariant of parse_line's design
        // (every line -- even unrecognized/malformed -- gets pushed), and
        // wc -l independently confirms this file has exactly this many
        // lines.
        assert_eq!(data.events.len(), 1_809_680);
        assert!(data.tables.guids.len() > 100, "expected hundreds+ of distinct units in a real raid log");
        assert!(data.tables.spells.len() > 100, "expected hundreds+ of distinct spells in a real raid log");
        assert!(data.tables.zones.len() >= 1);
        // The fixture has 7 real ENCOUNTER_START/ENCOUNTER_END pairs
        // (confirmed via grep), all cleanly paired -- no malformed overlap
        // in this particular log -- plus trash spans around/between them.
        let real_encounters = data.reports.encounters.iter().filter(|e| !e.is_trash).count();
        assert_eq!(real_encounters, 7);
        assert_eq!(data.reports.deaths.len(), 163);
        // COMBATANT_INFO doesn't appear in this fixture at all -- confirmed
        // separately, not a bug if this is 0.
        assert_eq!(data.reports.combatants.len(), 0);
        assert!(
            elapsed.as_secs() < 5,
            "parsing 547MB took {elapsed:?} -- expected well under 5s from the parallel single-pass design"
        );
    }
}
