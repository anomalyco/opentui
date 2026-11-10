//! Post-processing: Core's color matrices, filters, and animated effects on a monitor panel or the whole screen,
//! and a dialog over a page dimmed in paint order with `Painter::color_matrix`.
//!
//! Run with `sh run.sh effects`. Up/Down pick an effect, `s` switches between the monitor and the whole screen,
//! `d` toggles the dialog, and `q` quits.

use opentui::post::{
    AsciiArt, Bloom, ChromaticAberration, Clouds, CrtRollingBar, Distortion, Flames, Noise, RainbowText, Scanlines,
    Vignette,
};
use opentui::prelude::*;
use std::cell::Cell;
use std::rc::Rc;

const EFFECTS: [(&str, &str); 31] = [
    ("None", "No post-processing"),
    ("Sepia", "ColorMatrix::SEPIA"),
    ("Grayscale", "ColorMatrix::GRAYSCALE"),
    ("Invert", "ColorMatrix::INVERT"),
    ("Technicolor", "ColorMatrix::TECHNICOLOR"),
    ("Solarization", "ColorMatrix::SOLARIZATION"),
    ("Synthwave", "ColorMatrix::SYNTHWAVE"),
    ("Greenscale", "ColorMatrix::GREENSCALE"),
    ("Protanopia", "Simulated red blindness"),
    ("Deuteranopia", "Simulated green blindness"),
    ("Tritanopia", "Simulated blue blindness"),
    ("Achromatopsia", "Simulated color blindness"),
    ("Protanopia aid", "Compensation for red blindness"),
    ("Deuteranopia aid", "Compensation for green blindness"),
    ("Tritanopia aid", "Compensation for blue blindness"),
    ("Brightness", "ColorMatrix::brightness(0.15)"),
    ("Gain", "ColorMatrix::gain(0.6)"),
    ("Saturation", "ColorMatrix::saturation(2.0)"),
    ("Half sepia", "Sepia at strength 0.5"),
    ("Scanlines", "Every other background row darker"),
    ("Noise", "Random brightness per cell and frame"),
    ("Chromatic aberration", "Red and blue fringes"),
    ("ASCII art", "Characters from background brightness"),
    ("Bloom", "Bright cells light their neighbors"),
    ("Vignette", "Darker toward the corners"),
    ("Distortion", "Animated row glitches"),
    ("Clouds", "Animated cloud shadows"),
    ("Flames", "Animated flames from the bottom"),
    ("CRT rolling bar", "Animated bright bar"),
    ("Rainbow text", "Animated colors on white text"),
    ("Pip-Boy", "Vignette, greenscale, and a fast bar"),
];

fn filters(index: usize) -> Vec<Box<dyn Filter>> {
    let matrix = |matrix: ColorMatrix| -> Vec<Box<dyn Filter>> { vec![Box::new(matrix)] };
    match index {
        1 => matrix(ColorMatrix::SEPIA),
        2 => matrix(ColorMatrix::GRAYSCALE),
        3 => matrix(ColorMatrix::INVERT),
        4 => matrix(ColorMatrix::TECHNICOLOR),
        5 => matrix(ColorMatrix::SOLARIZATION),
        6 => matrix(ColorMatrix::SYNTHWAVE),
        7 => matrix(ColorMatrix::GREENSCALE),
        8 => matrix(ColorMatrix::PROTANOPIA_SIMULATION),
        9 => matrix(ColorMatrix::DEUTERANOPIA_SIMULATION),
        10 => matrix(ColorMatrix::TRITANOPIA_SIMULATION),
        11 => matrix(ColorMatrix::ACHROMATOPSIA),
        12 => matrix(ColorMatrix::PROTANOPIA_COMPENSATION),
        13 => matrix(ColorMatrix::DEUTERANOPIA_COMPENSATION),
        14 => matrix(ColorMatrix::TRITANOPIA_COMPENSATION),
        15 => matrix(ColorMatrix::brightness(0.15)),
        16 => matrix(ColorMatrix::gain(0.6)),
        17 => matrix(ColorMatrix::saturation(2.0)),
        18 => matrix(ColorMatrix::SEPIA.strength(0.5)),
        19 => vec![Box::new(Scanlines::new(0.6, 2))],
        20 => vec![Box::new(Noise::new(0.15))],
        21 => vec![Box::new(ChromaticAberration::new(2.0))],
        22 => vec![Box::new(AsciiArt::default())],
        23 => vec![Box::new(Bloom::new(0.6, 0.3, 2))],
        24 => vec![Box::new(Vignette::new(0.8))],
        25 => vec![Box::new(Distortion::default())],
        26 => vec![Box::new(Clouds::new(0.08, 0.0005, 0.7, 0.8))],
        27 => vec![Box::new(Flames::new(0.04, 0.02, 0.9))],
        28 => vec![Box::new(CrtRollingBar::new(6.0, 0.15, 0.5, 0.4))],
        29 => vec![Box::new(RainbowText::new(0.006, 1.0, 1.0, 2.0))],
        30 => vec![
            Box::new(Vignette::new(0.75)),
            Box::new(ColorMatrix::GREENSCALE),
            Box::new(CrtRollingBar::new(12.0, 0.08, 0.75, 0.15)),
        ],
        _ => Vec::new(),
    }
}

/// A colorful backdrop: hue across, brightness down.
struct Backdrop;

impl Component for Backdrop {
    fn paint(&self, painter: &mut Painter<'_>) {
        let (width, height) = painter.size();
        for y in 0..height {
            for x in 0..width {
                let hue = x as f32 / width.max(1) as f32 * 6.0;
                let level = 0.35 + 0.5 * (1.0 - y as f32 / height.max(1) as f32);
                let channel = |offset: f32| {
                    let distance = ((hue - offset).rem_euclid(6.0) - 3.0).abs();
                    ((distance - 1.0).clamp(0.0, 1.0) * level * 255.0) as u8
                };
                painter.fill(x as i32, y as i32, 1, 1, Color::rgb(channel(0.0), channel(2.0), channel(4.0)));
            }
        }
    }
}

/// Dims everything painted before it, at its place in paint order: the page under the dialog, not the dialog.
struct Scrim;

impl Component for Scrim {
    fn paint(&self, painter: &mut Painter<'_>) {
        let (width, height) = painter.size();
        painter.color_matrix(0, 0, width, height, &ColorMatrix::gain(0.35));
        painter.color_matrix(0, 0, width, height, &ColorMatrix::saturation(0.3));
    }
}

fn main() -> opentui::Result<()> {
    let app = App::new(AppOptions::default().with_title("OpenTUI effects"))?;
    let theme = app.theme();
    let white = Color::rgb(255, 255, 255);

    let list = Select::new(&app).options(EFFECTS).show_scroll_indicator(true).grow(1.0);
    let picker =
        View::new(&app).border(BorderStyle::Rounded).highlight_focus().title(" Effect ").width(30).child(&list);

    let backdrop = Custom::new(&app, Backdrop).grow(1.0).padding(1).gap(1);
    backdrop
        .add(&Text::new(&app, "OPENTUI POST-PROCESSING").fg(white).bold())
        .add(&Text::new(&app, "White text turns into a rainbow; colored text keeps its color.").fg(white))
        .add(
            &Text::new(&app, "Matrices run natively; cell filters read the painted frame.")
                .fg(Color::rgb(255, 220, 120)),
        )
        .add(&Text::new(&app, "Wide text stays whole: 日本語のテキスト 🦀").fg(white))
        .add(&Text::new(&app, "  bright  ").fg(Color::rgb(0, 0, 0)).bg(Color::rgb(255, 255, 240)));
    let monitor = View::new(&app).border(BorderStyle::Rounded).title(" Monitor ").grow(1.0).child(&backdrop);

    let target = Text::new(&app, "Filtering: the monitor").fg(theme.accent);
    let footer = Text::new(
        &app,
        vec![
            " ↑/↓".fg(theme.accent),
            " effect  ".fg(theme.muted),
            "s".fg(theme.accent),
            " monitor or screen  ".fg(theme.muted),
            "d".fg(theme.accent),
            " dialog  ".fg(theme.muted),
            "q".fg(theme.accent),
            " quit".fg(theme.muted),
        ],
    );

    let dialog = View::new(&app)
        .border(BorderStyle::Rounded)
        .border_color(theme.accent)
        .title(" Dialog ")
        .bg(theme.background)
        .padding_x(2)
        .padding_y(1)
        .width(44)
        .child(&Text::new(&app, "The page behind this dialog is dimmed by a Scrim component with Painter::color_matrix, in paint order, so the dialog keeps its colors. Press d to close."));
    let overlay = View::new(&app)
        .absolute()
        .position(Edge::All, 0)
        .z_index(10)
        .justify(Justify::Center)
        .align_items(Align::Center)
        .child(&Custom::new(&app, Scrim).absolute().position(Edge::All, 0))
        .child(&dialog)
        .visible(false);

    app.root()
        .add(&Text::new(&app, " OpenTUI post-processing ").bg(theme.accent).fg(theme.background).bold())
        .add(&View::new(&app).row().gap(1).grow(1.0).child(&picker).child(&monitor))
        .add(&View::new(&app).row().child(&footer.grow(1.0)).child(&target))
        .add(&overlay);

    let whole_screen = Rc::new(Cell::new(false));
    let apply = {
        let (app, monitor, list, whole_screen, target) =
            (app.clone(), monitor.clone(), list.clone(), Rc::clone(&whole_screen), target.clone());
        move || {
            app.root().clear_filters();
            monitor.clear_filters();
            let widget = if whole_screen.get() { app.root().as_any() } else { monitor.as_any() };
            for filter in filters(list.selected()) {
                widget.add_filter(filter);
            }
            target.set_text(if whole_screen.get() { "Filtering: the screen " } else { "Filtering: the monitor " });
        }
    };
    list.on_change({
        let apply = apply.clone();
        move |_cx, _index, _option| apply()
    });
    app.on_key(move |cx, key| {
        if key.matches("q") {
            cx.quit();
        } else if key.matches("s") {
            whole_screen.set(!whole_screen.get());
            apply();
        } else if key.matches("d") {
            overlay.visible(!overlay.is_visible());
        }
    });
    list.focus();
    app.run()
}
