//! Post-processing: color matrices, filters, and effects against OpenTUI Core's output, and how filters attach to
//! widgets and the screen.
//!
//! `post_reference.txt` holds the cells Core's post-processing produces on [`pattern`]; regenerate it with
//! `OPENTUI_ROOT=... bun scripts/post-reference.ts`.

use opentui::native::Capture;
use opentui::post::{
    AsciiArt, Bloom, ChromaticAberration, Clouds, CrtRollingBar, Distortion, Flames, Noise, RainbowText, Scanlines,
    Vignette, from_fn,
};
use opentui::prelude::*;
use opentui::testing::TestApp;
use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::time::Duration;

const WIDTH: u32 = 12;
const HEIGHT: u32 = 6;
/// The seed the reference generator gives Core's `Math.random`.
const SEED: u64 = 42;

/// The cell at `(x, y)` of the test pattern: a character, a foreground (white on some cells), and a background.
/// Keep in sync with `pattern` in `scripts/post-reference.ts`.
fn pattern(x: u32, y: u32) -> (char, Color, Color) {
    let fg = if (x + 2 * y).is_multiple_of(5) {
        Color::rgb(255, 255, 255)
    } else {
        Color::rgb(
            ((x * 37 + y * 11) % 256) as u8,
            ((x * 53 + y * 29 + 100) % 256) as u8,
            ((x * 17 + y * 71 + 200) % 256) as u8,
        )
    };
    let bg = Color::rgb(
        ((x * 23 + y * 41 + 50) % 256) as u8,
        ((x * 7 + y * 61) % 256) as u8,
        ((x * 89 + y * 13 + 30) % 256) as u8,
    );
    (char::from(b'a' + ((x * 3 + y) % 26) as u8), fg, bg)
}

struct Pattern;

impl Component for Pattern {
    fn paint(&self, painter: &mut Painter<'_>) {
        for y in 0..HEIGHT {
            for x in 0..WIDTH {
                let (character, fg, bg) = pattern(x, y);
                painter.cell(x as i32, y as i32, character, Style::new().fg(fg).bg(bg));
            }
        }
    }
}

/// One cell of a reference case.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Expected {
    fg: [u8; 4],
    bg: [u8; 4],
    character: char,
}

fn reference(name: &str) -> Vec<Expected> {
    let text = include_str!("post_reference.txt");
    let mut lines = text.lines().skip_while(|line| *line != format!("case {name}")).skip(1);
    let mut field = |label: &str, digits: usize| -> Vec<u32> {
        let line = lines.next().unwrap_or_else(|| panic!("reference case {name} is missing"));
        let hex = line.strip_prefix(label).unwrap_or_else(|| panic!("{name}: expected {label}"));
        (0..hex.len() / digits)
            .map(|index| u32::from_str_radix(&hex[index * digits..][..digits], 16).unwrap())
            .collect()
    };
    let (fg, bg, chars) = (field("fg ", 2), field("bg ", 2), field("chars ", 2));
    let color =
        |plane: &[u32], cell: usize| -> [u8; 4] { std::array::from_fn(|channel| plane[cell * 4 + channel] as u8) };
    (0..(WIDTH * HEIGHT) as usize)
        .map(|cell| Expected {
            fg: color(&fg, cell),
            bg: color(&bg, cell),
            character: char::from_u32(chars[cell]).unwrap(),
        })
        .collect()
}

fn rgba(color: Color) -> [u8; 4] {
    [color.r, color.g, color.b, color.a]
}

/// Where the pattern goes: filling a screen of its own size, with the filter on the root, or as a widget at an
/// offset in a larger screen, with the filter on the widget.
#[derive(Clone, Copy, Debug)]
enum Placement {
    Screen,
    Widget,
}

const OFFSET: (u32, u32) = (3, 2);

fn pattern_app(placement: Placement) -> (TestApp, Custom<Pattern>) {
    match placement {
        Placement::Screen => {
            let app = TestApp::new(WIDTH as u16, HEIGHT as u16);
            let widget = Custom::new(&app, Pattern).grow(1.0);
            app.root().add(&widget);
            (app, widget)
        }
        Placement::Widget => {
            let app = TestApp::new(WIDTH as u16 + 5, HEIGHT as u16 + 4);
            let widget = Custom::new(&app, Pattern)
                .absolute()
                .position(Edge::Left, OFFSET.0)
                .position(Edge::Top, OFFSET.1)
                .size(WIDTH, HEIGHT);
            app.root().add(&widget);
            (app, widget)
        }
    }
}

/// Attaches `filter` where `placement` says, and returns the app and the pattern's top-left cell.
fn filtered(placement: Placement, filter: impl Filter) -> (TestApp, (u32, u32)) {
    let (app, widget) = pattern_app(placement);
    match placement {
        Placement::Screen => {
            app.root().add_filter(filter);
            (app, (0, 0))
        }
        Placement::Widget => {
            widget.add_filter(filter);
            (app, OFFSET)
        }
    }
}

/// Compares the pattern's cells with a reference case. `tolerance` allows channels to differ by that much.
fn assert_matches(capture: &Capture, at: (u32, u32), name: &str, tolerance: u8, compare_alpha: bool) {
    let expected = reference(name);
    for y in 0..HEIGHT {
        for x in 0..WIDTH {
            let cell = capture.cell(at.0 + x, at.1 + y).unwrap();
            let want = expected[(y * WIDTH + x) as usize];
            let close = |got: [u8; 4], want: [u8; 4]| {
                let channels = if compare_alpha { 4 } else { 3 };
                (0..channels).all(|channel| got[channel].abs_diff(want[channel]) <= tolerance)
            };
            assert!(
                close(rgba(cell.fg), want.fg) && close(rgba(cell.bg), want.bg),
                "{name} at ({x}, {y}): got fg {:?} bg {:?}, Core has fg {:?} bg {:?}",
                rgba(cell.fg),
                rgba(cell.bg),
                want.fg,
                want.bg,
            );
            assert_eq!(cell.symbol, want.character.to_string(), "{name} at ({x}, {y})");
        }
    }
}

const PLACEMENTS: [Placement; 2] = [Placement::Screen, Placement::Widget];

#[test]
fn the_pattern_matches_cores() {
    for placement in PLACEMENTS {
        let (app, _) = pattern_app(placement);
        let at = if let Placement::Widget = placement { OFFSET } else { (0, 0) };
        assert_matches(&app.render(), at, "original", 0, true);
    }
}

fn matrices() -> Vec<(&'static str, ColorMatrix)> {
    vec![
        ("sepia", ColorMatrix::SEPIA),
        ("protanopia_simulation", ColorMatrix::PROTANOPIA_SIMULATION),
        ("deuteranopia_simulation", ColorMatrix::DEUTERANOPIA_SIMULATION),
        ("tritanopia_simulation", ColorMatrix::TRITANOPIA_SIMULATION),
        ("achromatopsia", ColorMatrix::ACHROMATOPSIA),
        ("protanopia_compensation", ColorMatrix::PROTANOPIA_COMPENSATION),
        ("deuteranopia_compensation", ColorMatrix::DEUTERANOPIA_COMPENSATION),
        ("tritanopia_compensation", ColorMatrix::TRITANOPIA_COMPENSATION),
        ("technicolor", ColorMatrix::TECHNICOLOR),
        ("solarization", ColorMatrix::SOLARIZATION),
        ("synthwave", ColorMatrix::SYNTHWAVE),
        ("greenscale", ColorMatrix::GREENSCALE),
        ("grayscale", ColorMatrix::GRAYSCALE),
        ("invert", ColorMatrix::INVERT),
        ("sepia_half", ColorMatrix::SEPIA.strength(0.5)),
        ("grayscale_foreground", ColorMatrix::GRAYSCALE.channels(Channels::Foreground)),
        ("invert_filter", ColorMatrix::INVERT.strength(0.75)),
        ("brightness", ColorMatrix::brightness(0.2)),
        ("gain", ColorMatrix::gain(0.6)),
        ("saturation", ColorMatrix::saturation(1.8)),
    ]
}

#[test]
fn every_core_matrix_matches_on_the_screen_and_in_a_widget() {
    for (name, matrix) in matrices() {
        for placement in PLACEMENTS {
            let (app, at) = filtered(placement, matrix);
            assert_matches(&app.render(), at, name, 0, true);
        }
    }
}

#[test]
fn color_matrix_apply_matches_native_code() {
    for (name, matrix) in matrices() {
        let expected = reference(name);
        for y in 0..HEIGHT {
            for x in 0..WIDTH {
                let (_, fg, bg) = pattern(x, y);
                let want = expected[(y * WIDTH + x) as usize];
                let fg_applies = matrix.channels != Channels::Background;
                let bg_applies = matrix.channels != Channels::Foreground;
                if fg_applies {
                    assert_eq!(rgba(matrix.apply(fg)), want.fg, "{name} fg at ({x}, {y})");
                }
                if bg_applies {
                    assert_eq!(rgba(matrix.apply(bg)), want.bg, "{name} bg at ({x}, {y})");
                }
            }
        }
    }
}

/// Renders the pattern once with `filter`, `elapsed` after attaching it, in both placements, and compares the cells
/// with Core's.
fn check(name: &str, filter: impl Fn() -> Box<dyn Filter>, elapsed: Duration, tolerance: u8, compare_alpha: bool) {
    for placement in PLACEMENTS {
        let (app, at) = filtered(placement, filter());
        app.advance(elapsed);
        assert_matches(&app.render(), at, name, tolerance, compare_alpha);
    }
}

#[test]
fn filters_match_core() {
    check("scanlines", || Box::new(Scanlines::new(0.8, 2)), Duration::ZERO, 0, true);
    check("noise", || Box::new(Noise::new(0.3).seed(SEED)), Duration::ZERO, 0, true);
    check("chromatic_aberration", || Box::new(ChromaticAberration::new(2.0)), Duration::ZERO, 0, true);
    check("bloom", || Box::new(Bloom::new(0.6, 0.3, 2)), Duration::ZERO, 0, true);
    // Packed drawing clears attributes, which Core's raw writes keep; the pattern has none.
    check("ascii_art", || Box::new(AsciiArt::default()), Duration::ZERO, 0, true);
}

#[test]
fn effects_match_core() {
    // Core's zero matrix fades alpha too; the port keeps it, so only the colors compare.
    check("vignette", || Box::new(Vignette::new(0.7)), Duration::ZERO, 0, false);
    check("clouds", || Box::new(Clouds::new(0.2, 0.001, 0.8, 0.9).seed(SEED)), Duration::from_millis(500), 0, false);
    check("rainbow", || Box::new(RainbowText::new(0.01, 1.0, 1.0, 3.0)), Duration::from_millis(250), 0, true);
    // Native code blends in f32, Core in f64.
    check("crt", || Box::new(CrtRollingBar::new(4.0, 0.3, 0.5, 0.3)), Duration::from_millis(500), 1, true);
    let distortion = || {
        let mut distortion = Distortion::new().seed(SEED);
        distortion.color_glitch_chance = 0.4;
        distortion.max_glitch_lines = 4;
        Box::new(distortion) as Box<dyn Filter>
    };
    check("distortion", distortion, Duration::from_secs(2), 0, true);
}

#[test]
fn widget_filters_leave_other_cells_alone() {
    let (app, widget) = pattern_app(Placement::Widget);
    let before = app.render();
    widget.add_filter(ColorMatrix::INVERT);
    let after = app.render();
    for y in 0..after.height {
        for x in 0..after.width {
            let inside = (OFFSET.0..OFFSET.0 + WIDTH).contains(&x) && (OFFSET.1..OFFSET.1 + HEIGHT).contains(&y);
            let (old, new) = (before.cell(x, y).unwrap(), after.cell(x, y).unwrap());
            if inside {
                assert_ne!(old.bg, new.bg, "({x}, {y}) is inverted");
            } else {
                assert_eq!(old, new, "({x}, {y}) is untouched");
            }
        }
    }
}

#[test]
fn filters_cover_only_the_visible_part_of_a_widget() {
    let app = TestApp::new(10, 6);
    let scroll = ScrollBox::new(&app).scrollbars(false).height(3);
    let rows: Vec<Text> =
        (0..6).map(|row| Text::new(&app, format!("row {row}")).bg(Color::rgb(0, 0, 200)).width(10)).collect();
    for row in &rows {
        scroll.add(row);
    }
    app.root().add(&Text::new(&app, "above").bg(Color::rgb(0, 0, 200)).width(10)).add(&scroll);
    app.root().add(&Text::new(&app, "below").bg(Color::rgb(0, 0, 200)).width(10));
    app.render();
    // Rows 1 to 3 show at screen rows 1 to 3; the others are scrolled out of the box's clip.
    scroll.scroll_to(0.0, 1.0);
    for row in &rows {
        row.add_filter(ColorMatrix::INVERT);
    }
    let capture = app.render();
    let blue = |y: u32| capture.cell(0, y).unwrap().bg;
    assert_eq!(blue(0), Color::rgb(0, 0, 200), "the text above the scroll box");
    for y in 1..4 {
        assert_eq!(blue(y), Color::rgb(255, 255, 55), "visible rows are inverted");
    }
    assert_eq!(blue(4), Color::rgb(0, 0, 200), "the text below the scroll box");
    assert_eq!(capture.row(1).trim_end(), "row 1");
}

#[test]
fn filters_run_innermost_first_and_the_roots_last() {
    let app = TestApp::new(10, 6);
    let order = Rc::new(RefCell::new(Vec::new()));
    let record = |name: &'static str| {
        let order = Rc::clone(&order);
        from_fn(move |surface, _| order.borrow_mut().push((name, surface.origin(), surface.width(), surface.height())))
    };
    let inner = View::new(&app).size(4, 2).filter(record("inner"));
    let sibling = View::new(&app).size(2, 1).filter(record("sibling"));
    let outer = View::new(&app).padding(1).child(&inner).filter(record("outer")).filter(record("outer again"));
    app.root().add(&outer).add(&sibling).filter(record("root"));
    app.render();
    assert_eq!(
        *order.borrow(),
        [
            ("inner", (1, 1), 4, 2),
            ("outer", (0, 0), 10, 4),
            ("outer again", (0, 0), 10, 4),
            ("sibling", (0, 4), 2, 1),
            ("root", (0, 0), 10, 6),
        ]
    );
}

#[test]
fn hidden_and_detached_widgets_are_not_filtered() {
    let app = TestApp::new(6, 2);
    let runs = Rc::new(Cell::new(0));
    let counter = {
        let runs = Rc::clone(&runs);
        from_fn(move |_, _| runs.set(runs.get() + 1))
    };
    let text = Text::new(&app, "hi").filter(counter);
    app.root().add(&text);
    app.render();
    assert_eq!(runs.get(), 1);
    text.visible(false);
    app.render();
    text.visible(true).detach();
    app.render();
    assert_eq!(runs.get(), 1);
}

#[test]
fn animated_filters_keep_frames_coming_until_removed() {
    let app = TestApp::new(8, 2);
    app.root().add(&Text::new(&app, "frames"));
    app.render();
    assert!(!app.needs_frame());
    let elapsed = Rc::new(RefCell::new(Vec::new()));
    let filter = {
        let elapsed = Rc::clone(&elapsed);
        from_fn(move |_, time| elapsed.borrow_mut().push(time)).animated()
    };
    let id = app.root().add_filter(filter);
    assert!(app.needs_frame());
    app.render();
    app.advance(Duration::from_millis(40));
    assert!(app.needs_frame(), "an animated filter keeps frames coming");
    app.render();
    assert_eq!(*elapsed.borrow(), [Duration::ZERO, Duration::from_millis(40)]);
    assert!(app.root().remove_filter(id));
    assert!(!app.root().remove_filter(id));
    app.render();
    assert!(!app.needs_frame(), "frames stop once the filter is gone");
    assert_eq!(elapsed.borrow().len(), 2);

    // Clearing filters stops them too.
    app.root().filter(CrtRollingBar::default()).filter(ColorMatrix::SEPIA);
    app.render();
    assert!(app.needs_frame());
    app.root().clear_filters();
    app.render();
    assert!(!app.needs_frame());
}

#[test]
fn shared_filters_change_while_attached() {
    let (app, at) = filtered(Placement::Screen, ColorMatrix::IDENTITY.strength(0.0));
    let vignette = Rc::new(RefCell::new(Vignette::new(0.0)));
    app.root().clear_filters().filter(Rc::clone(&vignette));
    let corner = |app: &TestApp| app.render().cell(at.0, at.1).unwrap().bg;
    assert_eq!(rgba(corner(&app)), reference("original")[0].bg);
    vignette.borrow_mut().strength = 1.0;
    app.request_redraw();
    assert_eq!(rgba(corner(&app)), [0, 0, 0, 255]);
}

/// Draws its pattern, then filters a strip of itself in paint order.
struct Striped {
    clip: bool,
}

impl Component for Striped {
    fn paint(&self, painter: &mut Painter<'_>) {
        Pattern.paint(painter);
        if self.clip {
            painter.clip(0, 0, 2, 1, |painter| painter.color_matrix(0, 0, WIDTH, HEIGHT, &ColorMatrix::INVERT));
        } else {
            painter.color_matrix(-1, 1, 3, 100, &ColorMatrix::INVERT);
        }
    }
}

#[test]
fn painters_transform_colors_in_paint_order() {
    let app = TestApp::new(WIDTH as u16 + 2, HEIGHT as u16);
    let striped = Custom::new(&app, Striped { clip: false }).size(WIDTH, HEIGHT);
    // A child paints after its parent's hooks, so the parent's matrix does not reach it.
    let child = Text::new(&app, "kid").fg(Color::rgb(10, 20, 30)).bg(Color::rgb(40, 50, 60));
    striped.add(&child.absolute().position(Edge::Left, 0).position(Edge::Top, 2));
    app.root().add(&striped);
    let capture = app.render();
    let inverted = |x: u32, y: u32| {
        let (_, _, bg) = pattern(x, y);
        capture.cell(x, y).unwrap().bg == ColorMatrix::INVERT.apply(bg)
    };
    assert!(!inverted(0, 0), "above the rectangle");
    assert!(inverted(0, 1) && inverted(1, 1), "inside the rectangle, cut at the widget's left edge");
    assert!(!inverted(2, 1), "right of the rectangle");
    assert!(inverted(1, HEIGHT - 1), "the rectangle ends at the widget's bottom");
    assert_eq!(capture.cell(0, 2).unwrap().bg, Color::rgb(40, 50, 60), "the child paints later");
    assert_eq!(capture.cell(WIDTH, 1).unwrap().bg, app.theme().background, "outside the widget");

    striped.update(|striped| striped.clip = true);
    let capture = app.render();
    let inverted = |x: u32, y: u32| capture.cell(x, y).unwrap().bg == ColorMatrix::INVERT.apply(pattern(x, y).2);
    assert!(inverted(0, 0) && inverted(1, 0), "inside the clip");
    assert!(!inverted(2, 0) && !inverted(0, 1), "outside the clip");
}

#[test]
fn filters_leave_a_widgets_own_drawing_alone() {
    // Custom paints after its body and LineNumbers before; a filter's paint hook must not move either.
    let app = TestApp::new(16, 4);
    let editor = Textarea::new(&app).set_text("one\ntwo").grow(1.0);
    let numbers = opentui::widget::LineNumbers::new(&app, &editor).line_color(1, Color::rgb(90, 0, 0)).grow(1.0);
    let custom = Custom::new(&app, Pattern).height(1);
    app.root().add(&numbers).add(&custom);
    let before = app.render();
    numbers.add_filter(from_fn(|_, _| {}));
    custom.add_filter(from_fn(|_, _| {}));
    assert_eq!(app.render(), before);
    numbers.clear_filters();
    custom.clear_filters();
    assert_eq!(app.render(), before);
}

#[test]
fn surfaces_read_and_write_cells_in_their_area() {
    let app = TestApp::new(8, 2);
    let text = Text::new(&app, "ab日x").fg(Color::rgb(1, 2, 3)).bg(Color::rgb(4, 5, 6));
    app.root().add(&View::new(&app).padding_x(1).child(&text));
    let seen = Rc::new(RefCell::new(Vec::new()));
    text.add_filter({
        let seen = Rc::clone(&seen);
        from_fn(move |surface, _| {
            let mut seen = seen.borrow_mut();
            seen.push(format!("{:?} {}x{}", surface.origin(), surface.width(), surface.height()));
            for x in 0..surface.width() {
                seen.push(format!("{:?} {}", surface.char(x, 0), surface.is_grapheme(x, 0)));
            }
            assert_eq!(surface.fg(0, 0), Some(Color::rgb(1, 2, 3)));
            assert_eq!(surface.bg(1, 0), Some(Color::rgb(4, 5, 6)));
            assert_eq!(surface.fg(surface.width(), 0), None);
            assert_eq!(surface.bg(0, 1), None);
            surface.set_fg(1, 0, Color::RED);
            surface.set_bg(0, 0, Color::rgb(7, 8, 9));
            surface.set_bg(99, 0, Color::RED);
        })
    });
    let capture = app.render();
    // The text stretches across the view's inner width.
    assert_eq!(
        *seen.borrow(),
        [
            "(1, 0) 6x1",
            "Some('a') false",
            "Some('b') false",
            "None true",
            "None true",
            "Some('x') false",
            "Some(' ') false"
        ]
    );
    assert_eq!(capture.cell(2, 0).unwrap().fg, Color::RED);
    assert_eq!(capture.cell(1, 0).unwrap().bg, Color::rgb(7, 8, 9));
    assert_eq!(capture.row(0).trim_end(), " ab日x");
}

#[test]
fn ascii_art_redraws_graphemes() {
    let app = TestApp::new(6, 1);
    let black = View::new(&app).bg(Color::rgb(0, 0, 0)).grow(1.0);
    app.root().add(&black.child(&Text::new(&app, "a日b").bg(Color::rgb(255, 255, 255)).width(4)));
    app.root().filter(AsciiArt::default());
    let capture = app.render();
    assert_eq!(capture.row(0), "$$$$  ");
    assert_eq!(capture.cell(0, 0).unwrap().fg, Color::rgb(255, 255, 255));
    assert_eq!(capture.cell(5, 0).unwrap().bg, Color::rgb(0, 0, 0));
}

#[test]
fn vignettes_keep_grapheme_runs_in_one_style() {
    // Core's effects.test.ts: contiguous graphemes share one attenuation while other cells keep the gradient.
    let app = TestApp::new(24, 3);
    let style = Style::new().fg(Color::rgb(255, 255, 255)).bg(Color::rgb(80, 120, 160));
    let row = |text: &str| Text::new(&app, vec![Span::styled(text.to_owned(), style)]).width(24).height(1);
    app.root().add(&row("")).add(&row("  പരിശോധിക്കൽ|")).add(&row("  ASCII"));
    app.root().filter(Vignette::new(0.8));
    let capture = app.render();
    let graphemes: Vec<u32> = (0..24).filter(|&x| capture.cell(x, 1).unwrap().symbol.chars().count() > 1).collect();
    assert!(graphemes.len() > 1, "the Malayalam text forms grapheme cells");
    let first = capture.cell(graphemes[0], 1).unwrap();
    for &x in &graphemes[1..] {
        let cell = capture.cell(x, 1).unwrap();
        assert_eq!((cell.fg, cell.bg), (first.fg, first.bg), "grapheme cell {x}");
    }
    assert_ne!(capture.cell(2, 2).unwrap().fg, capture.cell(6, 2).unwrap().fg, "ASCII keeps the gradient");
    assert_ne!(capture.cell(0, 1).unwrap().bg, capture.cell(12, 1).unwrap().bg);
}

#[test]
fn distortion_moves_only_rows_without_graphemes() {
    let app = TestApp::new(12, 2);
    app.root().add(&Text::new(&app, "abcdefghijkl")).add(&Text::new(&app, "日本語のテキ"));
    let mut distortion = Distortion::new().seed(SEED);
    distortion.glitch_chance_per_second = 1000.0;
    distortion.color_glitch_chance = 0.0;
    distortion.shift_flip_ratio = 0.0;
    distortion.max_glitch_lines = 64;
    distortion.min_glitch_duration = Duration::from_secs(10);
    distortion.max_glitch_duration = Duration::from_secs(10);
    app.root().filter(distortion);
    app.advance(Duration::from_millis(16));
    let capture = app.render();
    assert_eq!(capture.row(0), "lkjihgfedcba", "the plain row flips");
    assert_eq!(capture.row(1), "日本語のテキ", "the wide row stays");
}

#[test]
fn flames_rise_from_the_bottom() {
    let app = TestApp::new(30, 10);
    app.root().add(&View::new(&app).bg(Color::rgb(0, 0, 0)).grow(1.0)).filter(Flames::default().seed(SEED));
    app.advance(Duration::from_millis(16));
    let capture = app.render();
    let red = |y: u32| (0..30).map(|x| u32::from(capture.cell(x, y).unwrap().bg.r)).sum::<u32>();
    assert!(red(9) > 4 * red(0).max(1), "bottom {} and top {}", red(9), red(0));
}

#[test]
fn noise_scales_colors_within_its_strength() {
    let (app, at) = filtered(Placement::Widget, Noise::new(0.2));
    let capture = app.render();
    let mut changed = 0;
    for y in 0..HEIGHT {
        for x in 0..WIDTH {
            let (_, _, bg) = pattern(x, y);
            let got = capture.cell(at.0 + x, at.1 + y).unwrap().bg;
            for (got, original) in [(got.r, bg.r), (got.g, bg.g), (got.b, bg.b)] {
                let original = f32::from(original);
                assert!(f32::from(got) >= (original * 0.8).floor() && f32::from(got) <= (original * 1.2).ceil());
            }
            changed += usize::from(got != bg);
        }
    }
    assert!(changed > (WIDTH * HEIGHT / 2) as usize);
}

#[test]
fn vignettes_keep_alpha() {
    let (app, at) = filtered(Placement::Screen, Vignette::new(1.0));
    let corner = app.render().cell(at.0, at.1).unwrap().clone();
    assert_eq!((corner.bg.r, corner.bg.g, corner.bg.b, corner.bg.a), (0, 0, 0, 255));
}
