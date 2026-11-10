//! Async tasks on a Tokio runtime, with results delivered to the UI thread. Needs the `tokio` feature.

use super::{App, AppProxy, Cx, ProxyError};
use std::any::Any;
use std::future::Future;

pub(crate) type Completion = Box<dyn FnOnce(&mut Cx<'_>, Box<dyn Any + Send>)>;

/// A running task started with [`App::spawn`].
#[derive(Debug)]
pub struct TaskHandle {
    id: u64,
    abort: tokio::task::AbortHandle,
    app: std::rc::Weak<super::AppInner>,
}

impl TaskHandle {
    /// Cancels the task. Its completion handler never runs.
    pub fn abort(&self) {
        self.abort.abort();
        if let Some(app) = self.app.upgrade() {
            app.tasks.borrow_mut().remove(&self.id);
        }
    }

    pub fn is_finished(&self) -> bool {
        self.abort.is_finished()
    }
}

/// Releases a task's completion handler on the UI thread if the task ends without output: it panicked, was
/// aborted, or its runtime shut down.
struct Release {
    proxy: AppProxy,
    id: u64,
    armed: bool,
}

impl Drop for Release {
    fn drop(&mut self) {
        if self.armed {
            let id = self.id;
            let _ = self.proxy.post(move |cx| drop(cx.app().0.tasks.borrow_mut().remove(&id)));
        }
    }
}

#[derive(Default)]
pub(crate) struct Runtime {
    owned: Option<tokio::runtime::Runtime>,
}

impl Drop for Runtime {
    fn drop(&mut self) {
        if let Some(runtime) = self.owned.take() {
            runtime.shutdown_background();
        }
    }
}

impl App {
    /// The runtime tasks run on: the multi-threaded runtime the app runs inside, or else one the app starts on first
    /// use. A current-thread runtime cannot run tasks while [`App::run`] blocks its only thread, so it is not used.
    pub fn runtime(&self) -> tokio::runtime::Handle {
        if let Ok(handle) = tokio::runtime::Handle::try_current()
            && handle.runtime_flavor() == tokio::runtime::RuntimeFlavor::MultiThread
        {
            return handle;
        }
        let mut runtime = self.0.runtime.borrow_mut();
        let owned = runtime.owned.get_or_insert_with(|| {
            tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .thread_name("opentui-task")
                .enable_all()
                .build()
                .expect("start the app's Tokio runtime")
        });
        owned.handle().clone()
    }

    /// Runs `future` on [`Self::runtime`] and calls `done` with its output on the UI thread.
    ///
    /// ```no_run
    /// # use opentui::prelude::*;
    /// # let app = App::new(AppOptions::default())?;
    /// let status = Text::new(&app, "Loading...");
    /// app.spawn(async { 42 }, move |_cx, answer| {
    ///     status.set_text(format!("The answer is {answer}"));
    /// });
    /// # Ok::<(), opentui::Error>(())
    /// ```
    pub fn spawn<F>(&self, future: F, done: impl FnOnce(&mut Cx<'_>, F::Output) + 'static) -> TaskHandle
    where
        F: Future + Send + 'static,
        F::Output: Send + 'static,
    {
        let id = self.0.next_task.get();
        self.0.next_task.set(id + 1);
        let completion: Completion = Box::new(move |cx, output| {
            if let Ok(output) = output.downcast::<F::Output>() {
                done(cx, *output);
            }
        });
        self.0.tasks.borrow_mut().insert(id, completion);
        let proxy = self.proxy();
        let task = self.runtime().spawn(async move {
            let mut release = Release { proxy: proxy.clone(), id, armed: true };
            let output: Box<dyn Any + Send> = Box::new(future.await);
            release.armed = false;
            let mut completion: super::proxy::Task = Box::new(move |cx| cx.app().finish_task(id, output));
            loop {
                match proxy.push(completion) {
                    Ok(()) | Err((ProxyError::Closed, _)) => return,
                    // The UI thread is behind; keep the output and retry shortly.
                    Err((ProxyError::Full, returned)) => {
                        completion = returned;
                        tokio::time::sleep(std::time::Duration::from_millis(1)).await;
                    }
                }
            }
        });
        TaskHandle { id, abort: task.abort_handle(), app: std::rc::Rc::downgrade(&self.0) }
    }

    pub(crate) fn finish_task(&self, id: u64, output: Box<dyn Any + Send>) {
        let completion = self.0.tasks.borrow_mut().remove(&id);
        if let Some(completion) = completion {
            completion(&mut Cx::new(self), output);
        }
    }
}
