//! Regression tests for bugs found in a review of remote terminals. Each test is named after the bug it guards
//! against; its comment gives the expected behavior and what happened before the fix.

use opentui::prelude::*;
use opentui::remote::{RemoteOptions, RemoteTerminal};
use std::sync::mpsc;
use std::time::Duration;

// Expected: `RemoteLink::disconnect` promises that the app's input ends and it sees `Event::Terminate`, so `run`
// returns, whenever the client leaves, including before or during the color query `App::remote` makes
// (`AppOptions::default` asks for the colors to pick a light theme).
// Actual: the query in `term::query` reads the end of input through `RemoteTerminal::read_input`, which reports it
// only once (`input_ended`). `App::remote` returns normally, but `run` never sees the end of input and keeps running
// for a client that is gone.
#[test]
fn a_client_that_leaves_during_the_color_query_never_ends_the_app() {
    let (terminal, link) = RemoteTerminal::new(RemoteOptions::default(), || {}).expect("create a remote terminal");
    link.disconnect();
    let (done, finished) = mpsc::channel();
    std::thread::spawn(move || {
        let result = App::remote(terminal, AppOptions::default()).and_then(App::run);
        let _ = done.send(result.is_ok());
    });
    assert!(
        finished.recv_timeout(Duration::from_secs(5)).is_ok(),
        "the app still runs five seconds after its client disconnected"
    );
}

// Expected: `RemoteTerminal::write` "waits up to `timeout` for room", so a timeout too long to matter, such as
// `Duration::MAX`, waits as long as it takes, as std's own timeouts (`recv_timeout`, `wait_timeout`) do.
// Actual: it computes `Instant::now() + timeout`, which overflows and panics, even when the bytes fit at once.
#[test]
fn writing_with_a_very_long_timeout_panics() {
    let (terminal, link) = RemoteTerminal::new(RemoteOptions::default(), || {}).expect("create a remote terminal");
    let written = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| terminal.write(b"hello", Duration::MAX)));
    assert!(matches!(written, Ok(Ok(()))), "writing five bytes with a long timeout panicked or failed");
    assert_eq!(link.take_output(16), b"hello");
}
