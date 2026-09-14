use tauri::WebviewWindow;

use crate::parser::intern::{NO_SPELL, NO_UNIT};
use crate::query;
use crate::window::current_log;

/// Carries raw intern ids rather than resolved name/GUID strings -- the
/// frontend already holds the full unit/spell tables from `log_lists`
/// (fetched once per log, kept in memory), and those ids are dense and
/// 0-indexed, i.e. exactly the array index into that payload's
/// `units`/`spells` lists. Resolving here would mean re-cloning the same
/// handful of player/pet names on every scroll tick, including ones
/// already scrolled past (see docs/performance-concerns.md #4).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RawEventRow {
    row: usize,
    timestamp_ms: i64,
    kind: String,
    source_unit_id: Option<u32>,
    target_unit_id: Option<u32>,
    spell_id: Option<u16>,
    position: Option<(f32, f32)>,
    /// `(currentHp, maxHp)` for whichever unit the row's advanced block
    /// describes (`EventStore::pos_unit`) -- the encounter-config "health
    /// threshold" trigger's per-unit HP time series
    /// (`src/encounters/evaluate.ts`).
    health: Option<(i64, i64)>,
    /// `(currentPower, maxPower)`, same idea as `health` but for the
    /// encounter-config "power threshold" trigger. Less trustworthy than
    /// `health` -- see `EventStore::current_power`'s doc comment.
    power: Option<(i64, i64)>,
    details: String,
}

/// Total row count for the window's current log, once parsing has
/// finished -- lets the raw view size its virtual-scroll spacer without
/// fetching any rows.
#[tauri::command]
pub(crate) fn raw_event_count(window: WebviewWindow) -> Option<usize> {
    let log = current_log(&window)?;
    Some(log.data()?.events.len())
}

/// A page of raw events (`start..start+count`, clamped to the event
/// count), in file order, for the raw view's virtual scroller -- never
/// the whole event store at once, which for a multi-million-line log
/// would be an enormous IPC payload. Unlike `log_lists`, this returns
/// raw intern ids rather than resolved strings (see `RawEventRow`), so
/// there's no per-row table lookup or string cloning here at all -- just
/// array indexing into the columnar `EventStore`.
fn raw_event_row(events: &crate::parser::event::EventStore, mmap: &[u8], row: usize) -> RawEventRow {
    let details = events
        .raw_fields(row)
        .iter()
        .map(|f| f.resolve_str(mmap))
        .collect::<Vec<_>>()
        .join(", ");
    RawEventRow {
        row,
        timestamp_ms: events.timestamp_ms[row],
        kind: events.kind[row].label(),
        source_unit_id: (events.source_unit[row] != NO_UNIT).then_some(events.source_unit[row]),
        target_unit_id: (events.dest_unit[row] != NO_UNIT).then_some(events.dest_unit[row]),
        spell_id: (events.spell[row] != NO_SPELL).then_some(events.spell[row]),
        position: (!events.pos_x[row].is_nan()).then_some((events.pos_x[row], events.pos_y[row])),
        health: (events.current_hp[row] >= 0).then_some((events.current_hp[row], events.max_hp[row])),
        power: (events.current_power[row] >= 0).then_some((events.current_power[row], events.max_power[row])),
        details,
    }
}

#[tauri::command]
pub(crate) fn raw_events(window: WebviewWindow, start: usize, count: usize) -> Option<Vec<RawEventRow>> {
    let log = current_log(&window)?;
    let data = log.data()?;
    let mmap = log.mmap_bytes();
    let events = &data.events;

    let end = (start + count).min(events.len());
    if start >= end {
        return Some(Vec::new());
    }
    Some((start..end).map(|row| raw_event_row(events, mmap, row)).collect())
}

/// Generic query over the parsed event stream -- see `query.rs` and
/// `docs/ui-widgets.md` ("Data access"). Aggregated mode returns one JSON
/// object per `groupBy` tuple; raw mode returns `RawEventRow`s for the
/// window (honoring `where` + `limit`/`offset`).
#[tauri::command]
pub(crate) fn query_events(window: WebviewWindow, spec: query::QuerySpec) -> Option<serde_json::Value> {
    let log = current_log(&window)?;
    let data = log.data()?;
    let events = &data.events;
    let tables = &data.tables;

    if spec.is_aggregated() {
        return Some(serde_json::Value::Array(query::run_aggregate(&spec, events, tables)));
    }

    let mmap = log.mmap_bytes();
    let (lo, hi, keep) = query::raw_window(&spec, events, tables);
    let offset = spec.offset.unwrap_or(0);
    let limit = spec.limit.unwrap_or(usize::MAX);
    let rows: Vec<RawEventRow> = (lo..hi)
        .filter(|&row| keep(row))
        .skip(offset)
        .take(limit)
        .map(|row| raw_event_row(events, mmap, row))
        .collect();
    serde_json::to_value(rows).ok()
}
