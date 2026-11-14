use super::Cx;
use std::cell::RefCell;
use std::rc::Rc;
use std::time::{Duration, Instant};

/// Identifies a timer for [`App::cancel_timer`](super::App::cancel_timer).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct TimerId(u64);

pub(crate) type TimerCallback = Rc<RefCell<dyn FnMut(&mut Cx<'_>)>>;

/// About a century: later times count as never.
const NEVER: Duration = Duration::from_secs(100 * 365 * 24 * 60 * 60);

/// `now + delay`, saturating at a time that never comes.
pub(crate) fn after(now: Instant, delay: Duration) -> Instant {
    now.checked_add(delay.min(NEVER)).unwrap_or(now)
}

struct Entry {
    id: TimerId,
    due: Instant,
    every: Option<Duration>,
    callback: TimerCallback,
}

#[derive(Default)]
pub(crate) struct Timers {
    next_id: u64,
    entries: Vec<Entry>,
}

impl Timers {
    pub fn add(&mut self, due: Instant, every: Option<Duration>, callback: TimerCallback) -> TimerId {
        self.next_id += 1;
        let id = TimerId(self.next_id);
        // A zero interval would fire forever within one turn.
        let every = every.map(|every| every.max(Duration::from_millis(1)));
        self.entries.push(Entry { id, due, every, callback });
        id
    }

    /// Removes a timer and returns its callback, for the caller to drop outside any borrow.
    pub fn cancel(&mut self, id: TimerId) -> Option<TimerCallback> {
        let index = self.entries.iter().position(|entry| entry.id == id)?;
        Some(self.entries.swap_remove(index).callback)
    }

    pub fn next_due(&self) -> Option<Instant> {
        self.entries.iter().map(|entry| entry.due).min()
    }

    /// Removes or reschedules the earliest timer due at `now` and returns its callback.
    pub fn take_due(&mut self, now: Instant) -> Option<TimerCallback> {
        let index = (0..self.entries.len()).filter(|&index| self.entries[index].due <= now).min_by_key(|&index| {
            let entry = &self.entries[index];
            (entry.due, entry.id.0)
        })?;
        let entry = &mut self.entries[index];
        match entry.every {
            Some(every) => {
                entry.due = after(entry.due, every);
                // After a long stall, skip missed ticks instead of firing them in a burst.
                if entry.due <= now {
                    entry.due = after(now, every);
                }
                Some(Rc::clone(&entry.callback))
            }
            None => Some(self.entries.swap_remove(index).callback),
        }
    }

    /// Removes every timer and returns them, for the caller to drop outside any borrow. Ids keep counting.
    pub fn clear(&mut self) -> impl Sized + use<> {
        std::mem::take(&mut self.entries)
    }
}
