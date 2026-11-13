use super::*;
use crate::input::{KeyEventKind, Modifiers};
use crate::layout::{Edge, Gutter, LayoutProperty, Length};
use crate::style::{Attributes, BorderStyle, Color, Sides, Span, Style, Stylize};
use crate::{Error, Result, Status, sys};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::time::Duration;

const OUTPUT_BYTES_MAX: usize = sys::OT_SESSION_CONTROL_PACKET_BYTES as usize;

fn context(object_capacity: u32) -> Result<Context> {
    Context::new(ContextOptions { object_capacity, render_cells_max: 4096 })
}

fn session(context: &Context, width: u32, height: u32) -> Result<Session> {
    let session = Session::new(
        context,
        SessionOptions {
            chunk_size: OUTPUT_BYTES_MAX as u32,
            span_capacity: 2,
            max_bytes: 2 * OUTPUT_BYTES_MAX as u64,
            control_capacity: OUTPUT_BYTES_MAX as u32,
        },
    )?;
    session.attach_renderer(width, height, Remote::Remote, &[("TERM", "xterm-kitty"), ("COLORTERM", "truecolor")])?;
    Ok(session)
}

fn status<T>(result: Result<T>) -> Status {
    match result {
        Err(Error::Native { status, .. }) => status,
        Err(error) => panic!("expected a native error, got {error}"),
        Ok(_) => panic!("expected a native error, got Ok"),
    }
}

fn contains(bytes: &[u8], part: &[u8]) -> bool {
    bytes.windows(part.len()).any(|window| window == part)
}

impl Session {
    fn present(&self) -> Result<RenderOutcome> {
        self.paint(Color::rgb(0, 0, 0), true, 0)?.commit(true)
    }

    /// Delivers output in 13-byte copies so escape sequences split across tickets. Only this test host advances a
    /// virtual clock.
    fn pump_until_quiet(&self, now_ns: &mut u64) -> Result<Vec<u8>> {
        let mut output = Vec::new();
        for _ in 0..4096 {
            match self.pump(*now_ns, 1)? {
                Pump::Idle | Pump::Closed => return Ok(output),
                Pump::Again => {}
                Pump::WaitUntil(deadline) => {
                    assert!(deadline > *now_ns);
                    *now_ns = deadline;
                }
                Pump::OutputPending => {
                    let mut bytes = [0; 13];
                    let ticket = self.read_output(&mut bytes)?.expect("pending output");
                    output.extend_from_slice(&bytes[..ticket.len()]);
                    self.complete_output(ticket, true)?;
                }
            }
        }
        panic!("manual pump exceeded fixture work bound")
    }
}

#[test]
fn painted_drafts_consume_statuses_and_cancel_on_drop() -> Result<()> {
    for expected in [RenderOutcome::Pending, RenderOutcome::Skipped, RenderOutcome::Failed] {
        let context = context(4)?;
        let chunk_size = if expected == RenderOutcome::Pending { 4096 } else { 32 };
        let session = Session::new(
            &context,
            SessionOptions { chunk_size, span_capacity: 2, max_bytes: 2 * u64::from(chunk_size), control_capacity: 0 },
        )?;
        session.attach_renderer(4, 1, Remote::Remote, &[])?;
        let _root = Node::new(&session, NodeKind::Root, 1)?;
        drop(session.paint(Color::rgb(0, 0, 0), false, 0)?);
        let mut frame = session.paint(Color::rgb(0, 0, 0), false, 0)?;
        if expected == RenderOutcome::Skipped {
            session.write(&[b'x'; 64])?;
        }
        assert_eq!(frame.commit(true)?, expected);
        assert_eq!(status(frame.commit(true)), Status::StaleFrame);
        assert!(!frame.is_live());
    }
    Ok(())
}

#[test]
fn styled_links_present_only_after_completed_output_then_restore() -> Result<()> {
    let context = context(6)?;
    let session = session(&context, 16, 2)?;
    let root = Node::new(&session, NodeKind::Root, 1)?;
    let text = Node::new(&session, NodeKind::Text, 2)?;
    text.insert_into(&root, 0)?;
    text.set_text("initial")?;
    let mut bytes = b"OpenTUI".to_vec();
    let mut url = b"https://opentui.com/native".to_vec();
    let chunks = [
        sys::ot_styled_text_chunk {
            byte_count: 4,
            flags: sys::OT_SCENE_TEXT_FOREGROUND,
            foreground: [255, 180, 40, 255],
            attributes: 1,
            ..Default::default()
        },
        sys::ot_styled_text_chunk {
            byte_count: 3,
            flags: sys::OT_SCENE_TEXT_FOREGROUND | sys::OT_SCENE_TEXT_LINK,
            foreground: [80, 220, 255, 255],
            attributes: 8,
            link_byte_count: url.len() as u32,
            ..Default::default()
        },
    ];
    text.set_styled_raw(&bytes, &chunks, &url)?;
    // Native code copied the input.
    bytes.fill(b'!');
    url.fill(b'!');
    assert_eq!(text.text()?, "OpenTUI");
    assert_eq!((context.last_error()?, context.drain_diagnostics()?.len()), (None, 0));
    assert_eq!(status(text.set_text(b"bad\xff")), Status::InvalidArgument);
    assert_eq!(context.last_error()?, Some(Status::InvalidArgument));
    assert_eq!(text.text()?, "OpenTUI");
    let mut invalid_chunks = chunks;
    invalid_chunks[1].link_offset = u32::MAX;
    assert_eq!(
        status(text.set_styled_raw(b"changed", &invalid_chunks, b"https://rejected.test")),
        Status::InvalidArgument
    );
    assert_eq!(text.text()?, "OpenTUI");

    session.write(b"prefix")?;
    session.setup_terminal(TerminalOptions { alternate_screen: true, ..Default::default() })?;
    let mut now_ns = 0;
    let setup = session.pump_until_quiet(&mut now_ns)?;
    assert_eq!(session.terminal_state()?, TerminalState::Active);
    assert!(setup.starts_with(b"prefix"));
    assert!(contains(&setup, b"\x1b[?1049h"));
    assert_eq!(session.present()?, RenderOutcome::Pending);
    assert_eq!(session.renderer_state()?.frame_count, 0);
    assert_eq!(session.hit_test(0, 0)?, None);

    let mut packet = [0; 13];
    let ticket = session.read_output(&mut packet)?.expect("frame output");
    assert_eq!(ticket.len(), 13);
    assert!(session.renderer_state()?.frame_pending);
    assert_eq!(status(session.read_output(&mut [0; 13])), Status::OutputBusy);
    let raw = *ticket.raw();
    let mut altered = raw;
    altered.byte_count -= 1;
    let (context_ptr, handle) = (context.as_raw(), session.handle());
    assert_eq!(unsafe { sys::ot_session_complete_output(context_ptr, &handle, &altered, 1) }, sys::OT_STALE_OUTPUT);
    // The memory sink is the transport: delivery precedes completion.
    let mut output = packet.to_vec();
    session.complete_output(ticket, true)?;
    assert_eq!(session.renderer_state()?.frame_count, 0);
    assert!(session.renderer_state()?.frame_pending);
    assert_eq!(session.hit_test(0, 0)?, None);
    assert_eq!(unsafe { sys::ot_session_complete_output(context_ptr, &handle, &raw, 1) }, sys::OT_STALE_OUTPUT);
    output.extend(session.pump_until_quiet(&mut now_ns)?);
    assert_eq!(session.renderer_state()?.frame_count, 1);
    assert!(!session.renderer_state()?.frame_pending);
    assert_eq!(session.hit_test(0, 0)?, Some(2));
    assert_eq!(session.hit_test(1, 0)?, Some(2));
    assert_eq!(session.hit_test(15, 1)?, None);
    assert_eq!(session.hit_test(16, 0)?, None);
    let link = session.link_id(5, 0)?.expect("linked cell");
    assert_eq!(context.link_url(link)?, "https://opentui.com/native");
    for part in [
        b"Open".as_slice(),
        b"TUI",
        b"\x1b[38;2;255;180;40m",
        b"\x1b[38;2;80;220;255m",
        b"\x1b[1m",
        b"\x1b[4m",
        b";https://opentui.com/native\x1b\\",
    ] {
        assert!(contains(&output, part), "missing {part:?} in {output:?}");
    }

    // Only scene frames that record hits publish them, and another frame takes them down once it presents.
    let frame = |options| session.frame(&options, |_| Ok(()))?.commit(true);
    let without_hits: [&dyn Fn() -> Result<RenderOutcome>; 4] = [
        &|| session.paint(Color::rgb(0, 0, 0), false, 0)?.commit(true),
        &|| frame(FrameOptions { hit_grid: false, ..Default::default() }),
        &|| frame(FrameOptions { excluded_hit: 2, ..Default::default() }),
        &|| session.render(true),
    ];
    for draw in without_hits {
        draw()?;
        session.pump_until_quiet(&mut now_ns)?;
        assert_eq!(session.hit_test(0, 0)?, None);
        session.present()?;
        session.pump_until_quiet(&mut now_ns)?;
        assert_eq!(session.hit_test(0, 0)?, Some(2));
    }

    // A text buffer's `clear` keeps the styles of `set_spans` and drops their links; `reset` drops the styles too.
    let buffer = TextBuffer::new(&context, WidthMethod::Unicode)?;
    let (view, node) = (TextView::new(&buffer)?, Node::new(&session, NodeKind::TextView, 3)?);
    node.insert_into(&root, 1)?;
    node.set_text_view(Some(&view))?;
    for (clear, styled, linked) in [(None, true, true), (Some(false), true, false), (Some(true), false, false)] {
        buffer.set_spans(&["ab".fg(Color::rgb(1, 2, 3)).link("https://clear.test")])?;
        clear.map(|reset| buffer.clear(reset)).transpose()?;
        buffer.append("z")?;
        session.present()?;
        let output = session.pump_until_quiet(&mut now_ns)?;
        assert_eq!((contains(&output, b";1;2;3m"), contains(&output, b"clear.test")), (styled, linked), "{clear:?}");
    }
    // A link target with a control character keeps its text but gets no hyperlink; UTF-8 targets keep theirs.
    for (label, url, linked) in [
        ("esc", "https://x.test/a\x1b]52;c;cHduZWQ=\x07", false),
        ("csi", "https://x.test/\u{9b}0m", false),
        ("eur", "https://x.test/\u{20ac}", true),
    ] {
        buffer.set_spans(&[label.into_span().link(url)])?;
        session.present()?;
        let output = session.pump_until_quiet(&mut now_ns)?;
        let found = [label.as_bytes(), b"]52;", url.as_bytes()].map(|part| contains(&output, part));
        assert_eq!(found, [true, false, linked], "{label}");
    }

    session.close()?;
    let restored = session.pump_until_quiet(&mut now_ns)?;
    assert!(contains(&restored, b"\x1b[?1049l"));
    assert!(now_ns > 0, "restoration must advance the host's virtual clock");
    assert_eq!(session.state()?, SessionState::Closed);
    assert_eq!(session.terminal_state()?, TerminalState::Restored);
    Ok(())
}

#[test]
fn cancelled_and_failed_copies_never_publish_a_frame() -> Result<()> {
    let context = context(3)?;
    for fail_transport in [false, true] {
        let session = session(&context, 16, 2)?;
        let root = Node::new(&session, NodeKind::Root, 1)?;
        let text = Node::new(&session, NodeKind::Text, 2)?;
        text.insert_into(&root, 0)?;
        text.set_text("cancelled")?;
        assert_eq!(session.present()?, RenderOutcome::Pending);
        let mut bytes = [0; 13];
        let ticket = session.read_output(&mut bytes)?.expect("frame output");
        let raw = *ticket.raw();
        let copied = bytes;
        if fail_transport {
            session.complete_output(ticket, false)?;
            assert_eq!(session.state()?, SessionState::Failed);
            assert_eq!(status(session.write(b"retry")), Status::OutputFailed);
        } else {
            // Leave the copy uncompleted; cancellation must discard it.
            drop(ticket);
        }
        session.cancel()?;
        assert_eq!(session.state()?, SessionState::Cancelled);
        assert_eq!(session.renderer_state()?.frame_count, 0);
        assert_eq!(session.hit_test(0, 0)?, None);
        let handle = session.handle();
        assert_eq!(
            unsafe { sys::ot_session_complete_output(context.as_raw(), &handle, &raw, 1) },
            sys::OT_STALE_OUTPUT
        );
        drop((text, root, session));
        assert_eq!(unsafe { sys::ot_session_get_state(context.as_raw(), &handle, &mut 0) }, sys::OT_STALE_HANDLE);
        assert_eq!(bytes, copied);
    }
    Ok(())
}

#[test]
fn drop_reclaims_slots_on_error_unwind_and_pending_output() -> Result<()> {
    const SLOTS: u32 = 3;
    let context = context(SLOTS)?;
    for _ in 0..8 {
        assert_eq!(status(session(&context, 0, 1)), Status::InvalidArgument);
        let session = session(&context, 8, 1)?;
        let root = Node::new(&session, NodeKind::Root, 1)?;
        let stale = {
            let text = Node::new(&session, NodeKind::Text, 2)?;
            text.insert_into(&root, 0)?;
            text.set_text("accepted")?;
            text.handle()
        };
        assert_eq!(unsafe { sys::ot_scene_destroy_node(context.as_raw(), &stale) }, sys::OT_STALE_HANDLE);
        assert!(
            catch_unwind(AssertUnwindSafe(|| {
                let text = Node::new(&session, NodeKind::Text, 3).unwrap();
                text.insert_into(&root, 0).unwrap();
                text.set_text("unwind").unwrap();
                panic!("exercise Rust unwinding");
            }))
            .is_err()
        );
        let text = Node::new(&session, NodeKind::Text, 4)?;
        // The handle table grows only when every slot is taken, so a missing Drop in this pass or the last shows here.
        assert!(text.handle().slot < SLOTS, "an owner never freed its slot");
        text.insert_into(&root, 0)?;
        text.set_text("pending")?;
        assert_eq!(session.present()?, RenderOutcome::Pending);
        let ticket = session.read_output(&mut [0; 13])?.expect("frame output");
        // Leave the copy uncompleted: Session drop cancels it.
        drop(ticket);
    }
    Ok(())
}

#[test]
fn context_outlives_every_clone_and_dependent_owner() -> Result<()> {
    let context = context(3)?;
    let session = session(&context, 8, 1)?;
    let root = Node::new(&session, NodeKind::Root, 1)?;
    // Owners keep their dependencies alive, so drop order never matters.
    drop(context);
    drop(session);
    let text = Node::new(root.session(), NodeKind::Text, 2)?;
    text.insert_into(&root, 0)?;
    text.set_text("alive")?;
    assert_eq!(root.session().present()?, RenderOutcome::Pending);
    assert!(contains(&root.session().pump_until_quiet(&mut 0)?, b"alive"));
    Ok(())
}

#[test]
fn backpressure_preserves_accepted_bytes_until_completion() -> Result<()> {
    let context = context(1)?;
    let session = session(&context, 8, 1)?;
    assert_eq!(status(session.write(&vec![b'x'; OUTPUT_BYTES_MAX + 1])), Status::OutputBackpressure);
    assert!(session.pump_until_quiet(&mut 0)?.is_empty());
    let input = vec![b'x'; OUTPUT_BYTES_MAX];
    session.write(&input)?;
    assert_eq!(status(session.write(b"no")), Status::OutputBackpressure);
    let mut output = [0; 13];
    let ticket = session.read_output(&mut output)?.expect("queued output");
    assert_eq!(status(session.write(b"no")), Status::OutputBackpressure);
    session.complete_output(ticket, true)?;
    let mut received = output.to_vec();
    received.extend(session.pump_until_quiet(&mut 0)?);
    assert_eq!(received, input);
    session.write(b"reused")?;
    assert_eq!(session.pump_until_quiet(&mut 0)?, b"reused");
    assert_eq!(session.read_output(&mut output)?.map(|ticket| ticket.len()), None);
    Ok(())
}

#[test]
fn explicit_output_limits_and_renderer_attachment() -> Result<()> {
    let context = context(1)?;
    let session = Session::new(
        &context,
        SessionOptions { chunk_size: 32, span_capacity: 3, max_bytes: 96, control_capacity: 0 },
    )?;
    // No renderer or terminal is required for a host-owned output transport.
    session.write(&[b'x'; 96])?;
    assert_eq!(status(session.write(b"x")), Status::OutputBackpressure);
    assert_eq!(session.pump_until_quiet(&mut 0)?, [b'x'; 96]);
    let entries = vec![("TERM", "xterm"); sys::OT_SESSION_ENV_ENTRIES_MAX as usize + 1];
    assert_eq!(status(session.attach_renderer(8, 1, Remote::Local, &entries)), Status::InvalidArgument);
    let oversized = "x".repeat(sys::OT_SESSION_ENV_BYTES_MAX as usize);
    assert_eq!(status(session.attach_renderer(8, 1, Remote::Local, &[("TERM", &oversized)])), Status::InvalidArgument);
    assert_eq!(status(session.attach_renderer(0, 1, Remote::Local, &[])), Status::InvalidArgument);
    session.attach_renderer(8, 1, Remote::Auto, &[])?;
    session.resize(9, 2)?;
    let renderer = session.renderer_state()?;
    assert_eq!((renderer.width, renderer.height), (9, 2));
    Ok(())
}

#[test]
fn input_parses_into_caller_records_until_they_run_low() -> Result<()> {
    let context = context(1)?;
    let session = Session::new(
        &context,
        SessionOptions { chunk_size: 4096, span_capacity: 2, max_bytes: 8192, control_capacity: 0 },
    )?;
    let mut records = [sys::ot_input_event::default(); sys::OT_INPUT_EVENTS_MIN as usize];
    let mut payload = vec![0; sys::OT_INPUT_PAYLOAD_BYTES_MIN as usize];
    // The smallest sink holds one byte's events, so the Escape waits for another call.
    let drain = session.input_feed(b"a\x1b", 10, &mut records, &mut payload)?;
    assert_eq!((drain.consumed, drain.count, drain.deadline_ns), (1, 1, 0));
    assert_eq!((u32::from(records[0].kind), records[0].code), (sys::OT_INPUT_KEY, u32::from(b'a')));
    let drain = session.input_feed(b"\x1b", 10, &mut records, &mut payload)?;
    assert_eq!((drain.consumed, drain.count, drain.deadline_ns), (1, 0, 10 + sys::OT_INPUT_TIMEOUT_NS));
    assert_eq!(status(session.input_feed(b"", 10, &mut records[1..], &mut payload)), Status::InvalidArgument);
    assert_eq!(status(session.input_feed(b"", 10, &mut records, &mut payload[1..])), Status::InvalidArgument);
    // A reset drops the Escape, so its deadline passes without a key.
    session.input_reset(false)?;
    let drain = session.input_feed(b"", 10 + sys::OT_INPUT_TIMEOUT_NS, &mut records, &mut payload)?;
    assert_eq!((drain.count, drain.deadline_ns), (0, 0));
    assert_eq!(status(session.input_feed(b"", 9, &mut records, &mut payload)), Status::InvalidArgument);
    assert_eq!(status(session.input_expect(32)), Status::InvalidArgument);
    session.input_expect(sys::OT_INPUT_EXPECT_REPLIES)?;
    session.close()?;
    assert_eq!(status(session.input_feed(b"a", 20, &mut records, &mut payload)), Status::SessionClosed);
    assert_eq!(status(session.input_expect(0)), Status::SessionClosed);
    assert_eq!(status(session.input_reset(true)), Status::SessionClosed);
    Ok(())
}

#[test]
fn node_owners_reject_foreign_parents_and_survive_parent_drop() -> Result<()> {
    let first = context(3)?;
    let second = context(2)?;
    let first_session = session(&first, 8, 1)?;
    let second_session = session(&second, 8, 1)?;
    let root = Node::new(&first_session, NodeKind::Root, 1)?;
    let foreign = Node::new(&second_session, NodeKind::Root, 1)?;
    let text = Node::new(&first_session, NodeKind::Text, 2)?;
    text.insert_into(&root, 0)?;
    text.set_text("owned")?;
    assert_eq!(status(text.insert_into(&foreign, 0)), Status::WrongContext);
    assert_eq!(status(text.insert_into(&root, 2)), Status::InvalidArgument);
    drop(root);
    assert_eq!(text.text()?, "owned");
    let replacement = Node::new(&first_session, NodeKind::Root, 3)?;
    text.insert_into(&replacement, 0)?;
    assert_eq!(first_session.present()?, RenderOutcome::Pending);
    assert!(contains(&first_session.pump_until_quiet(&mut 0)?, b"owned"));
    Ok(())
}

#[test]
fn captured_frames_show_layout_borders_and_text() -> Result<()> {
    // Session, three nodes, and the capture lease.
    let context = context(5)?;
    let session = session(&context, 12, 3)?;
    let root = Node::new(&session, NodeKind::Root, 1)?;
    let panel = Node::new(&session, NodeKind::Box, 2)?;
    let label = Node::new(&session, NodeKind::Text, 3)?;
    panel.insert_into(&root, 0)?;
    label.insert_into(&panel, 0)?;
    panel.set_layout(LayoutProperty::Width(12.into()))?;
    panel.set_layout(LayoutProperty::Height(3.into()))?;
    panel.set_paint(&Paint { border: Sides::ALL, ..Default::default() })?;
    label.set_text("Hello")?;
    let draft = session.paint(Color::rgb(0, 0, 0), true, 0)?;
    assert_eq!(draft.capture()?.text(), "┌──────────┐\n│Hello     │\n└──────────┘");
    let rect = label.layout(Observation::Public)?;
    assert_eq!((rect.left, rect.top, rect.width, rect.height), (1.0, 1.0, 10.0, 1.0));
    assert_eq!((rect.screen_x, rect.screen_y), (1.0, 1.0));
    drop(draft);

    // Change the label, not the tree.
    label.set_text("Ready")?;
    panel.set_paint(&Paint { border: Sides::ALL, border_style: BorderStyle::Rounded, ..Default::default() })?;
    panel.set_box_details(&BoxDetails { title: "Hi", ..Default::default() })?;
    let capture = session.paint(Color::rgb(0, 0, 0), true, 0)?.capture()?;
    assert!(capture.row(0).starts_with('╭') && capture.row(0).contains("Hi"), "{}", capture.row(0));
    assert_eq!(capture.row(1), "│Ready     │");
    Ok(())
}

#[test]
fn spans_carry_colors_attributes_and_links_into_cells() -> Result<()> {
    let context = context(4)?;
    let session = session(&context, 10, 1)?;
    let root = Node::new(&session, NodeKind::Root, 1)?;
    let text = Node::new(&session, NodeKind::Text, 2)?;
    text.insert_into(&root, 0)?;
    let red = Color::rgb(255, 0, 0);
    text.set_spans(&["Open".fg(red).bold(), Span::styled("TUI", Style::new().underline()).link("https://x.test")])?;
    assert_eq!(text.text()?, "OpenTUI");
    let capture = session.paint(Color::rgb(0, 0, 0), true, 0)?.capture()?;
    assert_eq!(capture.text(), "OpenTUI");
    let open = capture.cell(0, 0).unwrap();
    assert_eq!((open.fg, open.attributes), (red, Attributes::BOLD));
    assert!(capture.cell(4, 0).unwrap().attributes.contains(Attributes::UNDERLINE));
    text.set_spans(&[])?;
    assert_eq!(text.text()?, "");
    Ok(())
}

#[test]
fn text_metrics_count_display_columns_not_bytes() -> Result<()> {
    let context = context(4)?;
    let session = session(&context, 20, 2)?;
    let root = Node::new(&session, NodeKind::Root, 1)?;
    let text = Node::new(&session, NodeKind::Text, 2)?;
    text.insert_into(&root, 0)?;
    text.set_text("héllo\r\nwide 世界")?;
    assert_eq!(text.text()?, "héllo\nwide 世界");
    let info = text.text_info()?;
    assert_eq!(info.byte_count as usize, "héllo\nwide 世界".len());
    assert_eq!((info.line_count, info.width_max, info.width_total), (2, 9, 14));
    // Width methods differ on joined emoji.
    let family = |method| context.text_width("👩\u{200d}👧", method);
    assert_eq!((family(WidthMethod::Unicode)?, family(WidthMethod::NoZwj)?), (2, 4));
    text.set_text_options(&TextOptions { align: crate::style::Alignment::Right, ..Default::default() })?;
    let capture = session.paint(Color::rgb(0, 0, 0), true, 0)?.capture()?;
    // Wide glyphs occupy two cells; the trailing cell has an empty symbol.
    assert_eq!(capture.row(1), format!("{}wide 世界", " ".repeat(11)));
    Ok(())
}

#[test]
fn layout_lengths_read_back_as_requested() -> Result<()> {
    let context = context(3)?;
    let session = session(&context, 8, 1)?;
    // Other nodes need the scene, which the root creates.
    assert_eq!(status(Node::new(&session, NodeKind::Box, 2)), Status::InvalidPhase);
    let _root = Node::new(&session, NodeKind::Root, 1)?;
    let node = Node::new(&session, NodeKind::Box, 2)?;
    // Native code stores finite margin, padding, position, and gap values beyond ±1e30 as ±1e30, and no others.
    for (property, length, expected) in [
        (LayoutProperty::Width as fn(_) -> _, 10.into(), Length::Cells(10.0)),
        (LayoutProperty::Height, Length::percent(50.0), Length::Percent(50.0)),
        (LayoutProperty::MinWidth, Length::Undefined, Length::Undefined),
        (|length| LayoutProperty::Padding(Edge::Left, length), 2.into(), Length::Cells(2.0)),
        (|length| LayoutProperty::Margin(Edge::Left, length), Length::Cells(9.9e29), Length::Cells(9.9e29)),
        (|length| LayoutProperty::Margin(Edge::Left, length), Length::Cells(1e30), Length::Cells(1e30)),
        (|length| LayoutProperty::Margin(Edge::Left, length), Length::Cells(1e31), Length::Cells(1e30)),
        (|length| LayoutProperty::Padding(Edge::Top, length), Length::Cells(-1e31), Length::Cells(-1e30)),
        (|length| LayoutProperty::Position(Edge::Left, length), Length::Cells(1e31), Length::Cells(1e30)),
        (|length| LayoutProperty::Gap(Gutter::Row, length), Length::Cells(1e31), Length::Cells(1e30)),
        (LayoutProperty::Width, Length::Cells(1e31), Length::Cells(1e31)),
    ] {
        node.set_layout(property(length))?;
        assert_eq!(node.layout_length(property(Length::Undefined))?, expected, "{:?}", property(length));
    }
    assert_eq!(status(node.set_layout(LayoutProperty::Width(Length::Cells(f32::INFINITY)))), Status::InvalidArgument);
    Ok(())
}

#[test]
fn frame_hooks_record_custom_paint_into_the_frame() -> Result<()> {
    let context = context(5)?;
    let session = session(&context, 12, 2)?;
    let root = Node::new(&session, NodeKind::Root, 1)?;
    let custom = Node::new(&session, NodeKind::Custom, 7)?;
    custom.insert_into(&root, 0)?;
    custom.set_layout(LayoutProperty::FlexGrow(1.0))?;
    custom.set_hooks(Hooks::UPDATE | Hooks::RENDER_SELF, 1, (0.0, 0.0))?;
    assert_eq!(status(session.paint(Color::rgb(0, 0, 0), true, 0)), Status::UnsupportedResource);

    let red = Color::rgb(255, 0, 0);
    let (mut updates, mut slots_seen) = (0, 0);
    let draft = session.frame(&FrameOptions::default(), |request| {
        match request {
            HostRequest::Update { num, .. } => {
                assert_eq!(num, 7);
                updates += 1;
            }
            HostRequest::Record { slots, recorder } => {
                slots_seen = slots.len();
                for slot in slots {
                    assert_eq!(slot.num, 7);
                    assert!(slot.hooks.contains(Hooks::RENDER_SELF));
                    recorder.begin(slot.index, Phase::Body)?;
                    let (x, y) = (slot.paint.screen_x as i32, slot.paint.screen_y as i32);
                    recorder.text(x, y, "hook", Style::new().fg(red))?;
                    recorder.fill(x, y + 1, 3, 1, Color::rgb(0, 0, 255))?;
                }
            }
            _ => {}
        }
        Ok(())
    })?;
    assert_eq!((updates, slots_seen), (1, 1));
    let capture = draft.capture()?;
    assert_eq!(capture.row(0).trim_end(), "hook");
    assert_eq!(capture.cell(0, 0).unwrap().fg, red);
    assert_eq!(capture.cell(2, 1).unwrap().bg, Color::rgb(0, 0, 255));
    drop(draft);

    // A hook that records nothing draws nothing in place of the node's body.
    let draft = session.frame(&FrameOptions::default(), |_| Ok(()))?;
    assert_eq!(draft.capture()?.text(), "\n");
    Ok(())
}

#[test]
fn host_errors_cancel_the_frame_attempt() -> Result<()> {
    let context = context(3)?;
    let session = session(&context, 4, 1)?;
    let root = Node::new(&session, NodeKind::Root, 1)?;
    let custom = Node::new(&session, NodeKind::Custom, 2)?;
    custom.insert_into(&root, 0)?;
    custom.set_hooks(Hooks::UPDATE, 1, (0.0, 0.0))?;
    let failed = session.frame(&FrameOptions::default(), |_| Err(Error::Usage("host hook failed")));
    assert!(matches!(failed, Err(Error::Usage("host hook failed"))));
    // The cancelled attempt does not block the next one.
    let mut draft = session.frame(&FrameOptions::default(), |_| Ok(()))?;
    assert_eq!(draft.commit(true)?, RenderOutcome::Pending);
    Ok(())
}

#[test]
fn frames_pass_scroll_requests_to_the_host() -> Result<()> {
    let context = context(4)?;
    let session = session(&context, 6, 2)?;
    let root = Node::new(&session, NodeKind::Root, 1)?;
    let scroll = Node::new(&session, NodeKind::Box, 2)?;
    scroll.insert_into(&root, 0)?;
    scroll.set_layout(LayoutProperty::FlexGrow(1.0))?;
    let bar = sys::ot_scene_scroll_bar_options { thickness: 1, ..Default::default() };
    let options = sys::ot_scene_scroll_options { axes: sys::OT_SCENE_SCROLL_Y, bars: [bar; 2], ..Default::default() };
    let status = unsafe { sys::ot_scene_set_scroll(context.as_raw(), &scroll.handle(), &options) };
    assert_eq!(status, sys::OT_OK);
    let text = Node::new(&session, NodeKind::Text, 3)?;
    text.insert_into(&scroll, 0)?;
    text.set_text("a\nb\nc")?;
    scroll.set_hooks(Hooks::SCROLL, 1, (0.0, 0.0))?;
    let scrolls = |session: &Session| -> Result<Vec<u32>> {
        let mut scrolls = Vec::new();
        drop(session.frame(&FrameOptions::default(), |request| {
            if let HostRequest::Scroll { num, .. } = request {
                scrolls.push(num);
            }
            Ok(())
        })?);
        Ok(scrolls)
    };
    // The first layout sizes the content, a frame without changes asks nothing, and new content asks again.
    assert_eq!(scrolls(&session)?, [2]);
    assert_eq!(scrolls(&session)?, [0; 0]);
    text.set_text("a\nb\nc\nd")?;
    assert_eq!(scrolls(&session)?, [2]);
    Ok(())
}

#[test]
fn drain_output_delivers_partial_writes_and_reports_failures() -> Result<()> {
    let context = context(1)?;
    let session = session(&context, 8, 1)?;
    session.write(b"hello world")?;
    let mut delivered = Vec::new();
    while delivered.len() < 11 {
        let written = session.drain_output(1024, |bytes| {
            let count = bytes.len().min(4);
            delivered.extend_from_slice(&bytes[..count]);
            Ok(count)
        })?;
        assert!(written > 0 && written <= 4);
    }
    assert_eq!(delivered, b"hello world");
    assert_eq!(session.drain_output(1024, |_| panic!("queue should be empty"))?, 0);

    session.write(b"later")?;
    let blocked = session.drain_output(1024, |_| Err(std::io::ErrorKind::WouldBlock.into()))?;
    assert_eq!(blocked, 0);
    assert_eq!(session.pump_until_quiet(&mut 0)?, b"later");

    session.write(b"broken")?;
    let failed = session.drain_output(1024, |_| Err(std::io::ErrorKind::BrokenPipe.into()));
    assert!(matches!(failed, Err(Error::Io(error)) if error.kind() == std::io::ErrorKind::BrokenPipe));
    assert_eq!(session.state()?, SessionState::Failed);
    Ok(())
}

#[test]
fn writer_panics_resume_after_native_code_returns() -> Result<()> {
    let context = context(1)?;
    let session = session(&context, 8, 1)?;
    session.write(b"x")?;
    let unwound = catch_unwind(AssertUnwindSafe(|| session.drain_output(16, |_| panic!("writer panic"))));
    assert!(unwound.is_err());
    assert_eq!(session.state()?, SessionState::Failed);
    Ok(())
}

#[test]
fn controls_and_capabilities_follow_terminal_setup() -> Result<()> {
    let context = context(1)?;
    let session = session(&context, 8, 2)?;
    // Non-cursor controls need an active terminal.
    assert_eq!(status(session.control(Control::Title("early"))), Status::InvalidPhase);
    session.setup_terminal(TerminalOptions {
        alternate_screen: true,
        mouse: MouseTracking::Buttons,
        kitty_keyboard: KittyKeyboard::DISAMBIGUATE,
        ..Default::default()
    })?;
    let mut now_ns = 0;
    let setup = session.pump_until_quiet(&mut now_ns)?;
    assert!(contains(&setup, b"\x1b[?1002h"), "{setup:?}");
    assert!(contains(&setup, b"\x1b]7501;?\x1b\\"), "{setup:?}");
    session.control(Control::Title("OpenTUI"))?;
    // This queue has one ordinary span, so a second packet waits for delivery.
    assert_eq!(status(session.control(Control::Mouse(MouseTracking::Off))), Status::OutputBackpressure);
    let output = session.pump_until_quiet(&mut now_ns)?;
    assert!(contains(&output, b"OpenTUI"), "{output:?}");
    assert_eq!(status(session.control(Control::Title("bad\x07title"))), Status::InvalidArgument);
    session.control(Control::Mouse(MouseTracking::Off))?;
    assert!(contains(&session.pump_until_quiet(&mut now_ns)?, b"\x1b[?1002l"));
    session.control(Control::Cursor(CursorUpdate {
        position: Some(CursorPosition { x: 2, y: 1, visible: true }),
        style: Some(CursorStyle::Line),
        ..Default::default()
    }))?;
    let capabilities = session.capabilities()?;
    assert!(capabilities.flags.contains(CapabilityFlags::RGB), "{capabilities:?}");
    assert_eq!(capabilities.kitty_keyboard, KittyKeyboard::DISAMBIGUATE);
    assert!(session.set_clipboard(ClipboardSelection::Primary, b"hi")?);
    assert!(contains(&session.pump_until_quiet(&mut now_ns)?, b"\x1b]52;p;aGk="));
    session.set_debug_overlay(true, Corner::BottomLeft)?;
    session.control(Control::CapabilityResponse(b"\x1b]7501;?\x1b\\"))?;
    assert!(session.capabilities()?.flags.contains(CapabilityFlags::PROGRAM_STATUS));
    // OSC 9 text loses its C1 controls (U+009C is ST) and a leading digit that would select a ConEmu subcommand.
    session.pump_until_quiet(&mut now_ns)?;
    // No title is not an empty one: OSC 777 puts the message in the title field and leaves the body empty.
    session.control(Control::CapabilityResponse(b"\x1bP>|ghostty 1.3.1\x1b\\"))?;
    session.pump_until_quiet(&mut now_ns)?;
    assert!(session.notify("done", None)?);
    assert!(contains(&session.pump_until_quiet(&mut now_ns)?, b"\x1b]777;notify;done;\x1b\\"));
    session.control(Control::CapabilityResponse(b"\x1b]1337;Capabilities=No\x1b\\"))?;
    session.pump_until_quiet(&mut now_ns)?;
    assert!(session.notify("4;1;50\u{9c}", None)?);
    let output = session.pump_until_quiet(&mut now_ns)?;
    assert!(contains(&output, b"\x1b]9; 4;1;50 \x1b\\"), "{:?}", String::from_utf8_lossy(&output));
    Ok(())
}

#[test]
fn program_status_reports_encode_every_state_and_reject_bad_records() -> Result<()> {
    let context = context(1)?;
    let session = session(&context, 8, 2)?;
    session.setup_terminal(TerminalOptions::default())?;
    let mut now_ns = 0;
    session.pump_until_quiet(&mut now_ns)?;
    let mut report = |record| -> Result<Vec<u8>> {
        session.control(Control::ProgramStatus(record))?;
        session.pump_until_quiet(&mut now_ns)
    };
    for (state, expected) in [
        (ProgramState::Idle, "state=idle:app=opencode"),
        (ProgramState::Working, "state=working:progress=40:app=opencode"),
        (ProgramState::Done, "state=done:app=opencode"),
        (ProgramState::Blocked(Some(ProgramKind::Question)), "state=blocked:kind=question:progress=40:app=opencode"),
        (ProgramState::Blocked(Some(ProgramKind::Auth)), "state=blocked:kind=auth:app=opencode"),
        (ProgramState::Blocked(None), "state=blocked:app=opencode"),
        (ProgramState::Error, "state=error:app=opencode"),
    ] {
        let progressing = expected.contains("progress");
        let progress = progressing.then_some(40);
        let output = report(ProgramStatus { state, app: "opencode", progress, ..Default::default() })?;
        let wanted = format!("\x1b]7501;{expected}\x1b\\");
        assert!(contains(&output, wanted.as_bytes()), "{state:?}: {:?}", String::from_utf8_lossy(&output));
    }
    let output = report(ProgramStatus { state: ProgramState::Clear, id: "ses_1/child", ..Default::default() })?;
    assert!(contains(&output, b"\x1b]7501;state=clear:id=ses_1/child\x1b\\"), "{output:?}");
    // Native code validates records: ids allow only a few punctuation bytes, and progress needs work or a block.
    assert_eq!(status(report(ProgramStatus { id: "has space", ..Default::default() })), Status::InvalidArgument);
    let idle = ProgramStatus { progress: Some(5), ..Default::default() };
    assert_eq!(status(report(idle)), Status::InvalidArgument);
    Ok(())
}

#[test]
fn capabilities_name_width_methods_multiplexers_and_forced_image_protocols() -> Result<()> {
    let context = context(3)?;
    let capabilities = session(&context, 4, 1)?.capabilities()?;
    assert_eq!(capabilities.multiplexer, Multiplexer::None);
    assert_eq!(capabilities.image_protocol, ImageProtocol::Auto);
    let session = Session::new(&context, SessionOptions::default())?;
    session.attach_renderer(4, 1, Remote::Remote, &[("TERM_PROGRAM", "tmux"), ("OPENTUI_IMAGE_PROTOCOL", "sixel")])?;
    let capabilities = session.capabilities()?;
    assert_eq!(capabilities.multiplexer, Multiplexer::Tmux);
    assert_eq!(capabilities.width_method, WidthMethod::Wcwidth);
    assert_eq!(capabilities.image_protocol, ImageProtocol::Sixel);
    // A host forwards only FORWARDED_ENVIRONMENT, which must hold every key native code reads.
    assert!(crate::host::FORWARDED_ENVIRONMENT.contains(&"OPENTUI_FORCE_TRUECOLOR"));
    for (environment, hyperlinks) in [
        (&[("VTE_VERSION", "5202")][..], true),
        (&[("VTE_VERSION", "5000")], false),
        (&[("TERM_PROGRAM", "vscode"), ("FORCE_HYPERLINK", "0")], false),
        (&[("FORCE_HYPERLINK", "1")], true),
        (&[("WT_SESSION", "1"), ("TERM", "xterm-256color")], true),
        (&[("XTERM_VERSION", "XTerm(390)"), ("KONSOLE_VERSION", "240202")], false),
    ] {
        assert!(environment.iter().all(|(key, _)| crate::host::FORWARDED_ENVIRONMENT.contains(key)), "{environment:?}");
        let session = Session::new(&context, SessionOptions::default())?;
        session.attach_renderer(4, 1, Remote::Local, environment)?;
        let flags = session.capabilities()?.flags;
        assert_eq!(flags.contains(CapabilityFlags::HYPERLINKS), hyperlinks, "{environment:?}");
    }
    // Before a DECRPM 2027 reply, the environment picks the width method; TERM wins over an inherited TERM_PROGRAM.
    for (environment, width_method) in [
        (&[("XTERM_VERSION", "XTerm(411)")][..], WidthMethod::Wcwidth),
        (&[("XTERM_VERSION", "XTerm(411)"), ("KONSOLE_VERSION", "250400")], WidthMethod::Unicode),
        (&[("TERM_PROGRAM", "vscode")], WidthMethod::Wcwidth),
        (&[("TERM", "xterm-kitty"), ("TERM_PROGRAM", "ghostty")], WidthMethod::Unicode),
        (&[("TERM", "xterm-256color"), ("OPENTUI_FORCE_WCWIDTH", "1")], WidthMethod::Wcwidth),
    ] {
        let session = Session::new(&context, SessionOptions::default())?;
        session.attach_renderer(4, 1, Remote::Local, environment)?;
        assert_eq!(session.capabilities()?.width_method, width_method, "{environment:?}");
    }
    // The terminal's own DECRPM 2027 reply decides over the environment: unrecognized means wcwidth.
    for (reply, width_method) in
        [(&b"\x1b[?2027;0$y"[..], WidthMethod::Wcwidth), (b"\x1b[?2027;2$y", WidthMethod::Unicode)]
    {
        let session = Session::new(&context, SessionOptions::default())?;
        session.attach_renderer(4, 1, Remote::Local, &[("TERM", "xterm-256color")])?;
        session.setup_terminal(TerminalOptions::default())?;
        let mut now_ns = 0;
        session.pump_until_quiet(&mut now_ns)?;
        session.control(Control::CapabilityResponse(reply))?;
        session.pump_until_quiet(&mut now_ns)?;
        assert_eq!(session.capabilities()?.width_method, width_method, "{reply:?}");
    }
    // Inside a multiplexer on the app's host, a remote terminal that reports synchronized output gets no wrapper.
    for host_multiplexer in [false, true] {
        let session = Session::new(&context, SessionOptions::default())?;
        session.attach_renderer(4, 1, Remote::Remote, &[("TERM", "xterm-256color")])?;
        session.setup_terminal(TerminalOptions { host_multiplexer, ..Default::default() })?;
        let mut now_ns = 0;
        session.pump_until_quiet(&mut now_ns)?;
        session.control(Control::CapabilityResponse(b"\x1b[?2026;2$y"))?;
        session.control(Control::CapabilityResponse(b"\x1b[?62;c"))?;
        session.pump_until_quiet(&mut now_ns)?;
        let _root = Node::new(&session, NodeKind::Root, 1)?;
        session.present()?;
        let frame = session.pump_until_quiet(&mut now_ns)?;
        assert_eq!(contains(&frame, b"\x1b[?2026h"), !host_multiplexer, "{frame:?}");
    }
    Ok(())
}

#[test]
fn editor_converts_byte_indices_and_cells() -> Result<()> {
    let context = context(1)?;
    for method in [WidthMethod::Unicode, WidthMethod::UnicodeWide, WidthMethod::Wcwidth, WidthMethod::NoZwj] {
        let buffer = EditBuffer::new(&context, method)?;
        buffer.set_tab_width(4)?;
        let emoji = if method == WidthMethod::NoZwj {
            [("👩‍", 2), ("💻", 2)]
        } else {
            [("👩‍💻", if method == WidthMethod::Wcwidth { 4 } else { 2 }), ("", 0)]
        };
        let units =
            [("a", 1), ("\t", 4), ("界", 2), emoji[0], emoji[1], ("e\u{301}", 1), ("\n", 1), ("\n", 1), ("\x0c", 2)];
        buffer.set_text("a\t界👩‍💻e\u{301}\r\n\r\n\x0c", false)?;
        let (mut index, mut offset) = (0, 0);
        for (unit, width) in units {
            for i in 0..unit.len() {
                assert_eq!(buffer.byte_index_to_cell_offset(index + i)?, offset);
            }
            for c in 0..width {
                assert_eq!(buffer.cell_offset_to_byte_index(offset + c)?, index);
            }
            assert_eq!(buffer.cell_offset_to_byte_index(buffer.byte_index_to_cell_offset(index)?)?, index);
            index += unit.len();
            offset += width;
        }
        assert_eq!(buffer.byte_index_to_cell_offset(index + 1)?, offset);
        assert_eq!(buffer.cell_offset_to_byte_index(offset + 1)?, index);
        buffer.set_text("\u{301}界", false)?;
        assert_eq!(buffer.cell_offset_to_byte_index(0)?, "\u{301}".len());
        let text = "ab\tcd";
        for i in 0..text.len() {
            buffer.set_text(text, false)?;
            let pos = |i| -> Result<_> {
                let p = buffer.position(EditQuery::Offset(buffer.byte_index_to_cell_offset(i)?))?.unwrap();
                Ok((p.row, p.col))
            };
            buffer.delete_range(pos(i)?, pos(i + 1)?)?;
            assert_eq!(buffer.text()?, format!("{}{}", &text[..i], &text[i + 1..]));
        }
    }
    Ok(())
}

#[test]
fn editor_nodes_paint_measure_and_edit_bound_buffers() -> Result<()> {
    // Session, two nodes, buffer, view, and capture lease.
    let context = context(6)?;
    let session = session(&context, 10, 3)?;
    let root = Node::new(&session, NodeKind::Root, 1)?;
    let editor = Node::new(&session, NodeKind::Editor, 2)?;
    editor.insert_into(&root, 0)?;
    let buffer = EditBuffer::new(&context, WidthMethod::Wcwidth)?;
    let view = EditorView::new(&buffer, 1, 1)?;
    editor.set_editor_view(Some(&view))?;
    buffer.set_text("hello\nworld", false)?;
    buffer.set_cursor(1, 5)?;
    buffer.insert("!")?;
    assert_eq!(buffer.text()?, "hello\nworld!");
    let info = buffer.info()?;
    assert_eq!((info.cursor, info.line_count, info.can_undo), ((1, 6), 2, true));
    assert!(buffer.undo()?);
    assert_eq!(buffer.text()?, "hello\nworld");
    let capture = session.paint(Color::rgb(0, 0, 0), true, 0)?.capture()?;
    // The node measured itself from its content and sized the view to its layout.
    assert_eq!(capture.text(), "hello\nworld\n");
    let rect = editor.layout(Observation::Public)?;
    assert_eq!((rect.width, rect.height), (10.0, 2.0));
    assert_eq!(view.viewport()?, Viewport { x: 0, y: 0, width: 10, height: 2 });

    buffer.set_cursor(0, 0)?;
    view.select_range(0, 5, SelectionColors::default())?;
    assert_eq!(view.selected_text()?, "hello");
    view.replace_selection("bye")?;
    assert_eq!(buffer.text()?, "bye\nworld");
    let next = buffer.position(EditQuery::NextWord)?.expect("word boundary");
    assert!(next.offset > 0, "{next:?}");
    view.set_placeholder(&["type here".into()])?;
    buffer.set_text("", false)?;
    let capture = session.paint(Color::rgb(0, 0, 0), true, 0)?.capture()?;
    assert_eq!(capture.row(0).trim_end(), "type here");
    Ok(())
}

// Expected: every selection call takes any subset of its colors. Actual: `TextView` and `EditorView` set the scene
// text-selection flags in `ot_editor_selection`, whose values are swapped, so one color failed with InvalidArgument.
#[test]
fn selections_take_each_subset_of_their_colors() -> Result<()> {
    let context = context(9)?;
    let session = session(&context, 5, 4)?;
    let root = Node::new(&session, NodeKind::Root, 1)?;
    let kinds = [NodeKind::Text, NodeKind::TextView, NodeKind::Editor, NodeKind::Editor];
    let nodes =
        (0..4).map(|index| Node::new(&session, kinds[index as usize], index + 2)).collect::<Result<Vec<_>>>()?;
    for (index, node) in (0..).zip(&nodes) {
        node.insert_into(&root, index)?;
    }
    nodes[0].set_text("hello")?;
    let text_buffer = TextBuffer::new(&context, WidthMethod::Unicode)?;
    text_buffer.set_text("hello")?;
    let text_view = TextView::new(&text_buffer)?;
    nodes[1].set_text_view(Some(&text_view))?;
    let edit_buffer = EditBuffer::new(&context, WidthMethod::Unicode)?;
    edit_buffer.set_text("hello", false)?;
    let (range, local) = (EditorView::new(&edit_buffer, 5, 1)?, EditorView::new(&edit_buffer, 5, 1)?);
    nodes[2].set_editor_view(Some(&range))?;
    nodes[3].set_editor_view(Some(&local))?;
    let (fg, bg) = (Some(Color::rgb(255, 0, 0)), Some(Color::rgb(0, 0, 255)));
    let transparent = Some(Color::TRANSPARENT);
    let rows = [(None, None), (fg, None), (None, bg), (fg, bg), (None, transparent)];
    for colors in rows.map(|(fg, bg)| SelectionColors { fg, bg }) {
        // Each row starts unselected, so a call that selects nothing cannot pass on the previous row's selection.
        nodes[0].clear_text_selection()?;
        text_view.clear_selection()?;
        range.clear_selection()?;
        local.clear_selection()?;
        nodes[0].select_text((0, 0), (1, 0), false, SelectionUnit::Cell, colors)?;
        text_view.select_local((0, 0), (1, 0), false, SelectionUnit::Cell, colors)?;
        range.select_range(0, 2, colors)?;
        local.select_local((0, 0), (1, 0), false, SelectionUnit::Cell, false, colors)?;
        let selected =
            [nodes[0].selected_text()?, text_view.selected_text()?, range.selected_text()?, local.selected_text()?];
        assert_eq!(selected, ["he"; 4], "{colors:?}");
        // Each view paints its selection as the scene text node does.
        let capture = session.paint(Color::BLACK, true, 0)?.capture()?;
        let cells = (0..4).map(|y| capture.cell(0, y).map(|cell| (cell.fg, cell.bg))).collect::<Vec<_>>();
        assert_eq!(cells, [cells[0]; 4], "{colors:?}");
        // A transparent background composites onto the frame, so only an opaque one paints as itself.
        let opaque = colors.bg.filter(|bg| bg.a == 255);
        assert!(opaque.is_none_or(|bg| cells[0].is_some_and(|cell| cell.1 == bg)), "{colors:?}");
    }
    Ok(())
}

#[test]
fn a_context_has_one_clipboard_service_whose_reads_finish() {
    use crate::native::{ClipboardOptions, ClipboardSelection, ClipboardService};
    let context = Context::new(ContextOptions::default()).unwrap();
    let service = ClipboardService::new(&context, ClipboardOptions::default()).unwrap();
    assert!(ClipboardService::new(&context, ClipboardOptions::default()).is_err());
    assert!(service.read(&[], ClipboardSelection::Clipboard, 1024, Duration::from_secs(1)).is_err());
    // Only reads: a test must not change the clipboard of the machine it runs on.
    let operation = service.read(&["text/plain"], ClipboardSelection::Clipboard, 1024, Duration::from_secs(1)).unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(3);
    let outcome = loop {
        service.drain();
        if let Some(outcome) = service.poll(operation) {
            break outcome;
        }
        assert!(std::time::Instant::now() < deadline, "the read never finished");
        std::thread::sleep(Duration::from_millis(1));
    };
    eprintln!("clipboard read: {outcome:?}");
    drop(service);
    // The service is gone, so the Context can start another.
    drop(ClipboardService::new(&context, ClipboardOptions::default()).unwrap());
}

#[test]
fn editor_views_report_their_visible_lines() {
    let context = Context::new(ContextOptions::default()).unwrap();
    let buffer = EditBuffer::new(&context, WidthMethod::Wcwidth).unwrap();
    buffer.set_text("one\ntwo is a longer line\nthree", false).unwrap();
    let view = EditorView::new(&buffer, 8, 3).unwrap();
    view.set_wrap(WrapMode::Word).unwrap();
    let lines = view.lines().unwrap();
    // Three rows: line 0, then line 1 wrapped over two rows.
    assert_eq!(
        lines.iter().map(|line| (line.source_line, line.wrap_index)).collect::<Vec<_>>(),
        [(0, 0), (1, 0), (1, 1)]
    );
}

// Expected: `TextView::lines` returns at most the lines there are, whatever the limit.
// Actual: it allocated room for `limit` lines before asking, so `lines(0, u32::MAX)` tried to allocate about 64 GiB.
#[test]
fn text_view_lines_allocate_room_for_the_whole_limit() -> Result<()> {
    let context = context(8)?;
    let buffer = TextBuffer::new(&context, WidthMethod::Unicode)?;
    buffer.set_text("one\ntwo\nthree")?;
    let view = TextView::new(&buffer)?;
    view.set_viewport(Viewport { x: 0, y: 0, width: 10, height: 10 })?;
    let lines = view.lines(0, u32::MAX)?;
    assert_eq!(lines.iter().map(|line| line.source_line).collect::<Vec<_>>(), [0, 1, 2]);
    assert_eq!(view.lines(1, u32::MAX)?, lines[1..]);
    assert_eq!(view.lines(0, 1)?, lines[..1]);
    assert!(view.lines(3, u32::MAX)?.is_empty());
    assert!(view.lines(u32::MAX, u32::MAX)?.is_empty());
    Ok(())
}

#[test]
fn buffers_draw_compose_resize_and_capture() -> Result<()> {
    let context = context(4)?;
    let buffer = Buffer::new(&context, 8, 2, WidthMethod::Unicode)?;
    assert_eq!(buffer.size(), (8, 2));
    buffer.clear(Color::BLUE)?;
    buffer.fill(6, 0, 4, 2, Color::RED)?;
    buffer.text(1, 0, "hi 界", Style::new().fg(Color::GREEN).bold())?;
    buffer.cell(0, 1, 'x', Style::new().fg(Color::WHITE).bg(Color::BLACK))?;
    let capture = buffer.capture()?;
    assert_eq!(capture.row(0), " hi 界  ");
    assert_eq!(capture.row(1), "x       ");
    assert_eq!(capture.to_string(), " hi 界\nx");
    assert_eq!(format!("{buffer:?}"), "Buffer { size: (8, 2), .. }");
    assert_eq!(format!("{context:?}"), "Context { .. }");
    let cell = capture.cell(1, 0).unwrap();
    assert_eq!((cell.fg, cell.bg, cell.attributes), (Color::GREEN, Color::BLUE, Attributes::BOLD));
    assert_eq!(capture.cell(7, 1).unwrap().bg, Color::RED);
    assert_eq!(capture.cell(0, 1).unwrap().bg, Color::BLACK);
    // Nothing lies outside the capture. `cell` and `row` once computed `y * width` in `u32` and overflowed.
    assert_eq!([(8, 0), (0, 2), (0, u32::MAX)].map(|(x, y)| capture.cell(x, y)), [None; 3]);
    assert_eq!([2, u32::MAX].map(|y| capture.row(y)), ["", ""]);

    let target = Buffer::new(&context, 10, 3, WidthMethod::Unicode)?;
    target.clear(Color::BLACK)?;
    target.compose(&buffer, 2, 1)?;
    let composed = target.capture()?;
    assert_eq!(composed.row(1), "   hi 界  ");
    assert_eq!(composed.row(2), "  x       ");
    assert_eq!(composed.cell(9, 2).unwrap().bg, Color::RED);
    assert_eq!(status(target.compose(&target, 0, 0)), Status::InvalidArgument);

    target.draw_box(0, 0, 10, 3, &BoxSpec { title: "t", ..BoxSpec::default() })?;
    assert_eq!(target.capture()?.row(0), "┌─t──────┐");
    buffer.resize(3, 1)?;
    assert_eq!(buffer.size(), (3, 1));
    assert_eq!(buffer.capture()?.row(0), "   ");
    assert!(buffer.resize(0, 1).is_err());
    assert_eq!(buffer.size(), (3, 1));
    let text = "x".repeat(sys::OT_BUFFER_TEXT_BYTES_MAX as usize + 1);
    assert!(matches!(buffer.text(0, 0, &text, Style::new()), Err(Error::Usage(_))));
    Ok(())
}

fn composed(terminal: &EmbeddedTerminal, buffer: &Buffer) -> Result<Capture> {
    terminal.compose(buffer, 0, 0)?;
    buffer.capture()
}

#[test]
fn embedded_terminals_parse_output_into_their_screen() -> Result<()> {
    let context = context(4)?;
    let options = EmbeddedTerminalOptions { cols: 12, rows: 3, ..Default::default() };
    let terminal = EmbeddedTerminal::new(&context, options)?;
    let buffer = Buffer::new(&context, 12, 3, WidthMethod::Unicode)?;
    assert_eq!(terminal.cursor()?.position, None);
    terminal.write(b"hello \x1b[1;31mred\x1b[0m\r\nwide: \xe7\x95")?;
    // The rest of the character arrives in the next write.
    terminal.write(b"\x8c")?;
    let capture = composed(&terminal, &buffer)?;
    assert_eq!(capture.text(), "hello red\nwide: 界\n");
    let red = capture.cell(6, 0).unwrap();
    assert!(red.attributes.contains(Attributes::BOLD));
    assert_ne!(red.fg, capture.cell(0, 0).unwrap().fg);
    let cursor = terminal.cursor()?;
    assert_eq!((cursor.position, cursor.visible, cursor.shape), (Some((8, 1)), true, TerminalCursorShape::Block));
    terminal.write(b"\x1b[5 q\x1b[?25l")?;
    terminal.compose(&buffer, 0, 0)?;
    let cursor = terminal.cursor()?;
    assert_eq!((cursor.visible, cursor.shape, cursor.blinking), (false, TerminalCursorShape::Bar, true));

    // Composing redraws only changed rows; a cleared target needs an invalidation.
    buffer.clear(Color::BLACK)?;
    assert_eq!(composed(&terminal, &buffer)?.text(), "\n\n");
    terminal.invalidate()?;
    assert_eq!(composed(&terminal, &buffer)?.text(), "hello red\nwide: 界\n");

    terminal.resize(5, 2)?;
    buffer.resize(5, 2)?;
    terminal.invalidate()?;
    terminal.write(b"\r\nabcdefg")?;
    assert_eq!(composed(&terminal, &buffer)?.text(), "abcde\nfg");
    assert!(terminal.resize(0, 2).is_err());
    Ok(())
}

#[test]
fn embedded_terminals_scroll_back_and_select() -> Result<()> {
    let context = context(4)?;
    let options = EmbeddedTerminalOptions { cols: 10, rows: 2, ..Default::default() };
    let terminal = EmbeddedTerminal::new(&context, options)?;
    let buffer = Buffer::new(&context, 10, 2, WidthMethod::Unicode)?;
    terminal.write(b"one\r\ntwo\r\nthree\r\nfour")?;
    assert_eq!(composed(&terminal, &buffer)?.text(), "three\nfour");
    terminal.scroll(-2)?;
    assert_eq!(composed(&terminal, &buffer)?.text(), "one\ntwo");
    assert_eq!(terminal.cursor()?.position, None);
    terminal.scroll(-5)?;
    assert_eq!(composed(&terminal, &buffer)?.text(), "one\ntwo");
    terminal.scroll_to_bottom()?;
    assert_eq!(composed(&terminal, &buffer)?.text(), "three\nfour");

    assert_eq!(terminal.selected_text()?, "");
    terminal.set_selection((2, 0), (1, 1))?;
    assert_eq!(terminal.selected_text()?, "ree\nfo");
    // Selected cells swap their colors.
    let capture = composed(&terminal, &buffer)?;
    assert_eq!(capture.cell(2, 0).unwrap().bg, capture.cell(0, 0).unwrap().fg);
    assert!(terminal.set_selection((10, 0), (0, 0)).is_err());
    terminal.clear_selection()?;
    assert_eq!(terminal.selected_text()?, "");

    let none = EmbeddedTerminal::new(&context, EmbeddedTerminalOptions { max_scrollback: 0, ..options })?;
    none.write(b"one\r\ntwo\r\nthree")?;
    none.scroll(-1)?;
    assert_eq!(composed(&none, &buffer)?.text(), "two\nthree");
    Ok(())
}

#[test]
fn embedded_terminals_encode_input_as_programs_ask() -> Result<()> {
    let context = context(4)?;
    let terminal =
        EmbeddedTerminal::new(&context, EmbeddedTerminalOptions { cols: 20, rows: 4, ..Default::default() })?;
    let key = |code, text: &str, modifiers| -> Result<Vec<u8>> {
        let unshifted = text.chars().next();
        terminal.encode_key(&TerminalKey { code, text, modifiers, unshifted, ..Default::default() })
    };
    assert_eq!(key("Enter", "", Modifiers::NONE)?, b"\r");
    assert_eq!(key("KeyC", "c", Modifiers::CTRL)?, b"\x03");
    assert_eq!(key("KeyA", "a", Modifiers::ALT)?, b"\x1ba");
    // The emulator has no Meta: Kitty Meta goes as Alt, not as Super.
    assert_eq!(key("KeyA", "a", Modifiers::META)?, b"\x1ba");
    assert_eq!(key("ArrowUp", "", Modifiers::NONE)?, b"\x1b[A");
    terminal.write(b"\x1b[>3u")?;
    assert_eq!(key("KeyA", "a", Modifiers::META)?, b"\x1b[97;3u");
    let release = TerminalKey {
        kind: KeyEventKind::Release,
        code: "KeyA",
        text: "a",
        unshifted: Some('a'),
        ..Default::default()
    };
    assert_eq!(terminal.encode_key(&release)?, b"\x1b[97;1:3u");
    terminal.write(b"\x1b[<u")?;

    assert_eq!(terminal.encode_paste(b"a\nb")?, b"a\rb");
    assert!(terminal.encode_focus(true)?.is_empty());
    terminal.write(b"\x1b[?2004h\x1b[?1004h")?;
    assert_eq!(terminal.encode_paste(b"a\nb")?, b"\x1b[200~a\nb\x1b[201~");
    assert_eq!(terminal.encode_focus(false)?, b"\x1b[O");

    let mouse = TerminalMouse {
        action: TerminalMouseAction::Press,
        button: Some(TerminalMouseButton::Left),
        modifiers: Modifiers::NONE,
        x: 3.0,
        y: 1.0,
        any_button_pressed: true,
    };
    assert!(!terminal.tracks_mouse()?);
    assert!(terminal.encode_mouse(&mouse)?.is_empty());
    terminal.write(b"\x1b[?1003h\x1b[?1006h")?;
    assert!(terminal.tracks_mouse()?);
    assert_eq!(terminal.encode_mouse(&mouse)?, b"\x1b[<0;4;2M");
    let wheel = TerminalMouse { button: Some(TerminalMouseButton::WheelDown), any_button_pressed: false, ..mouse };
    assert_eq!(terminal.encode_mouse(&wheel)?, b"\x1b[<65;4;2M");
    let motion =
        TerminalMouse { action: TerminalMouseAction::Motion, button: None, x: 5.0, any_button_pressed: false, ..mouse };
    assert_eq!(terminal.encode_mouse(&motion)?, b"\x1b[<35;6;2M");
    // Motion within the same cell is not repeated.
    assert!(terminal.encode_mouse(&motion)?.is_empty());
    Ok(())
}

#[test]
fn embedded_terminals_answer_queries_through_responses() -> Result<()> {
    let context = context(4)?;
    let terminal =
        EmbeddedTerminal::new(&context, EmbeddedTerminalOptions { cols: 20, rows: 4, ..Default::default() })?;
    assert!(terminal.drain_responses()?.is_empty());
    terminal.write(b"abc\x1b[6n\x1b[5n")?;
    assert_eq!(terminal.drain_responses()?, b"\x1b[1;4R\x1b[0n");
    // More than 1 MiB of replies keeps the first MiB, then reports the overflow once.
    let query = b"\x1b[5n";
    terminal.write(&query.repeat(TERMINAL_INPUT_BYTES_MAX / query.len()))?;
    terminal.write(query)?;
    let responses = terminal.drain_responses()?;
    assert_eq!(responses.len(), TERMINAL_INPUT_BYTES_MAX);
    assert!(responses.chunks(4).all(|reply| reply == b"\x1b[0n"));
    assert!(terminal.drain_responses()?.is_empty());
    Ok(())
}
