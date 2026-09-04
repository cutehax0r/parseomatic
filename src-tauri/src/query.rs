//! The `query_events` aggregate DSL -- see `docs/ui-widgets.md` ("Data
//! access"). Reduces over the columnar `EventStore` in Rust so the IPC
//! payload is proportional to the answer, not the input.
//!
//! Two modes: raw-row (no `aggregate` clauses -- handled in `lib.rs`,
//! which owns `RawEventRow`) and aggregated (this module).

use std::collections::HashMap;

use serde::Deserialize;
use serde_json::{Map, Value};

use crate::parser::event::{EventStore, LineKind, FLAG_AOE, FLAG_CRIT};
use crate::parser::intern::{InternTables, UnitKind, NO_UNIT};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuerySpec {
    pub start_ms: i64,
    pub end_ms: i64,
    #[serde(default, rename = "where")]
    pub where_: Vec<FilterClause>,
    #[serde(default)]
    pub group_by: Vec<Field>,
    #[serde(default)]
    pub aggregate: Vec<AggregateClause>,
    /// When set, the window is split into `count` equal time slices and
    /// the result is one row per slice (`{ tMid, <as cols> }`), dense and
    /// sorted, empty slices zero-filled -- a continuous series for a
    /// chart. Mutually exclusive with `group_by` (bucket wins).
    #[serde(default)]
    pub bucket: Option<Bucket>,
    #[serde(default)]
    pub limit: Option<usize>,
    #[serde(default)]
    pub offset: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bucket {
    pub count: usize,
}

impl QuerySpec {
    pub fn is_aggregated(&self) -> bool {
        !self.aggregate.is_empty()
    }
}

/// The queryable columns. `SourceOwner` resolves a player's pet/guardian
/// to its owner (`guids.get(src).owner_id.unwrap_or(src)`) so pet damage
/// folds into the owning player -- see `docs/ui-widgets.md`,
/// "Per-encounter player rows". `SourceOwnerKind` is that resolved unit's
/// kind (`"Player"` for players and player-owned pets, `"Creature"` for
/// bosses/adds) -- the player-side vs enemy-side split. `SpellId` is the
/// intern-table index, not the WoW spell id (frontend maps via the
/// index-aligned `log_lists`).
#[derive(Deserialize, Clone, Copy, PartialEq, Eq, Hash, Debug)]
#[serde(rename_all = "camelCase")]
pub enum Field {
    Time,
    Kind,
    SourceUnit,
    SourceOwner,
    SourceOwnerKind,
    TargetUnit,
    SpellId,
    HitType,
    Amount,
    Crit,
}

impl Field {
    fn camel(&self) -> &'static str {
        match self {
            Field::Time => "time",
            Field::Kind => "kind",
            Field::SourceUnit => "sourceUnit",
            Field::SourceOwner => "sourceOwner",
            Field::SourceOwnerKind => "sourceOwnerKind",
            Field::TargetUnit => "targetUnit",
            Field::SpellId => "spellId",
            Field::HitType => "hitType",
            Field::Amount => "amount",
            Field::Crit => "crit",
        }
    }
}

#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub enum Op {
    Eq,
    Ne,
    In,
    Lt,
    Lte,
    Gt,
    Gte,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilterClause {
    pub field: Field,
    pub op: Op,
    pub value: Value,
}

#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub enum AggOp {
    Sum,
    Count,
    Avg,
    Min,
    Max,
    Stddev,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AggregateClause {
    pub op: AggOp,
    #[serde(default)]
    pub field: Option<Field>,
    #[serde(rename = "as")]
    pub as_: String,
    /// Per-clause filter, ANDed on top of the query-level `where`. Lets
    /// one scan produce several conditionally-filtered aggregates -- e.g.
    /// `sum amount where kind in DAMAGE` and `... in HEAL` in one pass.
    #[serde(default, rename = "where")]
    pub where_: Vec<FilterClause>,
}

/// A resolved column value for one row -- `Hash`/`Eq` so it can key a
/// group. No float variant: every queryable column is an integer or a
/// short string.
#[derive(Clone, PartialEq, Eq, Hash)]
enum Val {
    Int(i64),
    Str(String),
}

/// The group-by key for one row. Inlined for the 0/1/2-field cases (every
/// real query so far) so the grouped scan doesn't heap-allocate a `Vec`
/// per row -- only per *group* (at emit time), which is bounded by the
/// group count, not the row count. Falls back to `Vec` for 3+ fields.
#[derive(Clone, PartialEq, Eq, Hash)]
enum GroupKey {
    K0,
    K1(Val),
    K2(Val, Val),
    KN(Vec<Val>),
}

impl GroupKey {
    fn build(group_by: &[Field], row: usize, events: &EventStore, tables: &InternTables) -> Self {
        let v = |f: Field| row_value(f, row, events, tables);
        match group_by {
            [] => GroupKey::K0,
            [a] => GroupKey::K1(v(*a)),
            [a, b] => GroupKey::K2(v(*a), v(*b)),
            _ => GroupKey::KN(group_by.iter().map(|f| v(*f)).collect()),
        }
    }

    fn values(&self) -> Vec<&Val> {
        match self {
            GroupKey::K0 => Vec::new(),
            GroupKey::K1(a) => vec![a],
            GroupKey::K2(a, b) => vec![a, b],
            GroupKey::KN(v) => v.iter().collect(),
        }
    }
}

impl Val {
    fn to_json(&self) -> Value {
        match self {
            Val::Int(n) => Value::from(*n),
            Val::Str(s) => Value::from(s.clone()),
        }
    }
    fn as_f64(&self) -> f64 {
        match self {
            Val::Int(n) => *n as f64,
            Val::Str(_) => 0.0,
        }
    }
}

fn row_value(field: Field, row: usize, events: &EventStore, tables: &InternTables) -> Val {
    match field {
        Field::Time => Val::Int(events.timestamp_ms[row]),
        Field::Kind => Val::Str(events.kind[row].label()),
        Field::SourceUnit => Val::Int(unit_id(events.source_unit[row])),
        Field::SourceOwner => Val::Int(
            effective_source(events.source_unit[row], tables)
                .map(|id| id as i64)
                .unwrap_or(-1),
        ),
        Field::SourceOwnerKind => Val::Str(effective_source_kind(row, events, tables).as_str().to_string()),
        Field::TargetUnit => Val::Int(unit_id(events.dest_unit[row])),
        Field::SpellId => Val::Int(events.spell[row] as i64),
        Field::HitType => Val::Str(
            if events.flags[row] & FLAG_AOE != 0 { "AOE" } else { "ST" }.to_string(),
        ),
        Field::Amount => Val::Int(events.amount[row]),
        Field::Crit => Val::Int((events.flags[row] & FLAG_CRIT != 0) as i64),
    }
}

fn unit_id(id: u32) -> i64 {
    if id == NO_UNIT {
        -1
    } else {
        id as i64
    }
}

/// A source unit resolved to its owner (`unwrap_or(self)`), or `None` for
/// `NO_UNIT` -- so a player's pet folds into the player.
fn effective_source(src: u32, tables: &InternTables) -> Option<u32> {
    if src == NO_UNIT {
        None
    } else {
        Some(tables.guids.get(src).owner_id.unwrap_or(src))
    }
}

fn effective_source_kind(row: usize, events: &EventStore, tables: &InternTables) -> UnitKind {
    match effective_source(events.source_unit[row], tables) {
        Some(id) => tables.guids.get(id).kind,
        None => UnitKind::None,
    }
}

fn passes(clause: &FilterClause, row: usize, events: &EventStore, tables: &InternTables) -> bool {
    let v = row_value(clause.field, row, events, tables);
    match clause.op {
        Op::Eq => json_eq(&v, &clause.value),
        Op::Ne => !json_eq(&v, &clause.value),
        Op::In => clause
            .value
            .as_array()
            .map(|arr| arr.iter().any(|item| json_eq(&v, item)))
            .unwrap_or(false),
        Op::Lt => cmp(&v, &clause.value).map(|o| o.is_lt()).unwrap_or(false),
        Op::Lte => cmp(&v, &clause.value).map(|o| o.is_le()).unwrap_or(false),
        Op::Gt => cmp(&v, &clause.value).map(|o| o.is_gt()).unwrap_or(false),
        Op::Gte => cmp(&v, &clause.value).map(|o| o.is_ge()).unwrap_or(false),
    }
}

fn json_eq(v: &Val, j: &Value) -> bool {
    match v {
        Val::Int(n) => j.as_i64() == Some(*n),
        Val::Str(s) => j.as_str() == Some(s.as_str()),
    }
}

fn cmp(v: &Val, j: &Value) -> Option<std::cmp::Ordering> {
    match v {
        Val::Int(n) => j.as_i64().map(|x| n.cmp(&x)),
        Val::Str(s) => j.as_str().map(|x| s.as_str().cmp(x)),
    }
}

/// A `where` clause pre-processed for the scan. `Field::Kind` and
/// `Field::SourceOwnerKind` with `eq`/`in` are the hot cases -- their
/// string value(s) are resolved to enums once here, so the per-row check
/// is a slice compare with no allocation or string parsing (see
/// `performance-concerns.md` #9). Everything else stays on the generic
/// `passes` path.
enum Compiled<'a> {
    KindIn(Vec<LineKind>),
    SourceKindIn(Vec<UnitKind>),
    Generic(&'a FilterClause),
}

fn as_str_list<T>(v: &Value, parse: impl Fn(&str) -> Option<T>) -> Vec<T> {
    v.as_array()
        .map(|a| a.iter().filter_map(|x| x.as_str().and_then(&parse)).collect())
        .unwrap_or_default()
}

fn compile(clauses: &[FilterClause]) -> Vec<Compiled<'_>> {
    clauses
        .iter()
        .map(|c| match (c.field, c.op) {
            (Field::Kind, Op::Eq) => match c.value.as_str().and_then(LineKind::from_label) {
                Some(k) => Compiled::KindIn(vec![k]),
                None => Compiled::Generic(c),
            },
            (Field::Kind, Op::In) => Compiled::KindIn(as_str_list(&c.value, LineKind::from_label)),
            (Field::SourceOwnerKind, Op::Eq) => match c.value.as_str().and_then(UnitKind::from_str) {
                Some(k) => Compiled::SourceKindIn(vec![k]),
                None => Compiled::Generic(c),
            },
            (Field::SourceOwnerKind, Op::In) => {
                Compiled::SourceKindIn(as_str_list(&c.value, UnitKind::from_str))
            }
            _ => Compiled::Generic(c),
        })
        .collect()
}

fn compiled_all(
    filters: &[Compiled<'_>],
    row: usize,
    events: &EventStore,
    tables: &InternTables,
) -> bool {
    filters.iter().all(|c| match c {
        Compiled::KindIn(ks) => ks.contains(&events.kind[row]),
        Compiled::SourceKindIn(ks) => ks.contains(&effective_source_kind(row, events, tables)),
        Compiled::Generic(fc) => passes(fc, row, events, tables),
    })
}

#[derive(Default, Clone)]
struct Accum {
    n: u64,
    sum: f64,
    sum_sq: f64,
    min: f64,
    max: f64,
    seen: bool,
}

impl Accum {
    fn add(&mut self, x: f64) {
        self.n += 1;
        self.sum += x;
        self.sum_sq += x * x;
        if self.seen {
            self.min = self.min.min(x);
            self.max = self.max.max(x);
        } else {
            self.min = x;
            self.max = x;
            self.seen = true;
        }
    }

    fn result(&self, op: AggOp) -> f64 {
        match op {
            AggOp::Count => self.n as f64,
            AggOp::Sum => self.sum,
            AggOp::Avg if self.n > 0 => self.sum / self.n as f64,
            AggOp::Min if self.seen => self.min,
            AggOp::Max if self.seen => self.max,
            AggOp::Stddev if self.n >= 2 => {
                let mean = self.sum / self.n as f64;
                let var = (self.sum_sq - self.n as f64 * mean * mean) / (self.n as f64 - 1.0);
                var.max(0.0).sqrt()
            }
            _ => 0.0,
        }
    }
}

/// Inclusive time window `[start_ms, end_ms]` -> row range, by binary
/// search on the file-ordered (chronological) timestamps. Malformed rows
/// carry `timestamp_ms == 0`, which is always `< start_ms` for a real
/// window, so they sort to the front and are excluded -- the rare
/// mid-stream malformed line is the one case this can misjudge by a row
/// or two; a strict monotonic-timestamp index is the fix if it matters.
pub(crate) fn window(events: &EventStore, start_ms: i64, end_ms: i64) -> (usize, usize) {
    let ts = &events.timestamp_ms;
    let lo = ts.partition_point(|&t| t < start_ms);
    let hi = ts.partition_point(|&t| t <= end_ms);
    (lo, hi.min(ts.len()))
}

/// Folds one row into `accs` -- one entry per aggregate clause, skipping a
/// clause whose per-clause `where` (pre-`compile`d, one `Vec` per clause)
/// doesn't pass. The query-level `where` is the caller's responsibility.
fn accumulate_row(
    row: usize,
    aggregate: &[AggregateClause],
    clause_filters: &[Vec<Compiled<'_>>],
    events: &EventStore,
    tables: &InternTables,
    accs: &mut [Accum],
) {
    for (i, clause) in aggregate.iter().enumerate() {
        if !compiled_all(&clause_filters[i], row, events, tables) {
            continue;
        }
        let x = clause
            .field
            .map(|f| row_value(f, row, events, tables).as_f64())
            .unwrap_or(0.0);
        accs[i].add(x);
    }
}

/// `compile` each aggregate clause's per-clause `where`, once per query.
fn compile_clause_filters(aggregate: &[AggregateClause]) -> Vec<Vec<Compiled<'_>>> {
    aggregate.iter().map(|c| compile(&c.where_)).collect()
}

fn agg_columns(aggregate: &[AggregateClause], accs: &[Accum], obj: &mut Map<String, Value>) {
    for (clause, acc) in aggregate.iter().zip(accs) {
        obj.insert(clause.as_.clone(), Value::from(acc.result(clause.op)));
    }
}

/// Runs an aggregated query -- one pass over the window, one `Accum` per
/// aggregate clause per distinct `group_by` tuple (or per time bucket, if
/// `spec.bucket` is set). Returns one JSON object per group: the group-key
/// fields (camelCase), or `tMid`, plus each clause's `as` column.
pub fn run_aggregate(spec: &QuerySpec, events: &EventStore, tables: &InternTables) -> Vec<Value> {
    let (lo, hi) = window(events, spec.start_ms, spec.end_ms);

    if let Some(b) = &spec.bucket {
        return run_bucketed(spec, b.count, events, tables, lo, hi);
    }

    let where_ = compile(&spec.where_);
    let clause_filters = compile_clause_filters(&spec.aggregate);
    let mut groups: HashMap<GroupKey, Vec<Accum>> = HashMap::new();
    for row in lo..hi {
        if events.timestamp_ms[row] < spec.start_ms || events.timestamp_ms[row] > spec.end_ms {
            continue;
        }
        if !compiled_all(&where_, row, events, tables) {
            continue;
        }
        let key = GroupKey::build(&spec.group_by, row, events, tables);
        let accs = groups
            .entry(key)
            .or_insert_with(|| vec![Accum::default(); spec.aggregate.len()]);
        accumulate_row(row, &spec.aggregate, &clause_filters, events, tables, accs);
    }

    groups
        .into_iter()
        .map(|(key, accs)| {
            let mut obj = Map::new();
            for (f, v) in spec.group_by.iter().zip(key.values()) {
                obj.insert(f.camel().to_string(), v.to_json());
            }
            agg_columns(&spec.aggregate, &accs, &mut obj);
            Value::Object(obj)
        })
        .collect()
}

/// `bucket` mode: `count` equal time slices over `[start_ms, end_ms]`, one
/// dense row per slice (`{ tMid, <as cols> }`) so a chart gets a
/// continuous series. Events past the last slice boundary (integer-width
/// rounding) fold into the last slice.
fn run_bucketed(
    spec: &QuerySpec,
    count: usize,
    events: &EventStore,
    tables: &InternTables,
    lo: usize,
    hi: usize,
) -> Vec<Value> {
    if count == 0 || spec.end_ms <= spec.start_ms {
        return Vec::new();
    }
    let width = ((spec.end_ms - spec.start_ms) / count as i64).max(1);
    let where_ = compile(&spec.where_);
    let clause_filters = compile_clause_filters(&spec.aggregate);
    let mut buckets: Vec<Vec<Accum>> =
        vec![vec![Accum::default(); spec.aggregate.len()]; count];

    for row in lo..hi {
        let ts = events.timestamp_ms[row];
        if ts < spec.start_ms || ts > spec.end_ms {
            continue;
        }
        if !compiled_all(&where_, row, events, tables) {
            continue;
        }
        let idx = (((ts - spec.start_ms) / width) as usize).min(count - 1);
        accumulate_row(row, &spec.aggregate, &clause_filters, events, tables, &mut buckets[idx]);
    }

    buckets
        .into_iter()
        .enumerate()
        .map(|(idx, accs)| {
            let mut obj = Map::new();
            let t_mid = spec.start_ms as f64 + (idx as f64 + 0.5) * width as f64;
            obj.insert("tMid".to_string(), Value::from(t_mid));
            agg_columns(&spec.aggregate, &accs, &mut obj);
            Value::Object(obj)
        })
        .collect()
}

/// The `[lo, hi)` row range plus a `keep(row)` predicate for raw-row
/// mode -- `lib.rs` builds the `RawEventRow`s (it owns that struct),
/// applying `limit`/`offset` after this filter.
pub fn raw_window<'a>(
    spec: &'a QuerySpec,
    events: &'a EventStore,
    tables: &'a InternTables,
) -> (usize, usize, impl Fn(usize) -> bool + 'a) {
    let (lo, hi) = window(events, spec.start_ms, spec.end_ms);
    let where_ = compile(&spec.where_);
    let keep = move |row: usize| {
        events.timestamp_ms[row] >= spec.start_ms
            && events.timestamp_ms[row] <= spec.end_ms
            && compiled_all(&where_, row, events, tables)
    };
    (lo, hi, keep)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parser::event::parse_line;

    /// Builds an `EventStore` from `\n`-free lines, each already carrying a
    /// timestamp prefix.
    fn store_from(lines: &[&str]) -> (Vec<u8>, InternTables, EventStore) {
        let data = lines.join("\n").into_bytes();
        let mut tables = InternTables::default();
        let mut store = EventStore::default();
        let mut off = 0usize;
        for line in data.split(|&b| b == b'\n') {
            parse_line(&data, off, line, &mut tables, &mut store);
            off += line.len() + 1;
        }
        (data, tables, store)
    }

    fn spell_damage(ts: &str, amount: i64) -> String {
        format!(
            "{ts}  SPELL_DAMAGE,Player-1-00000001,\"Mage-Realm-US\",0x511,0x0,\
             Creature-0-0-0-0-1-0,\"Add\",0xa48,0x0,1449,\"Arcane Explosion\",0x40,\
             Player-1-00000001,0000000000000000,100,100,0,0,0,0,0,0,0,0,100,0,0,0,0,0,0,\
             {amount},0,64,0,0,0,0,nil,nil,nil,AOE"
        )
    }

    fn sum_clause(as_: &str, where_: Vec<FilterClause>) -> AggregateClause {
        AggregateClause { op: AggOp::Sum, field: Some(Field::Amount), as_: as_.into(), where_ }
    }

    fn kind_in(kinds: &[&str]) -> FilterClause {
        FilterClause { field: Field::Kind, op: Op::In, value: serde_json::json!(kinds) }
    }

    #[test]
    fn bucket_mode_returns_dense_zero_filled_slices() {
        let l0 = spell_damage("4/14/2026 19:00:00.000-6", 100);
        let l1 = spell_damage("4/14/2026 19:00:02.000-6", 200);
        let l2 = spell_damage("4/14/2026 19:00:04.000-6", 400);
        let (_, tables, store) = store_from(&[&l0, &l1, &l2]);
        assert_eq!(store.len(), 3);

        let spec = QuerySpec {
            start_ms: store.timestamp_ms[0],
            end_ms: store.timestamp_ms[2],
            where_: vec![],
            group_by: vec![],
            aggregate: vec![sum_clause("dmg", vec![])],
            bucket: Some(Bucket { count: 4 }),
            limit: None,
            offset: None,
        };
        let rows = run_aggregate(&spec, &store, &tables);
        assert_eq!(rows.len(), 4);

        let d = |i: usize| rows[i]["dmg"].as_f64().unwrap();
        // width 1000ms: t=0 -> slice 0, t=2000 -> slice 2, t=4000 (== end)
        // folds into the last slice; slice 1 is empty and still emitted.
        assert_eq!([d(0), d(1), d(2), d(3)], [100.0, 0.0, 200.0, 400.0]);

        let t: Vec<f64> = rows.iter().map(|r| r["tMid"].as_f64().unwrap()).collect();
        assert!(t.windows(2).all(|w| w[0] < w[1]));
    }

    #[test]
    fn per_clause_where_filters_independently() {
        let l = spell_damage("4/14/2026 19:00:00.000-6", 500);
        let (_, tables, store) = store_from(&[&l]);
        let ts = store.timestamp_ms[0];
        let spec = QuerySpec {
            start_ms: ts,
            end_ms: ts,
            where_: vec![],
            group_by: vec![],
            aggregate: vec![
                sum_clause("dmg", vec![kind_in(&["SPELL_DAMAGE"])]),
                sum_clause("heal", vec![kind_in(&["SPELL_HEAL"])]),
            ],
            bucket: None,
            limit: None,
            offset: None,
        };
        let rows = run_aggregate(&spec, &store, &tables);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["dmg"].as_f64().unwrap(), 500.0);
        assert_eq!(rows[0]["heal"].as_f64().unwrap(), 0.0);
    }

    #[test]
    fn multi_field_group_by_emits_every_key_field() {
        // Two hits from the same player (source unit == its own owner):
        // one group, keyed by (sourceOwner, sourceUnit), summed.
        let l0 = spell_damage("4/14/2026 19:00:00.000-6", 100);
        let l1 = spell_damage("4/14/2026 19:00:01.000-6", 250);
        let (_, tables, store) = store_from(&[&l0, &l1]);
        let spec = QuerySpec {
            start_ms: store.timestamp_ms[0],
            end_ms: store.timestamp_ms[1],
            where_: vec![],
            group_by: vec![Field::SourceOwner, Field::SourceUnit],
            aggregate: vec![sum_clause("dmg", vec![])],
            bucket: None,
            limit: None,
            offset: None,
        };
        let rows = run_aggregate(&spec, &store, &tables);
        assert_eq!(rows.len(), 1);
        let r = &rows[0];
        assert_eq!(r["dmg"].as_f64().unwrap(), 350.0);
        // Both group-key fields present, and equal (a player unfolded to
        // its own owner).
        assert!(r["sourceOwner"].is_i64());
        assert_eq!(r["sourceOwner"], r["sourceUnit"]);
    }
}
