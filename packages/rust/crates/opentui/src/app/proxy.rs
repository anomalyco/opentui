use super::Cx;
use crate::term::Waker;
use std::collections::VecDeque;
use std::sync::{Arc, Mutex, MutexGuard};

/// The most tasks an [`AppProxy`] queue holds before [`ProxyError::Full`].
pub const PROXY_CAPACITY: usize = 4096;

pub(crate) type Task = Box<dyn FnOnce(&mut Cx<'_>) + Send>;

/// Why an [`AppProxy`] rejected a task.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProxyError {
    /// [`PROXY_CAPACITY`] tasks are waiting. Retry after the UI thread catches up.
    Full,
    /// The app has ended.
    Closed,
}

impl std::fmt::Display for ProxyError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::Full => "the app's task queue is full",
            Self::Closed => "the app has ended",
        })
    }
}

impl std::error::Error for ProxyError {}

#[derive(Default)]
struct Queue {
    tasks: VecDeque<Task>,
    waker: Option<Waker>,
    closed: bool,
}

#[derive(Default)]
pub(crate) struct Shared {
    queue: Mutex<Queue>,
}

impl Shared {
    fn lock(&self) -> MutexGuard<'_, Queue> {
        // A task never runs while the lock is held, so a poisoned lock still holds a consistent queue.
        self.queue.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn set_waker(&self, waker: Option<Waker>) {
        self.lock().waker = waker;
    }

    pub fn take(&self) -> VecDeque<Task> {
        std::mem::take(&mut self.lock().tasks)
    }

    pub fn close(&self) {
        let mut queue = self.lock();
        queue.closed = true;
        queue.waker = None;
        // Tasks drop after the lock: what they own may post.
        let tasks = std::mem::take(&mut queue.tasks);
        drop(queue);
        drop(tasks);
    }
}

/// Sends work to the UI thread from any thread. Cloning is cheap.
///
/// ```no_run
/// # use opentui::prelude::*;
/// # let app = App::new(AppOptions::default())?;
/// let status = Text::new(&app, "Loading...");
/// app.root().add(&status);
/// app.on_message(move |_cx, loaded: &usize| {
///     status.set_text(format!("Loaded {loaded} items"));
/// });
/// let proxy = app.proxy();
/// std::thread::spawn(move || {
///     let _ = proxy.send(42usize);
/// });
/// app.run()
/// # ; Ok::<(), opentui::Error>(())
/// ```
#[derive(Clone)]
pub struct AppProxy {
    pub(crate) shared: Arc<Shared>,
}

impl std::fmt::Debug for AppProxy {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.debug_struct("AppProxy").finish_non_exhaustive()
    }
}

impl AppProxy {
    /// Runs `task` on the UI thread during its next turn.
    pub fn post(&self, task: impl FnOnce(&mut Cx<'_>) + Send + 'static) -> Result<(), ProxyError> {
        self.push(Box::new(task)).map_err(|(error, _)| error)
    }

    /// Queues a task, or hands it back with the reason it was rejected.
    pub(crate) fn push(&self, task: Task) -> Result<(), (ProxyError, Task)> {
        let waker = {
            let mut queue = self.shared.lock();
            if queue.closed {
                return Err((ProxyError::Closed, task));
            }
            if queue.tasks.len() >= PROXY_CAPACITY {
                return Err((ProxyError::Full, task));
            }
            queue.tasks.push_back(task);
            queue.waker.clone()
        };
        if let Some(waker) = waker {
            waker.wake();
        }
        Ok(())
    }

    /// Delivers `message` to the handlers registered with [`App::on_message`](super::App::on_message) for its type.
    /// Messages without a handler are dropped.
    pub fn send<M: Send + 'static>(&self, message: M) -> Result<(), ProxyError> {
        self.post(move |cx| cx.app().deliver(Box::new(message)))
    }

    /// Asks the app to end.
    pub fn quit(&self) -> Result<(), ProxyError> {
        self.post(|cx| cx.quit())
    }
}
