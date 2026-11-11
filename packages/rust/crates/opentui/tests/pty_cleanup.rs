//! Programs on pseudo-terminals leave no threads or descriptors (on Windows, handles) behind. A test binary of its
//! own, so no other test opens descriptors or starts threads meanwhile.

use opentui::prelude::*;
use opentui::pty::Pty;
use opentui::testing::TestApp;
use std::cell::Cell;
use std::process::Command;
use std::rc::Rc;
use std::time::{Duration, Instant};

#[cfg(unix)]
fn descriptors() -> usize {
    std::fs::read_dir(if cfg!(target_os = "macos") { "/dev/fd" } else { "/proc/self/fd" }).unwrap().count()
}

#[cfg(windows)]
fn descriptors() -> usize {
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, GetProcessHandleCount};
    let mut count = 0;
    assert!(unsafe { GetProcessHandleCount(GetCurrentProcess(), &mut count) } != 0);
    count as usize
}

/// Whether process `pid` has ended.
#[cfg(unix)]
fn gone(pid: u32) -> bool {
    unsafe { libc::kill(pid as libc::pid_t, 0) != 0 }
}

#[cfg(windows)]
fn gone(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0};
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject};
    let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
    if handle.is_null() {
        return true;
    }
    let ended = unsafe { WaitForSingleObject(handle, 0) } == WAIT_OBJECT_0;
    unsafe { CloseHandle(handle) };
    ended
}

fn command(program: &str, arguments: &[&str]) -> Command {
    let mut command = Command::new(program);
    command.args(arguments);
    command
}

/// A program that exits at once.
fn quick() -> Command {
    if cfg!(windows) { command("cmd.exe", &["/d", "/c", "exit 0"]) } else { command("true", &[]) }
}

/// A program that runs for 100 seconds.
fn slow() -> Command {
    if cfg!(windows) { command("ping.exe", &["-n", "100", "127.0.0.1"]) } else { command("sleep", &["100"]) }
}

#[cfg(target_os = "linux")]
fn pty_threads() -> usize {
    let tasks = std::fs::read_dir("/proc/self/task").unwrap();
    tasks
        .filter_map(|task| std::fs::read_to_string(task.unwrap().path().join("comm")).ok())
        .filter(|name| name.starts_with("opentui-pty"))
        .count()
}

#[cfg(target_os = "macos")]
fn pty_threads() -> usize {
    // From <sys/proc_info.h>, which the libc crate lacks.
    const PROC_PIDLISTTHREADS: libc::c_int = 6;
    let pid = std::process::id() as libc::c_int;
    let mut threads = vec![0u64; 4096];
    let size = std::mem::size_of_val(threads.as_slice()) as libc::c_int;
    let listed = unsafe { libc::proc_pidinfo(pid, PROC_PIDLISTTHREADS, 0, threads.as_mut_ptr().cast(), size) };
    assert!(listed > 0, "listing threads failed: {}", std::io::Error::last_os_error());
    threads.truncate(listed as usize / std::mem::size_of::<u64>());
    let info_size = std::mem::size_of::<libc::proc_threadinfo>() as libc::c_int;
    threads
        .into_iter()
        .filter(|&thread| {
            let mut info: libc::proc_threadinfo = unsafe { std::mem::zeroed() };
            let info_ptr = (&mut info as *mut libc::proc_threadinfo).cast();
            let filled = unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDTHREADINFO, thread, info_ptr, info_size) };
            // A thread that ended since the listing reports nothing.
            filled == info_size
                && unsafe { std::ffi::CStr::from_ptr(info.pth_name.as_ptr()) }.to_bytes().starts_with(b"opentui-pty")
        })
        .count()
}

fn settles(mut done: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        if done() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    done()
}

#[test]
fn programs_and_apps_release_threads_and_descriptors() {
    let run_quick = || {
        let app = TestApp::new(20, 4);
        let exited = Rc::new(Cell::new(false));
        let pty = Pty::spawn(&app, quick(), 20, 4).unwrap().on_exit({
            let exited = Rc::clone(&exited);
            move |_cx, _status| exited.set(true)
        });
        assert!(app.wait_until(Duration::from_secs(10), || exited.get()));
        drop(pty);
        // Windows joins every I/O thread when the handle drops; Unix's reaper can outlive it, holding a descriptor.
        #[cfg(unix)]
        assert!(settles(|| pty_threads() == 0), "{} threads remain", pty_threads());
    };
    // Windows keeps a few handles from the first pseudoconsole a process creates.
    run_quick();
    let before = descriptors();
    // A program that exits by itself.
    run_quick();
    assert!(settles(|| descriptors() == before), "{} descriptors, {before} before", descriptors());

    // A program that runs until its app ends, held by a handler that captures its own widget.
    let pid;
    {
        let app = TestApp::new(20, 4);
        let terminal = TerminalView::new(&app).spawn(slow()).unwrap();
        terminal.on_exit({
            let terminal = terminal.clone();
            move |_cx, _status| drop(terminal.screen())
        });
        pid = terminal.pty().unwrap().pid();
        app.root().add(&terminal);
        app.render();
    }
    assert!(settles(|| gone(pid)), "the program outlived its app");
    // Windows joins every I/O thread when the handle drops; Unix's reaper can outlive it.
    #[cfg(unix)]
    assert!(settles(|| pty_threads() == 0), "{} threads remain", pty_threads());
    assert!(settles(|| descriptors() == before), "{} descriptors, {before} before", descriptors());
}
