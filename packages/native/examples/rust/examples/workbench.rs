mod fps;
mod support;

use fps::{Fps, Timing};
use opentui::{ffi, Node, Session};
use std::{
    collections::VecDeque,
    time::{Duration, Instant},
};
use support::{Color, Input, Key, Result, Terminal};

const BACKGROUND: Color = [16, 20, 24, 255];
const PANEL: Color = [22, 27, 32, 255];
const FOREGROUND: Color = [216, 225, 231, 255];
const MUTED: Color = [132, 151, 164, 255];
const BORDER: Color = [56, 72, 83, 255];
const GREEN: Color = [115, 221, 174, 255];
const AMBER: Color = [237, 191, 104, 255];
const RED: Color = [245, 133, 122, 255];
const BLUE: Color = [126, 185, 235, 255];
const JOBS_MAX: usize = 64;
const EVENTS_MAX: usize = 128;
const INPUT_BYTES_MAX: usize = 48;
const WORKERS: usize = 3;
const NODE_CAPACITY: u32 = 128;
const NAMES: [&str; 12] = [
    "core / typecheck",
    "native / ABI contract",
    "yoga / layout tests",
    "rust / bindings",
    "react / reconciliation",
    "solid / lifecycle",
    "text / Unicode",
    "ssh / loopback",
    "examples / bundle",
    "native / render parity",
    "docs / links",
    "release / package",
];
const HELP: &[&str] = &[
    " NAVIGATION",
    " 1 / 2 / 3, Tab   Jobs / activity / help",
    " j/k or arrows    Move selection / scroll",
    " PgUp/PgDn        Move a page",
    " Home/End         First/last row",
    " /                Search jobs or activity",
    " Enter / Esc      Keep / clear filter",
    "",
    " QUEUE (simulation only)",
    " Space / Enter    Hold or release selected job",
    " r / x            Retry / cancel selected job",
    " a                Add a queued job (limit 64)",
    " p                Pause or resume simulation",
    " s                Sort jobs by state / ID",
    "",
    " HOST AND DEBUG",
    " ` or d           Toggle debug pane",
    " [ / ]            Limit redraws to 15 / 30 / 60 FPS",
    " f / c            Follow / clear activity",
    " :                Open command prompt",
    " q / Ctrl+C       Restore terminal and quit",
    "",
    " COMMANDS",
    " jobs, logs, help, add, retry, pause, resume",
    " debug, clear, fps 15, fps 30, fps 60, quit",
    "",
    " Input is ASCII. Replies and paste are ignored.",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Status {
    Queued,
    Running,
    Held,
    Done,
    Failed,
    Cancelled,
}

impl Status {
    fn label(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Running => "running",
            Self::Held => "held",
            Self::Done => "done",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }

    fn color(self) -> Color {
        match self {
            Self::Running | Self::Done => GREEN,
            Self::Held | Self::Queued => AMBER,
            Self::Failed => RED,
            Self::Cancelled => MUTED,
        }
    }

    fn rank(self) -> u8 {
        match self {
            Self::Failed => 0,
            Self::Running => 1,
            Self::Held => 2,
            Self::Queued => 3,
            Self::Done => 4,
            Self::Cancelled => 5,
        }
    }
}

struct Job {
    name: &'static str,
    status: Status,
    elapsed: Duration,
    duration: Duration,
    attempt: u32,
}

impl Job {
    fn progress(&self) -> f64 {
        (self.elapsed.as_secs_f64() / self.duration.as_secs_f64()).min(1.0)
    }

    fn stage(&self) -> &'static str {
        match self.status {
            Status::Done => "artifact ready",
            Status::Failed => "verification failed",
            Status::Cancelled => "cancelled by operator",
            Status::Queued => "waiting for a worker",
            Status::Held => "held by operator",
            Status::Running => ["resolve inputs", "compile", "verify", "package"][(self.progress() * 4.0) as usize % 4],
        }
    }
}

struct Event {
    at: Duration,
    level: &'static str,
    message: String,
}

impl Event {
    fn color(&self) -> Color {
        match self.level {
            "ERROR" => RED,
            "WARN" => AMBER,
            _ => MUTED,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Page {
    Jobs,
    Activity,
    Help,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Mode {
    Normal,
    Search,
    Command,
}

struct Model {
    jobs: Vec<Job>,
    events: VecDeque<Event>,
    selected: Option<usize>,
    page: Page,
    mode: Mode,
    query: String,
    command: String,
    sort_status: bool,
    log_offset: usize,
    help_offset: usize,
    paused: bool,
    debug: bool,
    target_fps: u32,
    last_key: String,
    dirty: bool,
}

impl Model {
    fn new() -> Self {
        let mut model = Self {
            jobs: Vec::with_capacity(JOBS_MAX),
            events: VecDeque::with_capacity(EVENTS_MAX),
            selected: Some(4),
            page: Page::Jobs,
            mode: Mode::Normal,
            query: String::new(),
            command: String::new(),
            sort_status: false,
            log_offset: 0,
            help_offset: 0,
            paused: false,
            debug: true,
            target_fps: 30,
            last_key: "none".into(),
            dirty: true,
        };
        for _ in 0..24 {
            model.add(Duration::ZERO);
        }
        for job in &mut model.jobs[..3] {
            job.status = Status::Done;
            job.elapsed = job.duration;
        }
        model.jobs[3].status = Status::Failed;
        model.jobs[3].elapsed = model.jobs[3].duration.mul_f64(0.7);
        model.log(Duration::ZERO, "WARN", "SIMULATION: no commands run and no system metrics are collected");
        model.log(Duration::ZERO, "INFO", "Ready. / searches, : opens commands, ? shows help");
        model
    }

    fn log(&mut self, at: Duration, level: &'static str, message: impl Into<String>) {
        self.dirty = true;
        if self.events.len() == EVENTS_MAX {
            self.events.pop_front();
        }
        let mut message = message.into();
        // All example input and generated messages are ASCII; byte clipping is cell clipping here.
        debug_assert!(message.is_ascii());
        message.truncate(120);
        let query = self.query.to_ascii_lowercase();
        let matches = message.to_ascii_lowercase().contains(&query) || level.to_ascii_lowercase().contains(&query);
        self.events.push_back(Event { at, level, message });
        if self.log_offset > 0 && matches {
            self.log_offset = (self.log_offset + 1).min(self.visible_events().len().saturating_sub(1));
        }
    }

    fn add(&mut self, now: Duration) {
        if self.jobs.len() == JOBS_MAX {
            self.log(now, "WARN", "Queue limit reached (64 jobs). Retry an existing job instead.");
            return;
        }
        let index = self.jobs.len();
        self.jobs.push(Job {
            name: NAMES[index % NAMES.len()],
            status: Status::Queued,
            elapsed: Duration::ZERO,
            duration: Duration::from_millis(5000 + (index as u64 % 9) * 1300),
            attempt: 1,
        });
        self.log(now, "INFO", format!("#{:02} queued: {}", index + 1, self.jobs[index].name));
    }

    fn tick(&mut self, delta: Duration, now: Duration) {
        if self.paused {
            return;
        }
        // A stalled transport must not trigger unbounded simulation catch-up.
        let delta = delta.min(Duration::from_millis(250));
        let mut running = self.jobs.iter().filter(|job| job.status == Status::Running).count();
        for index in 0..self.jobs.len() {
            if self.jobs[index].status == Status::Queued && running < WORKERS {
                self.jobs[index].status = Status::Running;
                running += 1;
                self.log(now, "INFO", format!("#{:02} started on simulated worker", index + 1));
            }
            let job = &mut self.jobs[index];
            if job.status != Status::Running {
                continue;
            }
            let elapsed = (job.elapsed + delta).min(job.duration);
            self.dirty |= elapsed != job.elapsed;
            job.elapsed = elapsed;
            let failed = index % 7 == 3 && job.attempt == 1 && job.progress() >= 0.7;
            if failed || job.elapsed == job.duration {
                job.status = if failed { Status::Failed } else { Status::Done };
                running -= 1;
                let message = format!("#{:02} {}: {}", index + 1, job.status.label(), job.name);
                self.log(now, if failed { "ERROR" } else { "INFO" }, message);
            }
        }
    }

    fn has_work(&self) -> bool {
        !self.paused && self.jobs.iter().any(|job| matches!(job.status, Status::Queued | Status::Running))
    }

    fn visible_jobs(&self) -> Vec<usize> {
        let query = self.query.to_ascii_lowercase();
        let mut indexes: Vec<_> = self
            .jobs
            .iter()
            .enumerate()
            .filter(|(_, job)| job.name.to_ascii_lowercase().contains(&query))
            .map(|(index, _)| index)
            .collect();
        if self.sort_status {
            indexes.sort_by_key(|&index| (self.jobs[index].status.rank(), index));
        }
        indexes
    }

    fn visible_events(&self) -> Vec<&Event> {
        let query = self.query.to_ascii_lowercase();
        self.events
            .iter()
            .filter(|event| {
                event.message.to_ascii_lowercase().contains(&query) || event.level.to_ascii_lowercase().contains(&query)
            })
            .collect()
    }

    fn select(&mut self, delta: i32) {
        let indexes = self.visible_jobs();
        let position = indexes.iter().position(|&index| Some(index) == self.selected).unwrap_or(0);
        let next = (position as i32 + delta).clamp(0, indexes.len().saturating_sub(1) as i32) as usize;
        let selected = indexes.get(next).copied();
        self.dirty |= selected != self.selected;
        self.selected = selected;
    }

    fn job_action(&mut self, action: &str, now: Duration) {
        let Some(index) = self.selected else {
            return;
        };
        let job = &mut self.jobs[index];
        match action {
            "retry" => {
                job.elapsed = Duration::ZERO;
                job.attempt = job.attempt.saturating_add(1);
                job.status = Status::Queued;
            }
            "cancel" => job.status = Status::Cancelled,
            "hold" => match job.status {
                Status::Held => job.status = Status::Queued,
                Status::Running | Status::Queued => job.status = Status::Held,
                _ => {
                    self.log(now, "WARN", "Use r to retry a finished job");
                    return;
                }
            },
            _ => unreachable!(),
        }
        let message = format!("#{:02} {} requested; now {}", index + 1, action, job.status.label());
        self.log(now, "INFO", message);
    }

    fn execute(&mut self, command: &str, now: Duration) -> bool {
        self.dirty = true;
        match command.trim() {
            "quit" | "q" => return false,
            "pause" => {
                self.paused = true;
                self.log(now, "INFO", "Simulation paused; redraws wait for changes");
            }
            "resume" => {
                self.paused = false;
                self.log(now, "INFO", "Simulation resumed");
            }
            "add" => self.add(now),
            "retry" => self.job_action("retry", now),
            "debug" => {
                self.debug = !self.debug;
                self.log(now, "INFO", format!("Debug telemetry {}", if self.debug { "enabled" } else { "disabled" }));
            }
            "clear" => {
                self.events.clear();
                self.log_offset = 0;
                self.log(now, "INFO", "Activity cleared");
            }
            "jobs" => self.page = Page::Jobs,
            "logs" => self.page = Page::Activity,
            "help" => self.page = Page::Help,
            "fps 15" => self.target_fps = 15,
            "fps 30" => self.target_fps = 30,
            "fps 60" => self.target_fps = 60,
            "" => {}
            _ => self.log(now, "ERROR", format!("Unknown command: {command}. Try help, pause, add, debug, fps 60.")),
        }
        true
    }

    fn key(&mut self, key: Key, now: Duration, rows: usize) -> bool {
        let last_key = format!("{key:?}");
        self.dirty |= self.last_key != last_key;
        self.last_key = last_key;
        if key == Key::Interrupt {
            return false;
        }
        if self.mode != Mode::Normal {
            let line = if self.mode == Mode::Search { &mut self.query } else { &mut self.command };
            match key {
                Key::Escape => {
                    line.clear();
                    self.mode = Mode::Normal;
                    self.dirty = true;
                }
                Key::Enter => {
                    let command = (self.mode == Mode::Command).then(|| std::mem::take(line));
                    self.mode = Mode::Normal;
                    self.dirty = true;
                    if let Some(command) = command {
                        return self.execute(&command, now);
                    }
                }
                Key::Backspace => {
                    self.dirty |= line.pop().is_some();
                }
                Key::Char(byte) if (byte.is_ascii_graphic() || byte == b' ') && line.len() < INPUT_BYTES_MAX => {
                    line.push(byte as char);
                    self.dirty = true;
                }
                _ => {}
            }
            self.dirty |= self.log_offset != 0;
            self.log_offset = 0;
            if !self.visible_jobs().iter().any(|&index| Some(index) == self.selected) {
                self.select(0);
            }
            return true;
        }
        let movement = match key {
            Key::Down | Key::Char(b'j') => 1,
            Key::Up | Key::Char(b'k') => -1,
            Key::PageDown => rows.max(1) as i32,
            Key::PageUp => -(rows.max(1) as i32),
            Key::Home => -(JOBS_MAX.max(EVENTS_MAX) as i32),
            Key::End => JOBS_MAX.max(EVENTS_MAX) as i32,
            _ => 0,
        };
        if movement != 0 {
            let offsets = (self.log_offset, self.help_offset);
            if self.page == Page::Activity {
                let maximum = self.visible_events().len().saturating_sub(rows.max(1));
                self.log_offset = (self.log_offset.min(maximum) as i32 - movement).clamp(0, maximum as i32) as usize;
            } else if self.page == Page::Help {
                self.help_offset = (self.help_offset as i32 + movement)
                    .clamp(0, HELP.len().saturating_sub(rows.max(1)) as i32)
                    as usize;
            } else {
                self.select(movement);
            }
            self.dirty |= offsets != (self.log_offset, self.help_offset);
            return true;
        }
        match key {
            Key::Char(b'q') => return false,
            Key::Char(b'1') => self.page = Page::Jobs,
            Key::Char(b'2') => self.page = Page::Activity,
            Key::Char(b'3' | b'?') => self.page = Page::Help,
            Key::Tab => {
                self.page = match self.page {
                    Page::Jobs => Page::Activity,
                    Page::Activity => Page::Help,
                    Page::Help => Page::Jobs,
                }
            }
            Key::Char(b'/') if self.page != Page::Help => {
                self.mode = Mode::Search;
                self.query.clear();
                self.select(0);
            }
            Key::Char(b':') => {
                self.mode = Mode::Command;
                self.command.clear();
            }
            Key::Escape => {
                self.query.clear();
                self.select(0);
            }
            Key::Char(b'`' | b'd') => {
                self.execute("debug", now);
            }
            Key::Char(b'p') => {
                self.execute(if self.paused { "resume" } else { "pause" }, now);
            }
            Key::Char(b'a') => self.add(now),
            Key::Char(b'r') => self.job_action("retry", now),
            Key::Char(b'x') => self.job_action("cancel", now),
            Key::Char(b' ') | Key::Enter if self.page == Page::Jobs => self.job_action("hold", now),
            Key::Char(b's') => self.sort_status = !self.sort_status,
            Key::Char(b'f') => self.log_offset = 0,
            Key::Char(b'c') if self.page == Page::Activity => {
                self.execute("clear", now);
            }
            Key::Char(b'[') => self.target_fps = if self.target_fps == 60 { 30 } else { 15 },
            Key::Char(b']') => self.target_fps = if self.target_fps == 15 { 30 } else { 60 },
            _ => return true,
        }
        self.dirty = true;
        true
    }
}

// These small layout helpers use the checked Yoga groups/kinds from opentui.h.
fn height(node: &Node<'_, '_>, rows: usize) -> Result<()> {
    node.set_style(4, 1, 0, 1, rows as f32, 1)?;
    Ok(())
}

fn visible(node: &Node<'_, '_>, show: bool) -> Result<()> {
    node.set_style(0, 9, 0, 0, if show { 0.0 } else { 1.0 }, 0)?;
    Ok(())
}

fn child<'s, 'c>(
    session: &'s Session<'c>,
    parent: &Node<'_, '_>,
    kind: u32,
    index: u32,
    next: &mut u32,
) -> Result<Node<'s, 'c>> {
    let node = Node::new(session, kind, *next)?;
    *next += 1;
    node.mount_at(parent, index)?;
    node.set_style(2, 2, 0, 1, 0.0, 0)?; // min-width = 0; labels must not force columns wider.
    node.set_style(2, 3, 0, 1, 0.0, 0)?;
    if kind == ffi::OT_SCENE_TEXT {
        height(&node, 1)?;
    }
    Ok(node)
}

fn paint_box(node: &Node<'_, '_>, border: bool, background: Color) -> Result<()> {
    node.set_paint(&ffi::ot_scene_paint_options {
        opacity: 1.0,
        border_sides: if border { 15 } else { 0 },
        border_color: BORDER,
        should_fill: 1,
        background,
        ..Default::default()
    })?;
    Ok(())
}

fn label(node: &Node<'_, '_>, value: &str, columns: usize, color: Color, bold: bool) -> Result<()> {
    debug_assert!(value.is_ascii());
    support::text(node, &value[..value.len().min(columns)], color, bold)
}

struct Panel<'s, 'c> {
    node: Node<'s, 'c>,
    heading: Node<'s, 'c>,
    lines: Vec<Node<'s, 'c>>,
}

impl<'s, 'c> Panel<'s, 'c> {
    fn new(session: &'s Session<'c>, parent: &Node<'_, '_>, index: u32, count: usize, next: &mut u32) -> Result<Self> {
        let node = child(session, parent, ffi::OT_SCENE_BOX, index, next)?;
        paint_box(&node, true, PANEL)?;
        node.set_style(0, 8, 0, 0, 1.0, 0)?; // Clip children at the panel edge.
        let heading = child(session, &node, ffi::OT_SCENE_TEXT, 0, next)?;
        let mut lines = Vec::with_capacity(count);
        for index in 0..count {
            lines.push(child(session, &node, ffi::OT_SCENE_TEXT, index as u32 + 1, next)?);
        }
        Ok(Self { node, heading, lines })
    }

    fn fill(&self, title: &str, lines: &[(String, Color)], columns: usize, rows: usize) -> Result<()> {
        label(&self.heading, title, columns, BLUE, true)?;
        for (index, node) in self.lines.iter().take(rows).enumerate() {
            let (content, color) = lines.get(index).map(|(line, color)| (line.as_str(), *color)).unwrap_or(("", MUTED));
            label(node, content, columns, color, false)?;
        }
        Ok(())
    }
}

struct View<'s, 'c> {
    _root: Node<'s, 'c>,
    header: Node<'s, 'c>,
    tabs: Node<'s, 'c>,
    summary: Node<'s, 'c>,
    body: Node<'s, 'c>,
    list: Panel<'s, 'c>,
    inspector: Panel<'s, 'c>,
    debug: Panel<'s, 'c>,
    prompt: Node<'s, 'c>,
    footer: Node<'s, 'c>,
    layout: (u32, u32, bool),
    rows: usize,
    columns: usize,
    inspector_visible: bool,
    debug_visible: bool,
    small: bool,
}

impl<'s, 'c> View<'s, 'c> {
    fn new(session: &'s Session<'c>) -> Result<Self> {
        let root = Node::new(session, ffi::OT_SCENE_ROOT, 1)?;
        paint_box(&root, false, BACKGROUND)?;
        let mut next = 2;
        let header = child(session, &root, ffi::OT_SCENE_TEXT, 0, &mut next)?;
        let tabs = child(session, &root, ffi::OT_SCENE_TEXT, 1, &mut next)?;
        let summary = child(session, &root, ffi::OT_SCENE_TEXT, 2, &mut next)?;
        let body = child(session, &root, ffi::OT_SCENE_BOX, 3, &mut next)?;
        body.set_style(0, 1, 0, 0, 2.0, 0)?; // Horizontal flex layout.
        body.set_style(1, 1, 0, 0, 1.0, 0)?;
        let list = Panel::new(session, &body, 0, 64, &mut next)?;
        list.node.set_style(1, 1, 0, 0, 1.0, 0)?;
        let inspector = Panel::new(session, &body, 1, 19, &mut next)?;
        inspector.node.set_style(4, 0, 0, 1, 34.0, 1)?;
        let debug = Panel::new(session, &root, 4, 4, &mut next)?;
        height(&debug.node, 7)?;
        let prompt = child(session, &root, ffi::OT_SCENE_TEXT, 5, &mut next)?;
        let footer = child(session, &root, ffi::OT_SCENE_TEXT, 6, &mut next)?;
        assert!(next <= NODE_CAPACITY);
        Ok(Self {
            _root: root,
            header,
            tabs,
            summary,
            body,
            list,
            inspector,
            debug,
            prompt,
            footer,
            layout: (0, 0, false),
            rows: 0,
            columns: 0,
            inspector_visible: false,
            debug_visible: false,
            small: false,
        })
    }

    fn resize(&mut self, width: u32, height: u32, debug: bool) -> Result<()> {
        self.layout = (width, height, debug);
        self.small = width < 50 || height < 14;
        self.debug_visible = debug && height >= 24 && !self.small;
        self.inspector_visible = width >= 96 && !self.small;
        let body_rows = (height as usize).saturating_sub(5 + if self.debug_visible { 7 } else { 0 });
        self.rows = body_rows.saturating_sub(3).min(self.list.lines.len());
        self.columns = (width as usize).saturating_sub(if self.inspector_visible { 36 } else { 2 });
        visible(&self.body, !self.small)?;
        visible(&self.tabs, !self.small)?;
        visible(&self.debug.node, self.debug_visible)?;
        visible(&self.inspector.node, self.inspector_visible)?;
        for (index, line) in self.list.lines.iter().enumerate() {
            visible(line, index < self.rows)?;
        }
        for (index, line) in self.inspector.lines.iter().enumerate() {
            visible(line, index < body_rows.saturating_sub(3))?;
        }
        Ok(())
    }

    fn update(&mut self, model: &Model, stats: &Fps, now: Duration, dimensions: (u32, u32)) -> Result<()> {
        if self.layout != (dimensions.0, dimensions.1, model.debug) {
            self.resize(dimensions.0, dimensions.1, model.debug)?;
        }
        let width = dimensions.0 as usize;
        label(
            &self.header,
            &format!(
                " FORGE / Rust build workbench    SIMULATED JOBS    uptime {:02}:{:02}",
                now.as_secs() / 60,
                now.as_secs() % 60
            ),
            width,
            GREEN,
            true,
        )?;
        label(
            &self.tabs,
            match model.page {
                Page::Jobs => " [1 JOBS]    2 Activity    3 Help     / filter    : command",
                Page::Activity => "  1 Jobs    [2 ACTIVITY]   3 Help     / filter    : command",
                Page::Help => "  1 Jobs     2 Activity   [3 HELP]    / filter    : command",
            },
            width,
            FOREGROUND,
            true,
        )?;
        if self.small {
            label(&self.summary, " Resize to at least 50 x 14. q or Ctrl+C quits.", width, AMBER, true)?;
        } else {
            let count = |status| model.jobs.iter().filter(|job| job.status == status).count();
            let activity = if model.paused {
                "PAUSED"
            } else if model.has_work() {
                "ACTIVE"
            } else {
                "IDLE"
            };
            let summary = if width < 80 {
                format!(
                    " {} RUN {}/{} Q{} FAIL{} | {:.1} FPS",
                    activity,
                    count(Status::Running),
                    WORKERS,
                    count(Status::Queued),
                    count(Status::Failed),
                    stats.rate
                )
            } else {
                format!(
                    " {}  RUN {:02}/{}  QUEUE {:02}  DONE {:02}  FAIL {:02}  HELD {:02}  |  {:.1} FPS / {} cap",
                    activity,
                    count(Status::Running),
                    WORKERS,
                    count(Status::Queued),
                    count(Status::Done),
                    count(Status::Failed),
                    count(Status::Held),
                    stats.rate,
                    model.target_fps
                )
            };
            label(&self.summary, &summary, width, MUTED, false)?;
            self.update_body(model, stats)?;
        }
        if self.debug_visible {
            self.debug.fill(
                " DEBUG / completed presentations; timings exclude pacing and input",
                &[
                    (
                        format!(
                            " fps {:4.1} / {:2}  avg {:.2} ms  p95 {:.2} ms  frames {}  unpresented {}",
                            stats.rate,
                            model.target_fps,
                            stats.mean_ms(),
                            stats.p95_ms(),
                            stats.frames,
                            stats.unpresented
                        ),
                        GREEN,
                    ),
                    (
                        format!(
                            " update {:.2} ms  paint/encode {:.2} ms  delivery {:.2} ms  {:.1} KiB/s",
                            stats.timing.update.as_secs_f64() * 1000.0,
                            stats.timing.render.as_secs_f64() * 1000.0,
                            stats.timing.output.as_secs_f64() * 1000.0,
                            stats.bytes_per_second / 1024.0
                        ),
                        FOREGROUND,
                    ),
                    (
                        format!(
                            " {}x{} key {}  {} B / {} tickets / {} pumps  total {:.1} KiB",
                            dimensions.0,
                            dimensions.1,
                            model.last_key,
                            stats.output.bytes,
                            stats.output.tickets,
                            stats.output.pumps,
                            stats.total_bytes as f64 / 1024.0
                        ),
                        MUTED,
                    ),
                    (
                        format!(
                            " trace |{}|  @ >= frame budget; ` hides debug",
                            stats.history(width.saturating_sub(49), 1000.0 / model.target_fps as f64)
                        ),
                        BLUE,
                    ),
                ],
                width.saturating_sub(2),
                4,
            )?;
        }
        let prompt = match model.mode {
            Mode::Search => format!(" /{}_  Enter: keep filter  Esc: clear", model.query),
            Mode::Command => format!(" :{}_", model.command),
            Mode::Normal if !model.query.is_empty() => {
                format!(" filter: {}  | Esc clears | {} matching jobs", model.query, model.visible_jobs().len())
            }
            Mode::Normal => {
                model.events.back().map(|event| format!(" {} {}", event.level, event.message)).unwrap_or_default()
            }
        };
        label(&self.prompt, &prompt, width, if model.mode == Mode::Normal { MUTED } else { AMBER }, false)?;
        label(
            &self.footer,
            if width < 80 {
                " q quit  ? help  j/k move  / filter  : command"
            } else {
                " j/k move  Space hold  r retry  a add  p pause  ` debug  [/] FPS  ? help  q quit"
            },
            width,
            FOREGROUND,
            false,
        )?;
        Ok(())
    }

    fn update_body(&self, model: &Model, stats: &Fps) -> Result<()> {
        let mut lines = Vec::with_capacity(self.rows);
        let title = match model.page {
            Page::Jobs => {
                let indexes = model.visible_jobs();
                let selected = indexes.iter().position(|&index| Some(index) == model.selected).unwrap_or(0);
                let start = selected.saturating_sub(self.rows / 2).min(indexes.len().saturating_sub(self.rows));
                for &index in indexes.iter().skip(start).take(self.rows) {
                    let job = &model.jobs[index];
                    let progress = (job.progress() * 100.0) as usize;
                    let name_width = if self.columns < 62 { 16 } else { 23 };
                    let bar_width = if self.columns < 62 { 6 } else { 10 };
                    let filled = progress * bar_width / 100;
                    let bar = format!("{}{}", "#".repeat(filled), ".".repeat(bar_width - filled));
                    let marker = if model.selected == Some(index) { ">" } else { " " };
                    lines.push((
                        format!(
                            "{marker}{:02} {:<name_width$} {:<9} [{}] {:3}%",
                            index + 1,
                            &job.name[..job.name.len().min(name_width)],
                            job.status.label(),
                            bar,
                            progress
                        ),
                        if model.selected == Some(index) { FOREGROUND } else { job.status.color() },
                    ));
                }
                if indexes.is_empty() {
                    lines.push((" No jobs match. Esc clears the filter.".into(), AMBER));
                }
                format!(
                    " JOBS {}/{}   sort: {}   / search   s sort",
                    indexes.len(),
                    model.jobs.len(),
                    if model.sort_status { "state" } else { "id" }
                )
            }
            Page::Activity => {
                let events = model.visible_events();
                let end = events.len().saturating_sub(model.log_offset.min(events.len().saturating_sub(self.rows)));
                let start = end.saturating_sub(self.rows);
                for event in &events[start..end] {
                    lines.push((
                        format!(
                            " {:02}:{:02} {:5} {}",
                            event.at.as_secs() / 60,
                            event.at.as_secs() % 60,
                            event.level,
                            event.message
                        ),
                        event.color(),
                    ));
                }
                if events.is_empty() {
                    lines.push((" No matching activity. Esc clears the filter.".into(), AMBER));
                }
                format!(
                    " ACTIVITY {}/{}   {}   f follow   c clear",
                    events.len(),
                    EVENTS_MAX,
                    if model.log_offset == 0 { "FOLLOW" } else { "SCROLLED" }
                )
            }
            Page::Help => {
                let offset = model.help_offset.min(HELP.len().saturating_sub(self.rows));
                for &line in HELP.iter().skip(offset).take(self.rows) {
                    lines.push((line.into(), FOREGROUND));
                }
                " HELP / j/k scroll; no background threads".into()
            }
        };
        self.list.fill(&title, &lines, self.columns, self.rows)?;
        if self.inspector_visible {
            let mut details = vec![(" SIMULATED WORKLOAD".into(), AMBER)];
            if let Some(index) = model.selected {
                let job = &model.jobs[index];
                details.extend([
                    (format!(" #{:02} {}", index + 1, job.name), FOREGROUND),
                    (format!(" state    {}", job.status.label()), job.status.color()),
                    (format!(" stage    {}", job.stage()), FOREGROUND),
                    (format!(" attempt  {}", job.attempt), MUTED),
                    (
                        format!(" elapsed  {:.1} / {:.1} s", job.elapsed.as_secs_f64(), job.duration.as_secs_f64()),
                        MUTED,
                    ),
                    (format!(" progress {:.1}%", job.progress() * 100.0), GREEN),
                ]);
            } else {
                details.push((" No job selected".into(), MUTED));
            }
            details.extend([
                ("".into(), MUTED),
                (" RECIPE".into(), BLUE),
                (" resolve -> compile -> verify".into(), FOREGROUND),
                (" -> package / publish".into(), FOREGROUND),
                ("".into(), MUTED),
                (" REAL HOST TELEMETRY".into(), BLUE),
                (format!(" completed frames  {}", stats.frames), FOREGROUND),
                (format!(" frame work p95    {:.2} ms", stats.p95_ms()), MUTED),
                ("".into(), MUTED),
                (" 3 workers; no processes spawned.".into(), AMBER),
                (" First attempts can fail.".into(), MUTED),
                (" r retries; Space holds/releases.".into(), MUTED),
            ]);
            self.inspector.fill(" INSPECTOR", &details, 32, self.inspector.lines.len())?;
        }
        Ok(())
    }
}

fn run(session: &Session<'_>, terminal: &Terminal<'_, '_>) -> Result<()> {
    let mut model = Model::new();
    let mut view = View::new(session)?;
    let renderer = session.renderer_state()?;
    let mut dimensions = (renderer.width, renderer.height);
    let mut stats = Fps::new(terminal.elapsed(), renderer.frame_count);
    let mut input = Input::default();
    let mut bytes = [0; 256];
    let mut previous = Instant::now();
    let mut next_frame = previous;
    loop {
        let now = Instant::now();
        if now >= next_frame {
            model.tick(now.saturating_duration_since(previous), terminal.elapsed());
            previous = now;
            let next_size = support::size()?;
            if next_size != dimensions {
                session.resize(next_size.0, next_size.1)?;
                dimensions = next_size;
                model.log(terminal.elapsed(), "INFO", format!("Viewport resized to {}x{}", dimensions.0, dimensions.1));
            }
            stats.advance(terminal.elapsed());
            if model.dirty {
                let began = Instant::now();
                view.update(&model, &stats, terminal.elapsed(), dimensions)?;
                let updated = Instant::now();
                session.paint(BACKGROUND, false, 0)?;
                let outcome = session.render(false)?;
                match outcome {
                    ffi::OT_RENDER_PENDING | ffi::OT_RENDER_PRESENTED | ffi::OT_RENDER_SKIPPED => {}
                    status => return Err(format!("native frame failed with outcome {status}").into()),
                }
                let rendered = Instant::now();
                let output = terminal.drain()?;
                let state = session.renderer_state()?;
                stats.record(
                    terminal.elapsed(),
                    state.frame_count,
                    Timing {
                        update: updated.duration_since(began),
                        render: rendered.duration_since(updated),
                        output: rendered.elapsed(),
                    },
                    output,
                );
                model.dirty = outcome == ffi::OT_RENDER_SKIPPED;
            }
            let interval = Duration::from_secs_f64(1.0 / model.target_fps as f64);
            // Drop missed deadlines instead of bursting through catch-up frames.
            next_frame = now + interval;
            let finished = Instant::now();
            if next_frame <= finished {
                next_frame = finished + interval;
            }
        }
        // Idle polls detect resize without drawing or keeping a frame timer active.
        let timeout = if model.dirty || model.has_work() {
            next_frame.saturating_duration_since(Instant::now())
        } else {
            Duration::from_millis(100)
        };
        let timeout = input.timeout(Instant::now(), timeout);
        let Some(count) = terminal.read(&mut bytes, timeout)? else {
            return Ok(());
        };
        let now = Instant::now();
        for key in input.keys(&bytes[..count], now) {
            let had_work = model.has_work();
            if !model.key(key, terminal.elapsed(), view.rows) {
                return Ok(());
            }
            if !had_work && model.has_work() {
                previous = now;
            }
        }
    }
}

fn main() -> std::process::ExitCode {
    support::run(NODE_CAPACITY, run)
}

#[cfg(test)]
mod tests {
    use super::*;
    use opentui::Context;

    #[test]
    fn simulation_is_bounded_pauses_and_retries_failures() {
        let mut model = Model::new();
        for tick in 0..200 {
            model.tick(Duration::from_secs(100), Duration::from_secs(tick));
            assert!(model.jobs.iter().filter(|job| job.status == Status::Running).count() <= WORKERS);
        }
        model.paused = true;
        let before: Vec<_> = model.jobs.iter().map(|job| job.elapsed).collect();
        model.tick(Duration::from_secs(1000), Duration::from_secs(1000));
        assert_eq!(before, model.jobs.iter().map(|job| job.elapsed).collect::<Vec<_>>());
        model.selected = Some(3);
        model.job_action("retry", Duration::ZERO);
        assert_eq!(model.jobs[3].status, Status::Queued);
        assert_eq!(model.jobs[3].attempt, 2);
        model.paused = false;
        for _ in 0..200 {
            model.tick(Duration::from_millis(250), Duration::ZERO);
        }
        assert_eq!(model.jobs[3].status, Status::Done);
    }

    #[test]
    fn search_commands_and_activity_stay_bounded() {
        let mut model = Model::new();
        model.key(Key::Char(b'/'), Duration::ZERO, 10);
        for &byte in b"not-a-job" {
            model.key(Key::Char(byte), Duration::ZERO, 10);
        }
        assert!(model.visible_jobs().is_empty());
        assert_eq!(model.selected, None);
        model.key(Key::Escape, Duration::ZERO, 10);
        assert_eq!(model.visible_jobs().len(), 24);
        for _ in 0..300 {
            model.add(Duration::ZERO);
        }
        assert_eq!(model.jobs.len(), JOBS_MAX);
        assert_eq!(model.events.len(), EVENTS_MAX);
        model.key(Key::Char(b':'), Duration::ZERO, 10);
        for _ in 0..100 {
            model.key(Key::Char(b'a'), Duration::ZERO, 10);
        }
        assert_eq!(model.command.len(), INPUT_BYTES_MAX);
        model.key(Key::Escape, Duration::ZERO, 10);
        assert!(model.execute("fps 60", Duration::ZERO));
        assert_eq!(model.target_fps, 60);
        assert!(model.execute("fps 0", Duration::ZERO));
        assert_eq!(model.target_fps, 60);
        assert_eq!(model.events.back().unwrap().level, "ERROR");
        assert!(!model.execute("quit", Duration::ZERO));
    }

    #[test]
    fn help_and_filtered_activity_scroll_without_losing_their_position() {
        let mut model = Model::new();
        model.page = Page::Help;
        model.key(Key::End, Duration::ZERO, 6);
        assert_eq!(model.help_offset, HELP.len() - 6);
        model.key(Key::Home, Duration::ZERO, 6);
        assert_eq!(model.help_offset, 0);
        model.key(Key::PageDown, Duration::ZERO, 6);
        assert_eq!(model.help_offset, 6);

        model.page = Page::Activity;
        model.query = "queued".into();
        model.key(Key::Up, Duration::ZERO, 6);
        assert_eq!(model.log_offset, 1);
        model.log(Duration::ZERO, "INFO", "unrelated activity");
        assert_eq!(model.log_offset, 1);
        model.log(Duration::ZERO, "INFO", "another job queued");
        assert_eq!(model.log_offset, 2);
        model.key(Key::Char(b'f'), Duration::ZERO, 6);
        assert_eq!(model.log_offset, 0);
    }

    #[test]
    fn activity_scroll_preserves_a_full_page() {
        let mut model = Model::new();
        model.page = Page::Activity;
        model.events.clear();
        for _ in 0..2 {
            model.log(Duration::ZERO, "INFO", "event");
        }
        model.key(Key::Up, Duration::ZERO, 9);
        assert_eq!(model.log_offset, 0, "all entries fit without scrolling");
        for _ in 0..18 {
            model.log(Duration::ZERO, "INFO", "event");
        }
        model.key(Key::Home, Duration::ZERO, 9);
        assert_eq!(model.log_offset, 11, "Home shows the first complete page");
        model.key(Key::Down, Duration::ZERO, 18);
        assert_eq!(model.log_offset, 1, "resize clamps before applying movement");
    }

    #[test]
    fn frame_requests_stop_when_jobs_pause_or_finish_and_resume_on_changes() {
        let mut model = Model::new();
        assert!(model.dirty);
        model.dirty = false;
        model.tick(Duration::from_millis(34), Duration::from_millis(34));
        assert!(model.dirty);

        model.execute("pause", Duration::from_secs(1));
        assert!(model.dirty);
        model.dirty = false;
        for second in 2..10 {
            model.tick(Duration::from_secs(1), Duration::from_secs(second));
            assert!(!model.dirty, "paused ticks must not request a frame");
        }
        model.key(Key::Char(b'2'), Duration::from_secs(10), 9);
        assert!(model.dirty, "input still redraws while paused");
        model.dirty = false;
        model.key(Key::Char(b'z'), Duration::from_secs(10), 9);
        assert!(model.dirty, "the debug pane shows the new key");
        model.dirty = false;
        model.key(Key::Char(b'z'), Duration::from_secs(10), 9);
        assert!(!model.dirty, "unchanged ignored input does not request another frame");

        model.execute("resume", Duration::from_secs(11));
        model.dirty = false;
        model.tick(Duration::from_millis(34), Duration::from_secs(11));
        assert!(model.dirty);
        for job in &mut model.jobs {
            job.status = Status::Done;
        }
        model.dirty = false;
        model.tick(Duration::from_secs(1), Duration::from_secs(12));
        assert!(!model.dirty, "a completed queue must stay idle");
        model.add(Duration::from_secs(13));
        assert!(model.dirty, "new work wakes the renderer");
    }

    #[test]
    fn real_scene_renders_all_pages_resizes_and_reuses_owners() -> Result<()> {
        let context = Context::new(ffi::ot_context_options {
            object_capacity: NODE_CAPACITY,
            render_cells_max: 120 * 40,
            ..Default::default()
        })?;
        // A second complete scene must fit after the first releases its owners.
        for _ in 0..2 {
            let session = Session::new(
                &context,
                ffi::ot_session_options {
                    chunk_size: 65536,
                    span_capacity: 2,
                    max_bytes: 131072,
                    ..Default::default()
                },
            )?;
            session.attach_renderer(120, 40, ffi::OT_SESSION_REMOTE_REMOTE, &[("COLORTERM", "truecolor")])?;
            let mut view = View::new(&session)?;
            let mut model = Model::new();
            let stats = Fps::new(Duration::ZERO, 0);
            for (dimensions, page, expected) in [
                ((120, 40), Page::Jobs, "INSPECTOR"),
                ((80, 24), Page::Activity, "ACTIVITY"),
                ((50, 14), Page::Help, "NAVIGATION"),
                ((30, 8), Page::Jobs, "Resize to at least"),
                ((120, 40), Page::Jobs, "DEBUG"),
            ] {
                session.resize(dimensions.0, dimensions.1)?;
                model.page = page;
                view.update(&model, &stats, Duration::ZERO, dimensions)?;
                if dimensions == (80, 24) {
                    let telemetry = String::from_utf8(view.debug.lines[2].text()?)?;
                    assert!(telemetry.contains("key none") && telemetry.contains("pumps"));
                }
                if dimensions == (50, 14) {
                    assert!(String::from_utf8(view.summary.text()?)?.contains("FPS"));
                }
                session.paint(BACKGROUND, false, 0)?;
                assert_eq!(session.render(true)?, ffi::OT_RENDER_PENDING);
                let mut frame = Vec::new();
                let mut packet = [0; 4096];
                for _ in 0..128 {
                    let result = session.pump(0, 1)?;
                    if result.status == ffi::OT_PUMP_IDLE {
                        break;
                    }
                    assert_eq!(result.status, ffi::OT_PUMP_OUTPUT_PENDING);
                    let ticket = session.read_output(&mut packet)?;
                    frame.extend_from_slice(&packet[..ticket.byte_count as usize]);
                    session.complete_output(&ticket, true)?;
                }
                assert_eq!(session.renderer_state()?.frame_pending, 0);
                assert!(frame.windows(expected.len()).any(|part| part == expected.as_bytes()), "missing {expected}");
            }
        }
        Ok(())
    }
}
