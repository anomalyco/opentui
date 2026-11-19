//! The Rust sidecar helper: JSON-RPC 2.0 over stdin/stdout, one message per line; stderr is its log. Requests run
//! in order on the main thread, except `sleep`, which gets a thread of its own so `$/cancel` can stop it.

mod embed;

use serde_json::{Value as Json, json};
use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

const METHODS: [&str; 5] = ["echo", "stream", "sleep", "crash", "embed"];
const CANCELLED: i64 = -32800;

/// The `sleep` calls in progress, by id: a flag `$/cancel` sets, and the condition the sleeper waits on.
type Sleeps = Arc<Mutex<HashMap<u64, Arc<(Mutex<bool>, Condvar)>>>>;

fn send(msg: &Json) {
    let mut line = msg.to_string();
    line.push('\n');
    let mut out = std::io::stdout().lock();
    let _ = out.write_all(line.as_bytes()).and_then(|_| out.flush());
}

fn reply(id: &Json, outcome: Result<Json, (i64, String)>) {
    send(&match outcome {
        Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
        Err((code, message)) => json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } }),
    })
}

fn main() {
    let sleeps = Sleeps::default();
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        match serde_json::from_str::<Json>(&line) {
            Ok(msg) => handle(msg, &sleeps),
            Err(e) => reply(&Json::Null, Err((-32700, e.to_string()))),
        }
    }
    // EOF: the host closed our stdin, so it is gone or wants us gone.
}

fn handle(mut msg: Json, sleeps: &Sleeps) {
    let id = msg["id"].clone();
    let params = msg["params"].take();
    match msg["method"].as_str().unwrap_or("") {
        "$/cancel" => {
            let flag = params["id"].as_u64().and_then(|id| sleeps.lock().unwrap().get(&id).cloned());
            if let Some(flag) = flag {
                *flag.0.lock().unwrap() = true;
                flag.1.notify_all();
            }
        }
        "initialize" => reply(&id, Ok(json!({ "protocol": 0, "methods": METHODS }))),
        "echo" => reply(&id, Ok(params)),
        "stream" => {
            let n = params["n"].as_u64().unwrap_or(0);
            for i in 0..n {
                send(&json!({ "jsonrpc": "2.0", "method": "$/chunk", "params": { "id": id, "chunk": { "i": i } } }));
            }
            reply(&id, Ok(json!({ "count": n })))
        }
        "sleep" => sleep(id, params["ms"].as_u64().unwrap_or(0), sleeps),
        "crash" if params["how"] == "abort" => std::process::abort(),
        "crash" => std::process::exit(1),
        "embed" => {
            let vector = embed::embed(params["text"].as_str().unwrap_or(""));
            reply(&id, Ok(json!({ "dim": vector.len(), "vector": vector })))
        }
        method if !id.is_null() => reply(&id, Err((-32601, format!("no method {method}")))),
        _ => {}
    }
}

fn sleep(id: Json, ms: u64, sleeps: &Sleeps) {
    let Some(key) = id.as_u64() else { return reply(&id, Err((-32602, "sleep needs a numeric id".into()))) };
    let flag = Arc::new((Mutex::new(false), Condvar::new()));
    sleeps.lock().unwrap().insert(key, flag.clone());
    let sleeps = sleeps.clone();
    std::thread::spawn(move || {
        let cancelled = {
            let guard = flag.0.lock().unwrap();
            *flag.1.wait_timeout_while(guard, Duration::from_millis(ms), |c| !*c).unwrap().0
        };
        sleeps.lock().unwrap().remove(&key);
        reply(&id, if cancelled { Err((CANCELLED, "cancelled".into())) } else { Ok(Json::Null) });
    });
}
