use super::*;
use std::panic::{catch_unwind, AssertUnwindSafe};

const OUTPUT_BYTES_MAX: usize = ffi::OT_SESSION_CONTROL_PACKET_BYTES as usize;

fn context(object_capacity: u32) -> Result<Context> {
    abi_matches_checked_c_header();
    Context::new(ffi::ot_context_options { object_capacity, render_cells_max: 4096, ..Default::default() })
}

fn session(context: &Context, width: u32, height: u32) -> Result<Session<'_>> {
    let session = Session::new(
        context,
        ffi::ot_session_options {
            chunk_size: OUTPUT_BYTES_MAX as u32,
            span_capacity: 2,
            max_bytes: 2 * OUTPUT_BYTES_MAX as u64,
            control_capacity: OUTPUT_BYTES_MAX as u32,
            ..Default::default()
        },
    )?;
    session.attach_renderer(
        width,
        height,
        ffi::OT_SESSION_REMOTE_REMOTE,
        &[("TERM", "xterm-kitty"), ("COLORTERM", "truecolor")],
    )?;
    Ok(session)
}

impl Session<'_> {
    fn present(&self) -> Result<u32> {
        self.paint([0, 0, 0, 255], true, 0)?;
        self.render(true)
    }

    fn pump_until_quiet(&self, now_ns: &mut u64) -> Result<Vec<u8>> {
        let mut output = Vec::new();
        // Split ANSI sequences across 13-byte copies and bound collected output
        // to 53,248 bytes. Only this test host advances a virtual clock.
        for _ in 0..4096 {
            let result = self.pump(*now_ns, 1)?;
            match result.status {
                ffi::OT_PUMP_IDLE | ffi::OT_PUMP_CLOSED => return Ok(output),
                ffi::OT_PUMP_AGAIN => {}
                ffi::OT_PUMP_WAIT_UNTIL => {
                    assert!(result.deadline_ns > *now_ns);
                    *now_ns = result.deadline_ns;
                }
                ffi::OT_PUMP_OUTPUT_PENDING => {
                    let mut bytes = [0; 13];
                    let ticket = self.read_output(&mut bytes)?;
                    assert!(ticket.byte_count > 0);
                    output.extend_from_slice(&bytes[..ticket.byte_count as usize]);
                    self.complete_output(&ticket, true)?;
                }
                _ => panic!("unexpected pump status: {}", result.status),
            }
        }
        panic!("manual pump exceeded fixture work bound")
    }
}

fn contains(bytes: &[u8], part: &[u8]) -> bool {
    bytes.windows(part.len()).any(|window| window == part)
}

#[test]
fn abi_matches_checked_c_header() {
    // Build the probe only in tests; library consumers need no C test shim.
    static CHECKED: std::sync::Once = std::sync::Once::new();
    CHECKED.call_once(|| {
        use std::process::Command;
        let probe = std::path::Path::new(env!("OUT_DIR")).join(format!("abi-{}", std::process::id()));
        let compiled = Command::new(std::env::var_os("CC").unwrap_or_else(|| "cc".into()))
            .args(["-std=c11", "-Wall", "-Wextra", "-Werror", "-I", env!("OPENTUI_LIB_DIR")])
            .arg(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/abi.c"))
            .arg("-o")
            .arg(&probe)
            .output()
            .expect("compile C ABI probe");
        if !compiled.status.success() {
            let _ = std::fs::remove_file(&probe);
            panic!("C ABI probe failed: {}", String::from_utf8_lossy(&compiled.stderr));
        }
        let output = Command::new(&probe).output();
        std::fs::remove_file(&probe).expect("remove C ABI probe");
        let output = output.expect("run C ABI probe");
        assert!(output.status.success());
        let expected: Vec<u32> =
            std::str::from_utf8(&output.stdout).unwrap().lines().map(|line| line.parse().unwrap()).collect();
        assert_eq!(ffi::layout(), expected);
        assert_eq!(unsafe { ffi::ot_context_abi_version() }, ffi::OT_CONTEXT_ABI_VERSION);
    });
}

#[test]
fn styled_links_present_only_after_completed_output_then_restore() -> Result<()> {
    let context = context(3)?;
    let session = session(&context, 16, 2)?;
    let root = Node::new(&session, ffi::OT_SCENE_ROOT, 1)?;
    let text = Node::new(&session, ffi::OT_SCENE_TEXT, 2)?;
    text.mount(&root)?;
    text.set_text(b"initial")?;
    let mut bytes = b"OpenTUI".to_vec();
    let mut url = b"https://opentui.com/native".to_vec();
    let chunks = [
        ffi::ot_scene_linked_text_chunk {
            byte_count: 4,
            flags: ffi::OT_SCENE_TEXT_FOREGROUND,
            foreground: [255, 180, 40, 255],
            attributes: 1,
            ..Default::default()
        },
        ffi::ot_scene_linked_text_chunk {
            byte_count: 3,
            flags: ffi::OT_SCENE_TEXT_FOREGROUND | ffi::OT_SCENE_TEXT_LINK,
            foreground: [80, 220, 255, 255],
            attributes: 8,
            link_byte_count: url.len() as u32,
            ..Default::default()
        },
    ];
    text.set_styled_text_with_links(&bytes, &chunks, &url)?;
    bytes.fill(b'!');
    url.fill(b'!');
    assert_eq!(text.text()?, b"OpenTUI");
    assert_eq!(text.set_text(b"bad\xff").unwrap_err().status, ffi::OT_INVALID_ARGUMENT);
    assert_eq!(context.last_error()?, ffi::OT_INVALID_ARGUMENT);
    assert_eq!(text.text()?, b"OpenTUI");
    let mut invalid_chunks = chunks;
    invalid_chunks[1].link_offset = u32::MAX;
    assert_eq!(
        text.set_styled_text_with_links(b"changed", &invalid_chunks, b"https://rejected.test").unwrap_err().status,
        ffi::OT_INVALID_ARGUMENT
    );
    assert_eq!(text.text()?, b"OpenTUI");

    session.write(b"prefix")?;
    session.setup_terminal(&ffi::ot_session_terminal_options {
        flags: ffi::OT_TERMINAL_ALTERNATE_SCREEN,
        ..Default::default()
    })?;
    let mut now_ns = 0;
    let setup = session.pump_until_quiet(&mut now_ns)?;
    assert_eq!(session.terminal_state()?, ffi::OT_TERMINAL_ACTIVE);
    assert!(setup.starts_with(b"prefix"));
    assert!(contains(&setup, b"\x1b[?1049h"));
    assert_eq!(session.present()?, ffi::OT_RENDER_PENDING);
    assert_eq!(session.renderer_state()?.frame_count, 0);
    assert_eq!(session.hit_test(0, 0)?, 0);

    let mut packet = [0; 13];
    let ticket = session.read_output(&mut packet)?;
    assert_eq!(ticket.byte_count, 13);
    assert_eq!(session.renderer_state()?.frame_pending, 1);
    assert_eq!(session.read_output(&mut [0; 13]).unwrap_err().status, ffi::OT_OUTPUT_BUSY);
    assert_eq!(session.renderer_state()?.frame_count, 0);
    let mut altered = ticket;
    altered.byte_count -= 1;
    assert_eq!(session.complete_output(&altered, true).unwrap_err().status, ffi::OT_STALE_OUTPUT);
    assert_eq!(session.renderer_state()?.frame_count, 0);
    // The owned memory sink is the transport: delivery precedes acknowledgement.
    let mut output = packet.to_vec();
    session.complete_output(&ticket, true)?;
    assert_eq!(session.renderer_state()?.frame_count, 0);
    assert_eq!(session.renderer_state()?.frame_pending, 1);
    assert_eq!(session.hit_test(0, 0)?, 0);
    assert_eq!(session.complete_output(&ticket, true).unwrap_err().status, ffi::OT_STALE_OUTPUT);
    output.extend(session.pump_until_quiet(&mut now_ns)?);
    assert_eq!(session.renderer_state()?.frame_count, 1);
    assert_eq!(session.renderer_state()?.frame_pending, 0);
    assert_eq!(session.hit_test(0, 0)?, 2);
    assert_eq!(session.hit_test(1, 0)?, 2);
    assert_eq!(session.hit_test(15, 1)?, 0);
    assert_eq!(session.hit_test(16, 0)?, 0);
    for part in [
        b"Open".as_slice(),
        b"TUI",
        b"\x1b[38;2;255;180;40m",
        b"\x1b[38;2;80;220;255m",
        b"\x1b[1m",
        b"\x1b[4m",
        b";https://opentui.com/native\x1b\\",
    ] {
        assert!(contains(&output, part), "missing {:?} in {:?}", part, output);
    }

    session.close()?;
    let restored = session.pump_until_quiet(&mut now_ns)?;
    assert!(contains(&restored, b"\x1b[?1049l"));
    assert!(now_ns > 0, "restoration must advance the host's virtual clock");
    assert_eq!(session.state()?, ffi::OT_SESSION_CLOSED_STATE);
    assert_eq!(session.terminal_state()?, ffi::OT_TERMINAL_RESTORED);
    Ok(())
}

#[test]
fn cancelled_and_failed_copies_never_publish_a_frame() -> Result<()> {
    let context = context(3)?;
    for fail_transport in [false, true] {
        let session = session(&context, 16, 2)?;
        let root = Node::new(&session, ffi::OT_SCENE_ROOT, 1)?;
        let text = Node::new(&session, ffi::OT_SCENE_TEXT, 2)?;
        text.mount(&root)?;
        text.set_text(b"cancelled")?;
        assert_eq!(session.present()?, ffi::OT_RENDER_PENDING);
        let mut bytes = [0; 13];
        let ticket = session.read_output(&mut bytes)?;
        assert!(ticket.byte_count > 0);
        let copied = bytes;
        if fail_transport {
            session.complete_output(&ticket, false)?;
            assert_eq!(session.state()?, ffi::OT_SESSION_FAILED);
            assert_eq!(session.write(b"retry").unwrap_err().status, ffi::OT_OUTPUT_FAILED);
        }
        session.cancel()?;
        assert_eq!(session.state()?, ffi::OT_SESSION_CANCELLED_STATE);
        assert_eq!(session.renderer_state()?.frame_count, 0);
        assert_eq!(session.hit_test(0, 0)?, 0);
        assert_eq!(session.complete_output(&ticket, true).unwrap_err().status, ffi::OT_STALE_OUTPUT);
        let stale_session = session.handle;
        drop(text);
        drop(root);
        drop(session);
        assert_eq!(unsafe { ffi::ot_session_get_state(context.ptr(), &stale_session, &mut 0) }, ffi::OT_STALE_HANDLE);
        assert_eq!(bytes, copied);
    }
    Ok(())
}

#[test]
fn drop_reclaims_slots_on_error_unwind_and_pending_output() -> Result<()> {
    let context = context(3)?;
    // More repetitions than available slots expose a missing Drop immediately.
    for _ in 0..8 {
        assert_eq!(session(&context, 0, 1).err().unwrap().status, ffi::OT_INVALID_ARGUMENT);
        let session = session(&context, 8, 1)?;
        let root = Node::new(&session, ffi::OT_SCENE_ROOT, 1)?;
        let stale = {
            let text = Node::new(&session, ffi::OT_SCENE_TEXT, 2)?;
            text.mount(&root)?;
            text.set_text(b"accepted")?;
            assert_eq!(Node::new(&session, ffi::OT_SCENE_TEXT, 3).err().unwrap().status, ffi::OT_OBJECT_LIMIT);
            text.handle
        };
        assert_eq!(unsafe { ffi::ot_scene_destroy_node(context.ptr(), &stale) }, ffi::OT_STALE_HANDLE);
        assert!(catch_unwind(AssertUnwindSafe(|| {
            let text = Node::new(&session, ffi::OT_SCENE_TEXT, 3).unwrap();
            text.mount(&root).unwrap();
            text.set_text(b"unwind").unwrap();
            panic!("exercise Rust unwinding");
        }))
        .is_err());
        let text = Node::new(&session, ffi::OT_SCENE_TEXT, 4)?;
        text.mount(&root)?;
        text.set_text(b"pending")?;
        assert_eq!(session.present()?, ffi::OT_RENDER_PENDING);
        let ticket = session.read_output(&mut [0; 13])?;
        assert!(ticket.byte_count > 0);
        // Scene owners drop first; Session Drop cancels the unacknowledged copy.
    }
    Ok(())
}

#[test]
fn backpressure_preserves_accepted_bytes_until_completion() -> Result<()> {
    let context = context(1)?;
    let session = session(&context, 8, 1)?;
    assert_eq!(session.write(&vec![b'x'; OUTPUT_BYTES_MAX + 1]).unwrap_err().status, ffi::OT_OUTPUT_BACKPRESSURE);
    assert!(session.pump_until_quiet(&mut 0)?.is_empty());
    let input = vec![b'x'; OUTPUT_BYTES_MAX];
    session.write(&input)?;
    assert_eq!(session.write(b"no").unwrap_err().status, ffi::OT_OUTPUT_BACKPRESSURE);
    let mut output = [0; 13];
    let ticket = session.read_output(&mut output)?;
    assert_eq!(session.write(b"no").unwrap_err().status, ffi::OT_OUTPUT_BACKPRESSURE);
    session.complete_output(&ticket, true)?;
    let mut received = output.to_vec();
    received.extend(session.pump_until_quiet(&mut 0)?);
    assert_eq!(received, input);
    session.write(b"reused")?;
    assert_eq!(session.pump_until_quiet(&mut 0)?, b"reused");
    Ok(())
}

#[test]
fn explicit_output_limits_and_renderer_attachment() -> Result<()> {
    let context = context(1)?;
    let session = Session::new(
        &context,
        ffi::ot_session_options { chunk_size: 32, span_capacity: 3, max_bytes: 96, ..Default::default() },
    )?;
    // No renderer or terminal is required for a host-owned output transport.
    session.write(&[b'x'; 96])?;
    assert_eq!(session.write(b"x").unwrap_err().status, ffi::OT_OUTPUT_BACKPRESSURE);
    assert_eq!(session.pump_until_quiet(&mut 0)?, [b'x'; 96]);
    let entries = vec![("TERM", "xterm"); ffi::OT_SESSION_ENV_ENTRIES_MAX as usize + 1];
    assert_eq!(
        session.attach_renderer(8, 1, ffi::OT_SESSION_REMOTE_LOCAL, &entries).unwrap_err().status,
        ffi::OT_INVALID_ARGUMENT
    );
    let oversized = "x".repeat(ffi::OT_SESSION_ENV_BYTES_MAX as usize);
    assert_eq!(
        session.attach_renderer(8, 1, ffi::OT_SESSION_REMOTE_LOCAL, &[("TERM", &oversized)]).unwrap_err().status,
        ffi::OT_INVALID_ARGUMENT
    );
    assert_eq!(
        session.attach_renderer(0, 1, ffi::OT_SESSION_REMOTE_LOCAL, &[]).unwrap_err().status,
        ffi::OT_INVALID_ARGUMENT
    );
    session.attach_renderer(8, 1, ffi::OT_SESSION_REMOTE_AUTO, &[])?;
    session.resize(9, 2)?;
    let renderer = session.renderer_state()?;
    assert_eq!((renderer.width, renderer.height), (9, 2));
    Ok(())
}

#[test]
fn node_owners_reject_foreign_parents_and_survive_parent_drop() -> Result<()> {
    let first = context(3)?;
    let second = context(2)?;
    let first_session = session(&first, 8, 1)?;
    let second_session = session(&second, 8, 1)?;
    let root = Node::new(&first_session, ffi::OT_SCENE_ROOT, 1)?;
    let foreign = Node::new(&second_session, ffi::OT_SCENE_ROOT, 1)?;
    let text = Node::new(&first_session, ffi::OT_SCENE_TEXT, 2)?;
    text.mount(&root)?;
    text.set_text(b"owned")?;
    assert_eq!(text.mount(&foreign).unwrap_err().status, ffi::OT_WRONG_CONTEXT);
    drop(root);
    assert_eq!(text.text()?, b"owned");
    let replacement = Node::new(&first_session, ffi::OT_SCENE_ROOT, 3)?;
    text.mount(&replacement)?;
    assert_eq!(first_session.present()?, ffi::OT_RENDER_PENDING);
    assert!(contains(&first_session.pump_until_quiet(&mut 0)?, b"owned"));
    Ok(())
}
