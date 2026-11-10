//! Every built-in widget in one app: tabs switch between a form, a list with details, a live log fed by a background
//! thread, a file table with highlighted source, a diff, selectable styled text with an image, and rendered Markdown
//! with a text table. Pages fade in when you switch to them.
//!
//! Run with `sh run.sh showcase`. Tab moves focus, Left/Right switch pages while the tabs have focus, Ctrl+C quits.

use opentui::prelude::*;
use opentui::widget::{Image, ImageProtocol, MacOsScroll};
use std::collections::VecDeque;
use std::time::Duration;

const LANGUAGES: [(&str, &str); 12] = [
    ("Rust", "Memory safety without garbage collection"),
    ("Zig", "Explicit control and comptime"),
    ("TypeScript", "JavaScript with types"),
    ("Go", "Simple concurrency with goroutines"),
    ("OCaml", "Functional programming with a fast compiler"),
    ("Haskell", "Lazy, pure, and strongly typed"),
    ("C", "The portable assembler"),
    ("Python", "Batteries included"),
    ("Elixir", "Fault tolerance on the BEAM"),
    ("Swift", "Safe systems programming from Apple"),
    ("Kotlin", "A modern language for the JVM"),
    ("Lua", "Small, fast, and embeddable"),
];

struct LogLine(String);

/// A scrolling line chart of recent values between 0 and 1.
struct Sparkline {
    values: VecDeque<f32>,
    color: Color,
}

impl Component for Sparkline {
    fn paint(&self, painter: &mut Painter<'_>) {
        const BARS: [char; 8] = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
        let width = painter.width() as usize;
        let start = self.values.len().saturating_sub(width);
        for (x, value) in self.values.iter().skip(start).enumerate() {
            let bar = BARS[((value.clamp(0.0, 1.0) * 7.0).round()) as usize];
            painter.cell(x as i32, 0, bar, Style::new().fg(self.color));
        }
    }
}

fn label(app: &App, text: &str) -> Text {
    Text::new(app, text).fg(app.theme().muted).width(8)
}

fn form_page(app: &App) -> View {
    let theme = app.theme();
    // Ctrl+V reads the system clipboard; the terminal's own paste works too.
    let name =
        Input::new(app).placeholder("Type your name and press Enter").bind("ctrl+v", EditorAction::Paste).grow(1.0);
    let volume = Slider::new(app).range(0.0, 100.0).set_value(40.0).height(1).grow(1.0);
    let volume_value = Text::new(app, " 40%").width(5);
    let notes = Textarea::new(app).placeholder("Notes: Enter adds a line, Alt+Enter submits.").grow(1.0);
    let status = Text::new(app, "Nothing submitted yet.").fg(theme.muted);
    volume.on_change({
        let volume_value = volume_value.clone();
        move |_cx, value| {
            volume_value.set_text(format!(" {value:.0}%"));
        }
    });
    name.on_submit({
        let status = status.clone();
        move |_cx, value| {
            status.set_text(vec!["Hello, ".into(), value.to_owned().fg(theme.accent).bold(), "!".into()]);
        }
    });
    notes.on_change({
        let status = status.clone();
        move |_cx, text| {
            let lines = text.lines().count().max(1);
            status.set_text(format!(
                "Notes: {lines} line{}, {} characters.",
                if lines == 1 { "" } else { "s" },
                text.chars().count()
            ));
        }
    });
    View::new(app)
        .gap(1)
        .grow(1.0)
        .child(&View::new(app).row().child(&label(app, "Name")).child(&name))
        .child(&View::new(app).row().child(&label(app, "Volume")).child(&volume).child(&volume_value))
        .child(&View::new(app).border(BorderStyle::Rounded).highlight_focus().title(" Notes ").grow(1.0).child(&notes))
        .child(&status)
}

fn list_page(app: &App) -> View {
    let theme = app.theme();
    let list = Select::new(app).options(LANGUAGES).show_scroll_indicator(true).grow(1.0);
    let title = Text::new(app, LANGUAGES[0].0).fg(theme.accent).bold();
    let description = Text::new(app, LANGUAGES[0].1);
    let picked = Text::new(app, "Enter picks a language.").fg(theme.muted);
    list.on_change({
        let (title, description) = (title.clone(), description.clone());
        move |_cx, _index, option| {
            title.set_text(option.name.as_str());
            description.set_text(option.description.as_str());
        }
    });
    list.on_select({
        let picked = picked.clone();
        move |_cx, _index, option| {
            picked.set_text(format!("You picked {}.", option.name));
        }
    });
    let details = View::new(app)
        .border(BorderStyle::Rounded)
        .title(" Details ")
        .padding_x(1)
        .gap(1)
        .grow(1.0)
        .child(&title)
        .child(&description)
        .child(&picked);
    View::new(app)
        .row()
        .gap(1)
        .grow(1.0)
        .child(
            &View::new(app).border(BorderStyle::Rounded).highlight_focus().title(" Languages ").grow(1.0).child(&list),
        )
        .child(&details)
}

fn log_page(app: &App) -> View {
    let theme = app.theme();
    let log = ScrollBox::new(app).sticky(true).grow(1.0);
    let load = Custom::new(app, Sparkline { values: VecDeque::new(), color: theme.accent }).height(1);
    app.on_message({
        let (app, log) = (app.clone(), log.clone());
        move |_cx, LogLine(line): &LogLine| {
            let level = if line.contains("error") {
                theme.error
            } else if line.contains("warn") {
                theme.warning
            } else {
                theme.foreground
            };
            log.add(&Text::new(&app, line).fg(level));
            // Keep memory bounded: drop the oldest lines.
            let children = log.children();
            if children.len() > 500 {
                children[0].detach();
            }
        }
    });
    let proxy = app.proxy();
    std::thread::spawn(move || {
        let levels = ["info", "info", "info", "warn", "info", "error"];
        for tick in 0u64.. {
            std::thread::sleep(Duration::from_millis(350));
            let line = format!(
                "{:>5} {} request {} served in {} ms",
                tick,
                levels[tick as usize % levels.len()],
                tick * 7 % 97,
                3 + tick * 13 % 40
            );
            if proxy.send(LogLine(line)).is_err() {
                return;
            }
        }
    });
    // About 30 points a second, only while the page shows: a hidden page should not keep frames coming.
    let mut phase = 0.0f32;
    let step = Duration::from_millis(33);
    app.set_interval(step, {
        let load = load.clone();
        move |_cx| {
            phase += step.as_secs_f32();
            if !load.is_shown() {
                return;
            }
            let value = 0.5 + 0.35 * (phase * 1.7).sin() + 0.15 * (phase * 5.3).sin();
            load.update(|sparkline| {
                sparkline.values.push_back(value);
                if sparkline.values.len() > 512 {
                    sparkline.values.pop_front();
                }
            });
        }
    });
    View::new(app)
        .gap(1)
        .grow(1.0)
        .child(&View::new(app).row().child(&label(app, "Load")).child(&load.grow(1.0)))
        .child(&View::new(app).border(BorderStyle::Rounded).highlight_focus().title(" Log ").grow(1.0).child(&log))
}

/// Highlighted with the `tree-sitter` feature, which `sh run.sh` turns on. No bundled grammar knows TOML, so
/// `Cargo.toml` stays plain.
const FILES: [(&str, &str); 4] = [
    ("showcase.rs", include_str!("showcase.rs")),
    ("tasks.rs", include_str!("tasks.rs")),
    ("README.md", include_str!("../../../README.md")),
    ("Cargo.toml", include_str!("../Cargo.toml")),
];

fn data_page(app: &App) -> View {
    let table = Table::new(app)
        .set_columns([
            Column::new("File"),
            Column::new("Lines").width(ColumnWidth::Cells(6)).align(Alignment::Right),
            Column::new("Bytes").width(ColumnWidth::Cells(7)).align(Alignment::Right),
        ])
        .set_rows(
            FILES
                .iter()
                .map(|(name, source)| [name.to_string(), source.lines().count().to_string(), source.len().to_string()]),
        )
        .striped(true)
        .select(Some(0))
        .grow(1.0);
    let code = Code::new(app).filetype("rust").line_numbers(true).set_code(FILES[0].1).grow(1.0);
    table.on_change({
        let code = code.clone();
        move |_cx, index| {
            let (name, source) = FILES[index];
            code.filetype(opentui::syntax::filetype_for_path(name)).set_code(source).scroll_to(0);
        }
    });
    View::new(app)
        .row()
        .gap(1)
        .grow(1.0)
        .child(&View::new(app).border(BorderStyle::Rounded).highlight_focus().title(" Files ").width(32).child(&table))
        .child(&View::new(app).border(BorderStyle::Rounded).highlight_focus().title(" Source ").grow(1.0).child(&code))
}

const DOCS: &str = r#"# OpenTUI for Rust

A terminal UI framework built on **OpenTUI**'s native renderer. Native code lays out, paints, and encodes; Rust
handles input, focus, and your app's logic.

## Highlights

- Widgets are cheap handles: `Text::new(&app, "hi").fg(Color::GREEN)`
- Keys bubble from the focused widget to the app
- [x] Mouse selection copies through OSC 52
- [x] Tests run headless with `TestApp`

> Scroll this page with the mouse wheel, or focus it with Tab and use the arrow keys.

---

```rust
let app = App::new(AppOptions::default())?;
app.root().add(&Text::new(&app, "Hello"));
app.run()
```

```diff
@@ -1,2 +1,2 @@
-let width = text.len();
+let width = painter.text_width(text);
```

Read more at [opentui.com](https://opentui.com).
"#;

fn docs_page(app: &App) -> View {
    let theme = app.theme();
    let table = TextTable::new(app).border(BorderStyle::Rounded).cell_padding_x(1).set_content([
        vec!["Widget".fg(theme.accent).bold(), "What it shows".fg(theme.accent).bold()],
        vec!["TextTable".into(), "This grid: cells wrap, and columns fit the window. Drag across it to select.".into()],
        vec!["Markdown".into(), "The document above, with inline styles, lists, and highlighted code.".into()],
        vec!["Table".into(), "One-line rows you move through with the keyboard, on the Data page.".into()],
        vec!["Wide text".into(), "日本語 and emoji 🦀 keep the grid lines straight.".into()],
    ]);
    let scroll = ScrollBox::new(app)
        .content_padding(1)
        .content_gap(1)
        .scrollbar_arrows(true)
        .scroll_acceleration(MacOsScroll::default())
        .grow(1.0);
    scroll.add(&Markdown::new(app).set_markdown(DOCS)).add(&table);
    View::new(app)
        .grow(1.0)
        .child(&View::new(app).border(BorderStyle::Rounded).highlight_focus().title(" Docs ").grow(1.0).child(&scroll))
}

const PATCH: &str = "--- a/src/main.rs
+++ b/src/main.rs
@@ -1,10 +1,11 @@
 use opentui::prelude::*;
 
 fn main() -> opentui::Result<()> {
-    let app = App::new(AppOptions::default())?;
-    app.root().add(&Text::new(&app, \"Hello\"));
+    let app = App::new(AppOptions::default().with_theme(Theme::light()))?;
+    let greeting = Text::new(&app, \"Hello from Rust\").bold();
+    app.root().add(&greeting);
     app.on_key(|cx, key| {
-        if key.matches(\"q\") {
+        if key.matches(\"q\") || key.matches(\"escape\") {
             cx.quit();
         }
     });
";

/// A diff of a small program, switchable between one column and side by side with `v`.
fn diff_page(app: &App) -> View {
    let diff = Diff::new(app).filetype("rust").view(DiffView::Split).grow(1.0);
    diff.set_diff(PATCH);
    let hint =
        Text::new(app, "v toggles the split and unified views. The wheel scrolls both columns.").fg(app.theme().muted);
    let panel =
        View::new(app).border(BorderStyle::Rounded).highlight_focus().title(" src/main.rs ").grow(1.0).child(&diff);
    let split = std::cell::Cell::new(true);
    panel.on_key(move |cx, key| {
        if key.matches("v") {
            split.set(!split.get());
            diff.view(if split.get() { DiffView::Split } else { DiffView::Unified });
            cx.stop_propagation();
        }
    });
    View::new(app).grow(1.0).gap(1).child(&hint).child(&panel)
}

/// A small generated picture: a diagonal gradient between two theme colors.
fn gradient(app: &App, width: u32, height: u32) -> Option<Image> {
    let (from, to) = (app.theme().accent, app.theme().focus);
    let mut pixels = Vec::with_capacity((width * height * 4) as usize);
    for y in 0..height {
        for x in 0..width {
            let t = (x + y) as f32 / (width + height - 2) as f32;
            let mix = |a: u8, b: u8| (f32::from(a) + (f32::from(b) - f32::from(a)) * t) as u8;
            pixels.extend_from_slice(&[mix(from.r, to.r), mix(from.g, to.g), mix(from.b, to.b), 255]);
        }
    }
    Image::from_rgba(app.session().context(), width, height, &pixels).ok()
}

fn text_page(app: &App) -> View {
    let theme = app.theme();
    let intro = Text::new(
        app,
        vec![
            "OpenTUI".fg(theme.accent).bold(),
            " lays out, paints, and encodes everything here in native code. This page is plain ".into(),
            "styled text".italic(),
            " that wraps to the window. Drag across it to select; releasing the mouse copies the selection.".into(),
        ],
    )
    .selectable(true);
    let styles = Text::new(
        app,
        vec![
            "bold".bold(),
            "  ".into(),
            "dim".dim(),
            "  ".into(),
            "italic".italic(),
            "  ".into(),
            "underline".underline(),
            "  ".into(),
            "strikethrough".strikethrough(),
            "  ".into(),
            "inverse".inverse(),
        ],
    );
    let link = Text::new(
        app,
        vec!["Links work too: ".into(), "opentui.com".fg(theme.focus).underline().link("https://opentui.com")],
    );
    let wide = Text::new(app, "Wide glyphs take two cells: 日本語のテキスト, and emoji too: 🦀✨").selectable(true);
    let picture = ImageView::new(app).image(gradient(app, 64, 32)).protocol(ImageProtocol::Blocks).size(32, 8);
    let caption = Text::new(app, "An image from raw pixels, drawn with half blocks.").fg(theme.muted);
    View::new(app)
        .gap(1)
        .padding_x(1)
        .grow(1.0)
        .child(&intro)
        .child(&styles)
        .child(&link)
        .child(&wide)
        .child(&View::new(app).row().gap(2).align_items(Align::End).child(&picture).child(&caption))
}

fn main() -> opentui::Result<()> {
    let app = App::new(AppOptions::default().with_title("OpenTUI showcase"))?;
    let theme = app.theme();
    let pages = [
        form_page(&app),
        list_page(&app),
        log_page(&app),
        data_page(&app),
        diff_page(&app),
        text_page(&app),
        docs_page(&app),
    ];
    let tabs = TabSelect::new(&app)
        .tab_width(10)
        .show_description(false)
        .options(["Form", "List", "Log", "Data", "Diff", "Text", "Docs"]);
    for page in &pages[1..] {
        page.visible(false);
    }
    let fades: Vec<Timeline> = pages
        .iter()
        .map(|page| {
            let page = page.clone();
            let fade_in = Tween::new(0.0, 1.0).duration(Duration::from_millis(180)).ease(Easing::OutQuad);
            Timeline::new(&app).autoplay(false).add(
                Duration::ZERO,
                fade_in.on_update(move |_cx, opacity| {
                    page.opacity(opacity as f32);
                }),
            )
        })
        .collect();
    tabs.on_change({
        let pages = pages.clone();
        move |cx, index, _tab| {
            for (page_index, page) in pages.iter().enumerate() {
                page.visible(page_index == index);
            }
            fades[index].restart();
            cx.request_redraw();
        }
    });
    let footer = Text::new(
        &app,
        vec![
            " Tab".fg(theme.accent),
            " next field  ".fg(theme.muted),
            "←/→".fg(theme.accent),
            " switch page (on tabs)  ".fg(theme.muted),
            "F12".fg(theme.accent),
            " frame stats  ".fg(theme.muted),
            "Ctrl+C".fg(theme.accent),
            " quit".fg(theme.muted),
        ],
    );
    app.on_key_capture(|cx, key| {
        if key.matches("f12") {
            cx.toggle_debug_overlay();
            cx.stop_propagation();
        }
    });
    let body = View::new(&app).padding_x(1).grow(1.0);
    for page in &pages {
        body.add(page);
    }
    app.root()
        .add(
            &View::new(&app)
                .row()
                .child(&Text::new(&app, " OpenTUI ").bg(theme.accent).fg(theme.background).bold())
                .child(&tabs.grow(1.0)),
        )
        .add(&body)
        .add(&footer);
    tabs.focus();
    app.run()
}
