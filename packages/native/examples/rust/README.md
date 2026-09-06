# Rust binding example

`opentui` is a Cargo library that wraps OpenTUI's checked C
**application binary interface (ABI)**. It binds part of the
**application programming interface (API)**: contexts, sessions, scene nodes,
styled text, layout, painting, hit testing, and copied output tickets.

The library contains no JavaScript, event loop, terminal transport, or bridge
to the Zig implementation. Native code owns the scene and rendering. Rust owns the
resource lifetimes and decides when to pump work and deliver output.

## Create a scene

The safe owners borrow their dependencies: `Node` borrows `Session`, and
`Session` borrows `Context`. All three are non-cloneable, `!Send`, and `!Sync`.
Their `Drop` implementations release native resources on errors and unwinding.
Dropping a parent node detaches its surviving children. It does not destroy them.

```rust
use opentui::{ffi, Context, Node, Session};

fn main() -> opentui::Result<()> {
    let context = Context::new(ffi::ot_context_options {
        object_capacity: 16,
        render_cells_max: 80 * 24,
        ..Default::default()
    })?;
    let session = Session::new(&context, ffi::ot_session_options {
        chunk_size: 65536,
        span_capacity: 2,
        max_bytes: 131072,
        control_capacity: ffi::OT_SESSION_CONTROL_PACKET_BYTES,
        ..Default::default()
    })?;
    session.attach_renderer(80, 24, ffi::OT_SESSION_REMOTE_AUTO, &[])?;

    let root = Node::new(&session, ffi::OT_SCENE_ROOT, 1)?;
    let text = Node::new(&session, ffi::OT_SCENE_TEXT, 2)?;
    text.mount(&root)?;
    text.set_text(b"Hello from Rust")?;
    session.paint([0, 0, 0, 255], false, 0)?;
    Ok(())
}
```

This example paints a native framebuffer but does not present it. Call
`render(force)` to submit the painted frame. Then deliver output as described
below. See [`examples/tasks.rs`](examples/tasks.rs) for a complete host.

Renderer attachment is separate from `Session` creation. A `Session` can carry
output without a renderer. The attachment call copies the supplied environment
and never reads the process environment. It checks the encoded environment size
before allocating memory.

Dimensions and hit coordinates count terminal cells. Text and chunk lengths
count UTF-8 bytes. The text and **uniform resource locator (URL)** setters copy
their input.

## Drive output

`pump(now_ns, work_budget)` does bounded work without sleeping or running a
host callback. Use a monotonic nanosecond clock. Handle the returned status:

- `OT_PUMP_IDLE`: no work is ready.
- `OT_PUMP_AGAIN`: pump again when your scheduler permits.
- `OT_PUMP_WAIT_UNTIL`: wait until `deadline_ns` before continuing.
- `OT_PUMP_OUTPUT_PENDING`: call `read_output` with a host-owned byte buffer.
- `OT_PUMP_CLOSED`: graceful shutdown is complete.

`read_output` returns a ticket and copies `ticket.byte_count` bytes. Deliver all
of those bytes before you call `complete_output(&ticket, true)`. If the transport
fails, complete with `false`.

A copied ticket still counts against output limits. Only one ticket can be
outstanding. Do not acknowledge a ticket just because an asynchronous transport
queued a write.

`render` returns an `OT_RENDER_*` outcome separately from ABI errors:

- `PENDING`: output completion is necessary.
- `PRESENTED`: presentation is already complete.
- `SKIPPED` and `FAILED`: pumping does not retry the render.

Frame statistics and hit results describe completed presentation, not just
painted or copied output.

If you use terminal setup, call `setup_terminal` before the first frame. For
graceful shutdown, call `close`. Then keep pumping and completing output until
terminal restoration is complete. Dropping a `Session` cancels outstanding work
as a fallback, but it cannot restore a terminal.

If native cleanup returns an unexpected error, the library aborts instead of
silently leaking an owner. This invariant-failure policy also applies during
unwinding.

## Run the workbench

The [`workbench`](examples/workbench.rs) example is a keyboard-driven build
queue with live progress, a job inspector, searchable activity, a command prompt,
and a debug pane:

```sh
cargo run --offline --example workbench --features terminal-example
sh run.sh workbench
sh run.sh workbench static
```

## Run the task list

From this directory:

```sh
cargo run --offline --example tasks --features terminal-example
sh run.sh static
```

## Test the binding

```sh
cargo test --offline
cargo test --offline --examples --features terminal-example
sh test.sh
sh test.sh shared
sh test.sh static
```

`cargo test` runs the C/Rust ABI probe and behavior tests. The probe uses the
header packaged with the selected artifacts. Before it creates a `Context`, the
probe checks sizes, alignments, every field offset, constants, and the loaded ABI
version. The probe is test-only. It is not part of the binding library.

`sh test.sh` runs all checks.

Behavior tests cover copied text and URLs, rejected replacements, partial output
tickets, backpressure, failed delivery, cancellation, and restoration. They also
cover resource-slot reuse after errors and unwinding, foreign parents, and
parent-first destruction.

Only the test host advances a virtual clock and acknowledges bytes into a memory
sink. These tests do not exercise a terminal emulator or network. Resource checks
cover handles and checked destruction, not allocator-wide leak accounting.

Example tests also exercise fragmented input, Escape timeouts, and accounting for
frames per second. They cover bounded history and commands, queue state
transitions, and real native frames across pages and terminal sizes. Example
helpers remain outside the binding API.
