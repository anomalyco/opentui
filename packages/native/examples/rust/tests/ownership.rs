use opentui::{ffi, Context, Node, Session};

fn main() {
    #[cfg(context_send)]
    {
        fn requires_send<T: Send>() {}
        requires_send::<Context>();
    }
    #[cfg(context_sync)]
    {
        fn requires_sync<T: Sync>() {}
        requires_sync::<Context>();
    }

    #[cfg(session_send)]
    {
        fn requires_send<T: Send>() {}
        requires_send::<Session<'static>>();
    }
    #[cfg(session_sync)]
    {
        fn requires_sync<T: Sync>() {}
        requires_sync::<Session<'static>>();
    }
    #[cfg(node_send)]
    {
        fn requires_send<T: Send>() {}
        requires_send::<Node<'static, 'static>>();
    }
    #[cfg(node_sync)]
    {
        fn requires_sync<T: Sync>() {}
        requires_sync::<Node<'static, 'static>>();
    }

    let context =
        Context::new(ffi::ot_context_options { object_capacity: 3, render_cells_max: 8, ..Default::default() })
            .unwrap();
    let session = Session::new(
        &context,
        ffi::ot_session_options { chunk_size: 4096, span_capacity: 2, max_bytes: 8192, ..Default::default() },
    )
    .unwrap();
    session.attach_renderer(8, 1, ffi::OT_SESSION_REMOTE_AUTO, &[]).unwrap();
    let root = Node::new(&session, ffi::OT_SCENE_ROOT, 1).unwrap();
    #[cfg(context_dropped_first)]
    drop(context);
    #[cfg(session_dropped_first)]
    drop(session);
    drop(root);
}
