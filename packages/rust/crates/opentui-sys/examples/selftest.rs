//! Checks that the native library works inside this executable, which matters most when it is linked statically: a
//! C++ exception thrown and caught in native code, native thread-locals, and native stack unwinding. Runs the checks
//! on the main thread and on a second thread at the same time, prints one line per check, and exits with status 1 if
//! any fails.

use std::process::ExitCode;
use std::thread;

use opentui_sys::{OT_SELFTEST_CXX_EXCEPTION, OT_SELFTEST_THREAD_LOCAL, OT_SELFTEST_UNWIND};

const CHECKS: [(u32, &str); 3] = [
    (OT_SELFTEST_CXX_EXCEPTION, "a C++ exception is thrown and caught in native code"),
    (OT_SELFTEST_THREAD_LOCAL, "native thread-locals are per thread"),
    (OT_SELFTEST_UNWIND, "a native stack trace comes from the unwind tables"),
];

// Prints each check's line as it finishes, so a crash shows which check and thread it hit.
fn selftest(thread: &str) -> bool {
    CHECKS.iter().fold(true, |passed, &(bit, check)| {
        // SAFETY: ot_debug_selftest takes no pointers and may run on any thread.
        let ok = unsafe { opentui_sys::ot_debug_selftest(bit) } == 0;
        println!("{} {thread}: {check}", if ok { "ok  " } else { "FAIL" });
        passed & ok
    })
}

fn main() -> ExitCode {
    let second = thread::spawn(|| selftest("second thread"));
    let passed = selftest("main thread") & second.join().unwrap_or(false);
    let (os, arch) = (std::env::consts::OS, std::env::consts::ARCH);
    if passed {
        println!("OpenTUI selftest passed on {arch} {os}");
        ExitCode::SUCCESS
    } else {
        eprintln!("OpenTUI selftest failed on {arch} {os}");
        ExitCode::FAILURE
    }
}
