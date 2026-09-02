//! The `query_events` aggregate DSL -- see `docs/ui-widgets.md` ("Data
//! access"). Reduces over the columnar `EventStore` in Rust so the IPC
//! payload is proportional to the answer, not the input.
//!
//! Two modes: raw-row (no `aggregate` clauses -- handled in `lib.rs`,
//! which owns `RawEventRow`) and aggregated (this module).

use std::collections::HashMap;

use serde::Deserialize;
use serde_json::{Map, Value};

use crate::parser::event::{EventStore, FLAG_AOE, FLAG_CRIT};
use crate::parser::intern::{InternTables, NO_UNIT};

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
    #[serde(default)]
    pub limit: Option<usize>,
    #[serde(default)]
    pub offset: Option<usize>,
}

impl QuerySpec {
    pub fn is_aggregated(&self) -> bool {
        !self.aggregate.is_empty()
    }
}

/// The queryable columns. `SourceOwner` resolves a player's pet/guardian
/// to its owner (`guids.get(src).owner_id.unwrap_or(src)`) so pet damage
/// folds into the owning player -- see `docs/ui-widgets.md`,
/// "Per-encounter player rows". `SpellId` is the intern-table index, not
/// the WoW spell id (frontend maps via the index-aligned `debug_lists`).
#[derive(Deserialize, Clone, Copy, PartialEq, Eq, Hash, Debug)]
#[serde(rename_all = "camelCase")]
pub enum Field {
    Time,
    Kind,
    SourceUnit,
    SourceOwner,
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
}

/// A resolved column value for one row -- `Hash`/`Eq` so it can key a
/// group. No float variant: every queryable column is an integer or a
/// short string.
#[derive(Clone, PartialEq, Eq, Hash)]
enum Val {
    Int(i64),
    Str(String),
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
        Field::SourceOwner => {
            let src = events.source_unit[row];
            if src == NO_UNIT {
                Val::Int(-1)
            } else {
                Val::Int(tables.guids.get(src).owner_id.unwrap_or(src) as i64)
            }
        }
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
fn window(events: &EventStore, start_ms: i64, end_ms: i64) -> (usize, usize) {
    let ts = &events.timestamp_ms;
    let lo = ts.partition_point(|&t| t < start_ms);
    let hi = ts.partition_point(|&t| t <= end_ms);
    (lo, hi.min(ts.len()))
}

/// Runs an aggregated query -- one pass over the window, one `Accum` per
/// aggregate clause per distinct `group_by` tuple. Returns one JSON
/// object per group: the group-key fields (camelCase) plus each clause's
/// `as` column.
pub fn run_aggregate(spec: &QuerySpec, events: &EventStore, tables: &InternTables) -> Vec<Value> {
    let (lo, hi) = window(events, spec.start_ms, spec.end_ms);
    let mut groups: HashMap<Vec<Val>, Vec<Accum>> = HashMap::new();

    for row in lo..hi {
        if events.timestamp_ms[row] < spec.start_ms || events.timestamp_ms[row] > spec.end_ms {
            continue;
        }
        if !spec.where_.iter().all(|c| passes(c, row, events, tables)) {
            continue;
        }
        let key: Vec<Val> = spec
            .group_by
            .iter()
            .map(|f| row_value(*f, row, events, tables))
            .collect();
        let accs = groups
            .entry(key)
            .or_insert_with(|| vec![Accum::default(); spec.aggregate.len()]);
        for (i, clause) in spec.aggregate.iter().enumerate() {
            let x = clause
                .field
                .map(|f| row_value(f, row, events, tables).as_f64())
                .unwrap_or(0.0);
            accs[i].add(x);
        }
    }

    groups
        .into_iter()
        .map(|(key, accs)| {
            let mut obj = Map::new();
            for (f, v) in spec.group_by.iter().zip(&key) {
                obj.insert(f.camel().to_string(), v.to_json());
            }
            for (clause, acc) in spec.aggregate.iter().zip(&accs) {
                obj.insert(clause.as_.clone(), Value::from(acc.result(clause.op)));
            }
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
    let keep = move |row: usize| {
        events.timestamp_ms[row] >= spec.start_ms
            && events.timestamp_ms[row] <= spec.end_ms
            && spec.where_.iter().all(|c| passes(c, row, events, tables))
    };
    (lo, hi, keep)
}
