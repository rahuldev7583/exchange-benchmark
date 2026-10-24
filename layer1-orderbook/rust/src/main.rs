// Layer 1: in-memory orderbook benchmark for matching-engine-rust.
// Workload definition: docs/METHODOLOGY.md (must stay identical to ts/bench.ts).

use std::{
    collections::BTreeMap,
    env, fs,
    hint::black_box,
    time::{Duration, Instant},
};

use matching_engine_rust::order::Orderbook;
use matching_engine_rust::orderbook::{ORDERBOOK, OpenOrder, OrderStatus, OrderType, Side};
use serde_json::{Value, json};

enum Cmd {
    Create(OpenOrder),
    Cancel(String),
}

struct Outcome {
    status: &'static str,
    filled: u64,
    #[allow(dead_code)]
    remaining: u64,
    fills: Vec<matching_engine_rust::orderbook::Fill>,
}

struct Cfg {
    symbol: String,
    mid: u64,
    levels: u64,
    unit: u64,
}

fn status_str(s: &OrderStatus) -> &'static str {
    match s {
        OrderStatus::Accepted => "accepted",
        OrderStatus::Rejected => "rejected",
        OrderStatus::FullyFilled => "fully_filled",
        OrderStatus::PartiallyFilled => "partially_filled",
        OrderStatus::Cancelled => "cancelled",
        OrderStatus::SelfTradePrevented => "self_trade_prevented",
        OrderStatus::NotFound => "not_found",
    }
}

fn open_order(
    cfg: &Cfg,
    id: String,
    user: String,
    side: Side,
    order_type: OrderType,
    qty: u64,
    price: u64,
    created_at: i64,
) -> OpenOrder {
    OpenOrder {
        backend_id: "bench".to_string(),
        request_id: format!("req-{id}"),
        user_id: user,
        order_id: id,
        order_type,
        side,
        symbol: cfg.symbol.clone(),
        quantity: qty,
        price,
        created_at,
    }
}

fn seed_book(cfg: &Cfg, n: u64) -> ORDERBOOK {
    let mut book = ORDERBOOK::new();
    for i in 0..n {
        let d = 1 + i % cfg.levels;
        let qty = cfg.unit * (5 + i % 5);
        let ask = open_order(
            cfg,
            format!("a{i}"),
            format!("maker-{}", i % 100),
            Side::Sell,
            OrderType::Limit,
            qty,
            cfg.mid + d,
            i as i64,
        );
        let bid = open_order(
            cfg,
            format!("b{i}"),
            format!("maker-{}", (i + 50) % 100),
            Side::Buy,
            OrderType::Limit,
            qty,
            cfg.mid - d,
            i as i64,
        );
        // Same layout the engine produces for resting orders: push_front, oldest at the back.
        book.asks.entry(ask.price).or_default().push_front(ask.clone());
        book.orders.insert(ask.order_id.clone(), ask);
        book.bids.entry(bid.price).or_default().push_front(bid.clone());
        book.orders.insert(bid.order_id.clone(), bid);
    }
    book
}

fn build_commands(cfg: &Cfg, scenario: &str, n: u64, ops: u64) -> Vec<Cmd> {
    let (mid, l, u) = (cfg.mid, cfg.levels, cfg.unit);
    (0..ops)
        .map(|i| {
            if scenario == "cancel" {
                let k = ((i / 2) * 7919) % n;
                return Cmd::Cancel(if i % 2 == 0 { format!("a{k}") } else { format!("b{k}") });
            }
            let buy = i % 2 == 0;
            let side = if buy { Side::Buy } else { Side::Sell };
            let (ty, qty, price) = match scenario {
                "limit_rest" => (
                    OrderType::Limit,
                    u,
                    if buy { mid - 1 - i % l } else { mid + 1 + i % l },
                ),
                "limit_cross_1" => (OrderType::Limit, u, if buy { mid + 1 } else { mid - 1 }),
                "limit_sweep" => (OrderType::Limit, 30 * u, if buy { mid + l } else { mid - l }),
                "market_sweep" => (OrderType::Market, 20 * u, 0),
                other => panic!("unknown scenario {other}"),
            };
            Cmd::Create(open_order(cfg, format!("t{i}"), format!("taker-{i}"), side, ty, qty, price, 1_000_000 + i as i64))
        })
        .collect()
}

fn execute(book: &mut ORDERBOOK, cmd: Cmd) -> Outcome {
    match cmd {
        Cmd::Create(order) => {
            let qty = order.quantity;
            match book.create_order(order) {
                Ok(d) => Outcome {
                    status: status_str(&d.status),
                    filled: d.filled_quantity,
                    remaining: qty - d.filled_quantity,
                    fills: d.fills,
                },
                Err(_) => Outcome { status: "rejected", filled: 0, remaining: qty, fills: vec![] },
            }
        }
        Cmd::Cancel(id) => match book.cancel_order(id) {
            Ok(o) => Outcome { status: "cancelled", filled: 0, remaining: o.quantity, fills: vec![] },
            Err(_) => Outcome { status: "not_found", filled: 0, remaining: 0, fills: vec![] },
        },
    }
}

fn percentile(sorted: &[u64], p: f64) -> u64 {
    let rank = ((p / 100.0) * sorted.len() as f64).ceil() as usize;
    sorted[rank.clamp(1, sorted.len()) - 1]
}

fn timer_overhead_ns() -> u64 {
    let mut d: Vec<u64> = (0..200_000)
        .map(|_| {
            let t = Instant::now();
            black_box(t.elapsed().as_nanos() as u64)
        })
        .collect();
    d.sort_unstable();
    d[d.len() / 2]
}

fn run_cell(cfg: &Cfg, scenario: &str, n: u64, p: &Value) -> Value {
    let max_ops = p["max_ops_per_round"].as_u64().unwrap();
    let target = p["target_samples"].as_u64().unwrap();
    let warmup = p["warmup_rounds"].as_u64().unwrap();
    let budget = Duration::from_secs(p["cell_budget_seconds"].as_u64().unwrap());
    let ops = max_ops.min(n / 10).max(1);
    let rounds = target.div_ceil(ops);

    let mut samples: Vec<u64> = Vec::with_capacity((ops * rounds) as usize);
    let mut statuses: BTreeMap<&'static str, u64> = BTreeMap::new();
    let (mut fills, mut filled_qty, mut notional) = (0u64, 0u128, 0u128);
    let started = Instant::now();
    let mut done = 0u64;
    let mut truncated = false;

    for r in 0..(warmup + rounds) {
        let timed = r >= warmup;
        if timed && done >= 3 && started.elapsed() > budget {
            truncated = true;
            break;
        }
        let mut book = seed_book(cfg, n);
        let cmds = build_commands(cfg, scenario, n, ops);
        let mut outcomes: Vec<Outcome> = Vec::with_capacity(ops as usize);
        for cmd in cmds {
            let t = Instant::now();
            let out = execute(&mut book, cmd);
            let ns = t.elapsed().as_nanos() as u64;
            if timed {
                samples.push(ns);
            }
            outcomes.push(black_box(out));
        }
        if timed {
            if done == 0 {
                for o in &outcomes {
                    *statuses.entry(o.status).or_default() += 1;
                    filled_qty += o.filled as u128;
                    for f in &o.fills {
                        fills += 1;
                        notional += f.price as u128 * f.filled_quantity as u128;
                    }
                }
            }
            done += 1;
        }
    }

    samples.sort_unstable();
    let sum: u128 = samples.iter().map(|&x| x as u128).sum();
    let mean = sum as f64 / samples.len() as f64;
    json!({
        "engine": "rust",
        "scenario": scenario,
        "book_size_per_side": n,
        "ops_per_round": ops,
        "rounds": done,
        "warmup_rounds": warmup,
        "samples": samples.len(),
        "truncated_by_budget": truncated,
        "latency_ns": {
            "min": samples[0],
            "mean": mean,
            "p50": percentile(&samples, 50.0),
            "p90": percentile(&samples, 90.0),
            "p99": percentile(&samples, 99.0),
            "p999": percentile(&samples, 99.9),
            "max": samples[samples.len() - 1],
        },
        "throughput_ops_per_sec": 1e9 / mean,
        "parity": {
            "statuses": statuses,
            "fills": fills,
            "filled_quantity": filled_qty.to_string(),
            "notional": notional.to_string(),
        },
    })
}

fn main() {
    let args: Vec<String> = env::args().collect();
    let arg = |name: &str| args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned();
    let config_path = arg("--config").unwrap_or_else(|| "../../config/layer1.json".into());
    let profile = arg("--profile").unwrap_or_else(|| "default".into());
    let out = arg("--out");

    let conf: Value = serde_json::from_str(&fs::read_to_string(&config_path).expect("read config")).unwrap();
    let p = conf["profiles"][&profile].clone();
    assert!(p.is_object(), "unknown profile {profile}");
    let cfg = Cfg {
        symbol: conf["symbol"].as_str().unwrap().to_string(),
        mid: conf["mid_price"].as_u64().unwrap(),
        levels: conf["levels"].as_u64().unwrap(),
        unit: conf["qty_unit"].as_u64().unwrap(),
    };
    let only: Option<Vec<String>> = arg("--scenarios").map(|s| s.split(',').map(String::from).collect());

    let mut cells = vec![];
    for n in p["book_sizes"].as_array().unwrap() {
        let n = n.as_u64().unwrap();
        for s in conf["scenarios"].as_array().unwrap() {
            let s = s.as_str().unwrap();
            if only.as_ref().is_some_and(|o| !o.iter().any(|x| x == s)) {
                continue;
            }
            eprintln!("[rust] {s} book={n}/side");
            cells.push(run_cell(&cfg, s, n, &p));
        }
    }

    let result = json!({
        "engine": "rust",
        "profile": profile,
        "timer_overhead_ns": timer_overhead_ns(),
        "results": cells,
    });
    let text = serde_json::to_string_pretty(&result).unwrap();
    match out {
        Some(path) => fs::write(path, text).unwrap(),
        None => println!("{text}"),
    }
}
