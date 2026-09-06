#include "opentui.h"
#include <stddef.h>

/* Keep layout checks for records crossing the smoke test's C/Zig boundary. */
_Static_assert(sizeof(uintptr_t) == 8, "framebuffer addresses require 64-bit targets");
_Static_assert(sizeof(ot_status) == 4, "status size");
_Static_assert(sizeof(ot_context_options) == 32, "options size");
_Static_assert(sizeof(ot_context_error) == 16, "error size");
_Static_assert(sizeof(ot_handle) == 16 && _Alignof(ot_handle) == 8, "handle layout");
_Static_assert(offsetof(ot_handle, generation) == 12, "handle generation offset");
_Static_assert(sizeof(ot_buffer_lease_snapshot) == 80, "lease size");
_Static_assert(offsetof(ot_buffer_lease_snapshot, char_ptr) == 40, "lease pointer offset");
_Static_assert(offsetof(ot_buffer_lease_snapshot, attributes_ptr) == 64, "lease attributes offset");
_Static_assert(sizeof(ot_buffer_text_options) == 40, "text options size");
_Static_assert(offsetof(ot_buffer_text_options, foreground) == 16, "text color offset");
_Static_assert(sizeof(ot_output_ticket) == 32, "output ticket size");
_Static_assert(offsetof(ot_output_ticket, request_id) == 16, "output request offset");
_Static_assert(sizeof(ot_scene_layout) == 48, "scene layout size");
_Static_assert(offsetof(ot_scene_layout, screen_x) == 32, "scene screen offset");
_Static_assert(sizeof(ot_scene_frame_request) == 112, "frame request size");
_Static_assert(offsetof(ot_scene_frame_request, frame_id) == 56, "frame ID offset");

#ifndef OT_ABI_LAYOUT_ONLY
#include <assert.h>
#include <string.h>

#ifdef _WIN32
#include <windows.h>
static DWORD WINAPI wrong_thread(void *arg) {
#else
#include <pthread.h>
static void *wrong_thread(void *arg) {
#endif
    ot_context_error error = {sizeof(error), OT_CONTEXT_ABI_VERSION, OT_OK, 0};
    const ot_handle sentinel = {UINT64_MAX, UINT32_MAX, UINT32_MAX};
    ot_handle output = sentinel;
    assert(ot_buffer_create(arg, NULL, &output) == OT_WRONG_THREAD);
    assert(memcmp(&output, &sentinel, sizeof(output)) == 0);
    assert(ot_context_get_last_error(arg, &error) == OT_WRONG_THREAD);
    assert(ot_context_destroy(arg) == OT_WRONG_THREAD);
    return 0;
}

static ot_context *edit_context;
static ot_handle edit_handle;
static uint32_t edit_events;

static void edit_event(uint64_t context_id, uint32_t slot, uint32_t generation, uint32_t event) {
    assert(context_id == edit_handle.context_id);
    assert(slot == edit_handle.slot && generation == edit_handle.generation);
    assert(event == OT_EDIT_CURSOR_CHANGED || event == OT_EDIT_CONTENT_CHANGED);
    edit_events |= event;
    assert(ot_context_set_edit_event_callback(edit_context, NULL) == OT_CONTEXT_BUSY);
    assert(ot_context_destroy(edit_context) == OT_CONTEXT_BUSY);
}

static void editor(ot_context *context) {
    const ot_edit_buffer_options options = {
        .struct_size = sizeof(options), .abi_version = OT_CONTEXT_ABI_VERSION,
        .width_method = OT_WIDTH_METHOD_UNICODE,
    };
    ot_handle view;
    assert(ot_edit_buffer_create(context, &options, &edit_handle) == OT_OK);
    assert(ot_editor_view_create(context, &edit_handle, 8, 2, &view) == OT_OK);
    edit_context = context;
    assert(ot_context_set_edit_event_callback(context, edit_event) == OT_OK);
    uint8_t source[] = "a\xc3\xa9\nq";
    assert(ot_edit_buffer_set_text(context, &edit_handle, source, sizeof(source) - 1, 0) == OT_OK);
    memset(source, 'x', sizeof(source));
    assert(edit_events == (OT_EDIT_CURSOR_CHANGED | OT_EDIT_CONTENT_CHANGED));
    uint32_t count = UINT32_MAX;
    assert(ot_edit_buffer_get_text(context, &edit_handle, NULL, 0, &count) == OT_OK && count == 5);
    count = UINT32_MAX;
    assert(ot_edit_buffer_get_text(context, &edit_handle, source, 4, &count) == OT_INVALID_ARGUMENT);
    assert(count == UINT32_MAX && source[0] == 'x');
    assert(ot_edit_buffer_get_text(context, &edit_handle, source, sizeof(source), &count) == OT_OK);
    assert(count == 5 && memcmp(source, "a\xc3\xa9\nq", 5) == 0);
    assert(ot_context_set_edit_event_callback(context, NULL) == OT_OK);
    assert(ot_edit_buffer_destroy(context, &edit_handle) == OT_OK);
    assert(ot_editor_view_destroy(context, &view) == OT_STALE_HANDLE);
    edit_context = NULL;
}

static void buffer_lease(ot_context *context, ot_context *foreign) {
    const ot_buffer_options options = {
        .struct_size = sizeof(options), .abi_version = OT_CONTEXT_ABI_VERSION,
        .width = 4, .height = 1, .width_method = OT_WIDTH_METHOD_UNICODE,
        .flags = OT_BUFFER_RESPECT_ALPHA,
    };
    const ot_handle sentinel = {UINT64_MAX, UINT32_MAX, UINT32_MAX};
    ot_handle buffer = sentinel;
    assert(ot_buffer_create(context, NULL, &buffer) == OT_INVALID_ARGUMENT);
    assert(memcmp(&buffer, &sentinel, sizeof(buffer)) == 0);
    assert(ot_buffer_create(context, &options, &buffer) == OT_OK);
    ot_buffer_lease_snapshot snapshot = {
        .struct_size = sizeof(snapshot), .abi_version = OT_CONTEXT_ABI_VERSION, .char_ptr = UINT64_MAX,
    };
    const ot_buffer_lease_snapshot before = snapshot;
    assert(ot_buffer_acquire_lease(foreign, &buffer, &snapshot) == OT_WRONG_CONTEXT);
    assert(memcmp(&snapshot, &before, sizeof(snapshot)) == 0);
    assert(ot_buffer_acquire_lease(context, &buffer, &snapshot) == OT_OK);
    uint32_t *chars = (uint32_t *)(uintptr_t)snapshot.char_ptr;
    uint16_t *fg = (uint16_t *)(uintptr_t)snapshot.fg_ptr;
    uint16_t *bg = (uint16_t *)(uintptr_t)snapshot.bg_ptr;
    uint32_t *attributes = (uint32_t *)(uintptr_t)snapshot.attributes_ptr;
    const uint16_t background[4] = {68, 85, 102, 255};
    const ot_buffer_text_options text = {
        .struct_size = sizeof(text), .abi_version = OT_CONTEXT_ABI_VERSION,
        .foreground = {17, 34, 51, 255}, .attributes = 1,
    };
    assert(snapshot.width == 4 && snapshot.height == 1);
    assert(ot_buffer_clear(context, &buffer, background) == OT_OK);
    assert(ot_buffer_draw_text(context, &buffer, &text, (const uint8_t *)"A", 1) == OT_OK);
    assert(chars[0] == 'A' && attributes[0] == 1);
    assert(memcmp(fg, text.foreground, sizeof(text.foreground)) == 0);
    assert(memcmp(bg, background, sizeof(background)) == 0);
    assert(ot_buffer_draw_text(context, &buffer, &text, NULL, 1) == OT_INVALID_ARGUMENT);
    assert(chars[0] == 'A');
    assert(ot_buffer_destroy(context, &snapshot.lease) == OT_WRONG_KIND);
    assert(ot_buffer_resize(context, &buffer, 2, 1) == OT_OK);
    assert(ot_buffer_lease_validate(context, &snapshot.lease) == OT_STALE_LEASE);
    assert(ot_buffer_destroy(context, &buffer) == OT_OK);
    assert(ot_buffer_destroy(context, &buffer) == OT_STALE_HANDLE);
    assert(ot_context_destroy(context) == OT_CONTEXT_BUSY);
    assert(chars[0] == 'A' && attributes[0] == 1);
    assert(ot_buffer_lease_release(context, &snapshot.lease) == OT_OK);
    assert(ot_buffer_lease_release(context, &snapshot.lease) == OT_STALE_HANDLE);
}

static void rendered_output(ot_context *context) {
    const ot_session_options transport = {
        .struct_size = sizeof(transport), .abi_version = OT_CONTEXT_ABI_VERSION,
        .chunk_size = 4096, .span_capacity = 2, .max_bytes = 8192,
    };
    const ot_session_renderer_options renderer = {
        .struct_size = sizeof(renderer), .abi_version = OT_CONTEXT_ABI_VERSION,
        .width = 8, .height = 4, .remote = 1,
    };
    ot_handle session, root, box;
    assert(ot_session_create(context, &transport, &session) == OT_OK);
    assert(ot_session_attach_renderer(context, &session, &renderer) == OT_OK);
    assert(ot_scene_create_node(context, &session, OT_SCENE_ROOT, 100, &root) == OT_OK);
    assert(ot_scene_create_node(context, &session, OT_SCENE_BOX, 101, &box) == OT_OK);
    assert(ot_scene_set_style(context, &box, 4, 0, 0, 1, 4, 1) == OT_OK);
    assert(ot_scene_set_style(context, &box, 4, 1, 0, 1, 2, 1) == OT_OK);
    assert(ot_scene_move_node(context, &box, &root, 0) == OT_OK);
    const uint16_t background[4] = {0, 0, 0, 255};
    assert(ot_scene_paint(context, &session, background, 1, 0) == OT_OK);
    ot_scene_layout layout = {.struct_size = sizeof(layout), .abi_version = OT_CONTEXT_ABI_VERSION};
    assert(ot_scene_get_layout(context, &box, 0, &layout) == OT_OK);
    assert(layout.width == 4 && layout.height == 2);
    uint32_t result = UINT32_MAX;
    assert(ot_session_render(context, &session, 1, &result) == OT_OK && result == OT_RENDER_PENDING);
    assert(ot_scene_paint(context, &session, background, 1, 0) == OT_OUTPUT_BUSY);
    uint8_t bytes[17];
    ot_output_ticket ticket;
    uint32_t delivered = 0;
    for (uint32_t work = 0; work < 1024; work++) {
        assert(ot_session_read_output(context, &session, bytes, sizeof(bytes), &ticket) == OT_OK);
        if (!ticket.byte_count) break;
        assert(work < 1023 && ticket.byte_count <= sizeof(bytes));
        delivered += ticket.byte_count;
        assert(ot_session_complete_output(context, &session, &ticket, 1) == OT_OK);
        assert(ot_session_complete_output(context, &session, &ticket, 1) == OT_STALE_OUTPUT);
    }
    assert(delivered > 0);
    uint32_t hit = 0;
    assert(ot_scene_hit_test(context, &session, 0, 0, &hit) == OT_OK && hit == 101);
    assert(ot_session_destroy(context, &session) == OT_OK);
    assert(ot_scene_destroy_node(context, &root) == OT_STALE_HANDLE);
}

int main(void) {
    const ot_context_options valid = {
        .struct_size = sizeof(valid), .abi_version = OT_CONTEXT_ABI_VERSION,
        .object_capacity = 8, .render_cells_max = 64,
    };
    ot_context_options options = valid;
    ot_context *first = (ot_context *)(uintptr_t)1, *second = NULL;
    assert(ot_context_abi_version() == OT_CONTEXT_ABI_VERSION);
    assert(ot_context_create(NULL, &first) == OT_INVALID_ARGUMENT && first == NULL);
    options.abi_version++;
    first = (ot_context *)(uintptr_t)1;
    assert(ot_context_create(&options, &first) == OT_UNSUPPORTED_VERSION && first == NULL);
    options = valid;
    options.struct_size--;
    assert(ot_context_create(&options, &first) == OT_INVALID_ARGUMENT && first == NULL);
    assert(ot_context_create(&valid, &first) == OT_OK);
    assert(ot_context_create(&valid, &second) == OT_OK);
    ot_context_error error = {sizeof(error), OT_CONTEXT_ABI_VERSION, OT_OK, 0};
    assert(ot_context_get_last_error(first, NULL) == OT_INVALID_ARGUMENT);
    assert(ot_context_get_last_error(first, &error) == OT_OK && error.status == OT_INVALID_ARGUMENT);
    assert(ot_context_get_last_error(second, &error) == OT_OK && error.status == OT_OK);
    error.abi_version++;
    const ot_context_error before = error;
    assert(ot_context_get_last_error(first, &error) == OT_UNSUPPORTED_VERSION);
    assert(memcmp(&error, &before, sizeof(error)) == 0);
#ifdef _WIN32
    HANDLE thread = CreateThread(NULL, 0, wrong_thread, first, 0, NULL);
    assert(thread != NULL);
    assert(WaitForSingleObject(thread, INFINITE) == WAIT_OBJECT_0);
    assert(CloseHandle(thread));
#else
    pthread_t thread;
    assert(pthread_create(&thread, NULL, wrong_thread, first) == 0);
    assert(pthread_join(thread, NULL) == 0);
#endif
    error.abi_version = OT_CONTEXT_ABI_VERSION;
    assert(ot_context_get_last_error(first, &error) == OT_OK && error.status == OT_UNSUPPORTED_VERSION);
    buffer_lease(first, second);
    editor(first);
    rendered_output(first);
    assert(ot_context_destroy(first) == OT_OK);
    assert(ot_context_destroy(second) == OT_OK);
    return 0;
}
#endif
