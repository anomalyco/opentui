#ifndef OPENTUI_H
#define OPENTUI_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Experimental context and session ABI, version 1. This header does not stabilize the
 * library's legacy renderer, Yoga, or other FFI exports. Use matching headers
 * and artifacts. The restricted scene surface supports roots, boxes, plain text,
 * sliders, standard arrows, editor views, and images. */
#define OT_CONTEXT_ABI_VERSION UINT32_C(1)

typedef int32_t ot_status;
#define OT_OK INT32_C(0)
#define OT_INVALID_ARGUMENT (-INT32_C(1))
#define OT_UNSUPPORTED_VERSION (-INT32_C(2))
#define OT_OUT_OF_MEMORY (-INT32_C(3))
#define OT_WRONG_THREAD (-INT32_C(4))
#define OT_INTERNAL_ERROR (-INT32_C(5))
#define OT_CONTEXT_BUSY (-INT32_C(6))
#define OT_WRONG_CONTEXT (-INT32_C(7))
#define OT_WRONG_KIND (-INT32_C(8))
#define OT_STALE_HANDLE (-INT32_C(9))
#define OT_WRONG_SESSION (-INT32_C(10))
#define OT_OUTPUT_BACKPRESSURE (-INT32_C(11))
#define OT_SESSION_CLOSED (-INT32_C(12))
#define OT_OUTPUT_BUSY (-INT32_C(13))
#define OT_STALE_OUTPUT (-INT32_C(14))
#define OT_OUTPUT_FAILED (-INT32_C(15))
#define OT_OBJECT_LIMIT (-INT32_C(16))
#define OT_RENDERER_ATTACHED (-INT32_C(17))
#define OT_RENDERER_NOT_ATTACHED (-INT32_C(18))
#define OT_INVALID_PHASE (-INT32_C(19))
#define OT_CONTROL_PACKET_LIMIT (-INT32_C(20))
#define OT_LEASE_LIMIT (-INT32_C(21))
#define OT_LEASE_BYTES_LIMIT (-INT32_C(22))
#define OT_STALE_LEASE (-INT32_C(23))
#define OT_UNSUPPORTED_RESOURCE (-INT32_C(24))
#define OT_STALE_FRAME (-INT32_C(25))
#define OT_LAYOUT_LIMIT (-INT32_C(26))
#define OT_FRAME_BUSY (-INT32_C(27))
#define OT_FRAME_REQUEST_LIMIT (-INT32_C(28))

/* A context owns its native resources and I/O storage. Only its creating OS
 * thread may call its functions, including error queries and destruction.
 * Separate contexts may run on separate threads. Do not race a call with
 * destruction. A successful destroy invalidates every copy of the pointer;
 * stale, forged, and already-destroyed pointers are caller errors. */
typedef struct ot_context ot_context;

/* Context-qualified identity. A destroyed slot cannot identify its replacement.
 * Numeric IDs belong to one native image and its load lifetime; independent
 * images can issue equal IDs. Do not reuse handles or tickets across images
 * or after unloading.
 * Copying this value does not retain the object. An all-zero handle is invalid. */
typedef struct ot_handle {
    uint64_t context_id;
    uint32_t slot;
    uint32_t generation;
} ot_handle;

#define OT_SCENE_ROOT UINT32_C(0)
#define OT_SCENE_BOX UINT32_C(1)
#define OT_SCENE_TEXT UINT32_C(2)
#define OT_SCENE_SLIDER UINT32_C(3)
#define OT_SCENE_ARROW UINT32_C(4)
#define OT_SCENE_EDITOR UINT32_C(5)
#define OT_SCENE_CUSTOM UINT32_C(6)
#define OT_SCENE_TEXT_VIEW UINT32_C(7)
#define OT_SCENE_IMAGE UINT32_C(8)
#define OT_SCENE_WRAP_NONE UINT32_C(0)
#define OT_SCENE_WRAP_CHAR UINT32_C(1)
#define OT_SCENE_WRAP_WORD UINT32_C(2)

/* Complete slider options. orientation is horizontal=0 or vertical=1. Colors
 * retain terminal color intent. All numbers and derived thumb arithmetic must be finite.
 * Values are not clamped: zero and inverted ranges retain the legacy full thumb.
 * reserved must be zero. New sliders default to horizontal, min=0, max=100,
 * value=0, viewport_size=10, foreground=#9a9ea3, background=#252527 (both opaque). */
typedef struct ot_scene_slider_options {
    uint32_t struct_size;
    uint32_t abi_version;
    uint32_t orientation;
    uint32_t reserved;
    double min;
    double max;
    double value;
    double viewport_size;
    uint16_t foreground[4];
    uint16_t background[4];
} ot_scene_slider_options;

/* Copied virtual half-cell size and start, not terminal-cell coordinates. */
typedef struct ot_scene_slider_thumb {
    uint32_t struct_size;
    uint32_t abi_version;
    double size;
    double start;
} ot_scene_slider_thumb;

/* direction is up=0, down=1, left=2, right=3, using U+25B2/U+25BC/U+25C0/U+25B6.
 * Only attributes bits 0..7 are accepted. Colors retain terminal color intent.
 * New arrows default to up, white/transparent, and zero attributes. */
typedef struct ot_scene_arrow_options {
    uint32_t struct_size;
    uint32_t abi_version;
    uint32_t direction;
    uint32_t attributes;
    uint16_t foreground[4];
    uint16_t background[4];
} ot_scene_arrow_options;

/* Complete text options, not a patch. Colors retain terminal color intent;
 * attributes accepts only bits 0..7. truncate is 0 or 1. Offsets are display
 * columns/virtual rows, at most INT32_MAX. Viewport size comes from native layout.
 * New text nodes default to white/transparent, zero attributes/offsets, word wrap,
 * and no truncation. No custom providers or raw handles. */
typedef struct ot_scene_text_options {
    uint32_t struct_size;
    uint32_t abi_version;
    uint16_t foreground[4];
    uint16_t background[4];
    uint32_t attributes;
    uint32_t wrap_mode;
    uint32_t truncate;
    uint32_t first_line_offset;
    /* Logical positions are retained; native view coordinates truncate to cells. */
    double scroll_x;
    double scroll_y;
    uint32_t tab_indicator; /* Unicode scalar, or zero to hide the indicator. */
    uint32_t tab_color_set; /* 0 or 1; absent tab color must be zero. */
    uint16_t tab_color[4];
} ot_scene_text_options;

#define OT_SCENE_TEXT_SELECTION_RESET UINT32_C(0)
#define OT_SCENE_TEXT_SELECTION_SET UINT32_C(1)
#define OT_SCENE_TEXT_SELECTION_UPDATE UINT32_C(2)
#define OT_SCENE_TEXT_SELECTION_CELL UINT32_C(0)
#define OT_SCENE_TEXT_SELECTION_WORD UINT32_C(1)
#define OT_SCENE_TEXT_SELECTION_LINE UINT32_C(2)
#define OT_SCENE_TEXT_SELECTION_BACKGROUND UINT32_C(1)
#define OT_SCENE_TEXT_SELECTION_FOREGROUND UINT32_C(2)

typedef struct ot_scene_text_selection_options {
    uint32_t struct_size;
    uint32_t abi_version;
    uint32_t operation;
    uint32_t behavior;
    int32_t anchor_x;
    int32_t anchor_y;
    int32_t focus_x;
    int32_t focus_y;
    uint32_t flags;
    uint32_t reserved;
    uint16_t background[4];
    uint16_t foreground[4];
} ot_scene_text_selection_options;

#define OT_SCENE_TEXT_FOREGROUND UINT32_C(1)
#define OT_SCENE_TEXT_BACKGROUND UINT32_C(2)
#define OT_SCENE_TEXT_LINK UINT32_C(4)

typedef struct ot_scene_text_chunk {
    uint32_t struct_size;
    uint32_t abi_version;
    uint32_t byte_count;
    uint32_t flags;
    uint16_t foreground[4];
    uint16_t background[4];
    uint32_t attributes;
    uint32_t reserved;
} ot_scene_text_chunk;

typedef struct ot_scene_linked_text_chunk {
    uint32_t struct_size;
    uint32_t abi_version;
    uint32_t byte_count;
    uint32_t flags;
    uint16_t foreground[4];
    uint16_t background[4];
    uint32_t attributes;
    uint32_t reserved;
    uint32_t link_offset;
    uint32_t link_byte_count;
} ot_scene_linked_text_chunk;

/* Copied text metadata. text_length counts display columns, not bytes or Unicode
 * code points. width_cols_max is the longest unwrapped line. reserved is zero. */
typedef struct ot_scene_text_info {
    uint32_t struct_size;
    uint32_t abi_version;
    uint32_t byte_count;
    uint32_t text_length; /* Display-cell width, not bytes or Unicode code points. */
    uint32_t line_count;
    uint32_t virtual_line_count;
    uint32_t width_cols_max;
    uint32_t reserved;
} ot_scene_text_info;

typedef struct ot_scene_text_line {
    uint32_t start_cols;
    uint32_t width_cols;
    uint32_t source_line;
    uint32_t wrap_index;
} ot_scene_text_line;

typedef struct ot_scene_paint_options {
    uint32_t struct_size;
    uint32_t abi_version;
    int32_t z_index;
    float opacity;
    double translate_x;
    double translate_y;
    uint32_t border_sides;
    uint32_t should_fill;
    uint16_t background[4];
    uint16_t border_color[4];
    uint32_t border_style;
    uint32_t focusable;
    uint16_t focused_border_color[4];
    uint32_t reserved;
} ot_scene_paint_options;

#define OT_SCENE_MUTATIONS_MAX UINT32_C(4096)

/* Complete Box details. Flags: 1 = title color, 2 = custom border characters.
 * Titles are copied single-row UTF-8; each is bounded by OT_BUFFER_TEXT_BYTES_MAX.
 * Alignments are left=0, center=1, right=2. Custom scalars occupy one display cell.
 * Absent color/characters and reserved fields must be zero. */
typedef struct ot_scene_box_details {
    uint32_t struct_size;
    uint32_t abi_version;
    uint32_t title_alignment;
    uint32_t bottom_title_alignment;
    uint32_t flags;
    uint32_t reserved;
    uint16_t title_color[4];
    uint32_t border_characters[11];
} ot_scene_box_details;

typedef struct ot_scene_style_value {
    uint32_t struct_size;
    uint32_t abi_version;
    uint32_t unit;
    float value;
} ot_scene_style_value;

typedef struct ot_scene_layout {
    uint32_t struct_size;
    uint32_t abi_version;
    float left;
    float top;
    float right;
    float bottom;
    float width;
    float height;
    double screen_x;
    double screen_y;
} ot_scene_layout;

typedef struct ot_scene_stats {
    uint32_t struct_size;
    uint32_t abi_version;
    double last_frame_time;
    double average_frame_time;
    double render_time;
    double stdout_write_time;
    uint64_t frame_count;
    uint32_t cells_updated;
    uint32_t average_cells_updated;
    uint32_t render_time_valid;
    uint32_t stdout_write_time_valid;
} ot_scene_stats;

typedef struct ot_scene_cursor_state {
    uint32_t struct_size;
    uint32_t abi_version;
    uint32_t x;
    uint32_t y;
    uint32_t visible;
    uint32_t style;
    uint32_t blinking;
    uint32_t reserved;
    float r;
    float g;
    float b;
    float a;
} ot_scene_cursor_state;

#define OT_SCENE_HOOK_UPDATE UINT32_C(1)
#define OT_SCENE_HOOK_RESIZE UINT32_C(2)
#define OT_SCENE_HOOK_LAYOUT_CHANGED UINT32_C(4)
#define OT_SCENE_HOOK_RENDER_BEFORE UINT32_C(8)
#define OT_SCENE_HOOK_RENDER_AFTER UINT32_C(16)
#define OT_SCENE_HOOK_RENDER_SELF UINT32_C(32)
#define OT_SCENE_HOOK_IDLE_UPDATE UINT32_C(64)
#define OT_SCENE_HOOK_RESUME_NATIVE_TEXT UINT32_C(128)
#define OT_SCENE_FRAME_DONE UINT32_C(0)
#define OT_SCENE_FRAME_UPDATE UINT32_C(1)
#define OT_SCENE_FRAME_RESIZE UINT32_C(2)
#define OT_SCENE_FRAME_LAYOUT_CHANGED UINT32_C(3)
#define OT_SCENE_FRAME_RENDER_BEFORE UINT32_C(4)
#define OT_SCENE_FRAME_RENDER_AFTER UINT32_C(5)
#define OT_SCENE_FRAME_YIELD UINT32_C(6)
#define OT_SCENE_FRAME_RENDER_SELF UINT32_C(7)

typedef struct ot_scene_hooks {
    uint32_t struct_size;
    uint32_t abi_version;
    uint32_t flags;
    uint32_t reserved;
    uint64_t generation;
    double initial_width;
    double initial_height;
} ot_scene_hooks;

typedef struct ot_scene_frame_options {
    uint32_t struct_size;
    uint32_t abi_version;
    uint16_t background[4];
    uint32_t use_mouse;
    uint32_t excluded_hit_num;
    uint32_t max_layout_rounds;
    uint32_t max_host_requests;
    uint32_t preserve_unwritten; /* 0 clears to spaces; 1 clears untouched snapshot cells to codepoint zero. */
} ot_scene_frame_options;

typedef struct ot_scene_frame_request {
    uint32_t struct_size;
    uint32_t abi_version;
    ot_handle session;
    ot_handle root;
    ot_handle node;
    uint64_t frame_id;
    uint64_t request_id;
    uint64_t layout_epoch;
    uint64_t hook_generation;
    uint32_t kind;
    uint32_t num;
    uint32_t width;
    uint32_t height;
    uint32_t reserved[2];
} ot_scene_frame_request;

#define OT_SCENE_GEOMETRY_PAINT UINT32_C(1)
#define OT_SCENE_GEOMETRY_PUBLIC UINT32_C(2)
typedef struct ot_scene_frame_geometry {
    uint32_t struct_size;
    uint32_t abi_version;
    uint32_t flags;
    uint32_t reserved;
    ot_scene_layout paint;
    ot_scene_layout public_layout;
} ot_scene_frame_geometry;

/* All phase records require exact size/version and zero reserved fields. Hook
 * generations are nonzero and must increase on every change. Initial dimensions
 * seed the resize baseline only before the first layout. Later subscriptions use
 * completed dimensions. Only the root accepts LAYOUT_CHANGED.
 * IDLE_UPDATE consumes the normal update position without a host request or callback.
 * It does not count as a host hook and cannot be combined with UPDATE.
 * Non-root nodes accept RENDER_BEFORE, RENDER_SELF, and RENDER_AFTER.
 * TEXT, EDITOR, and TEXT_VIEW require RENDER_SELF when RENDER_BEFORE is set, because
 * their native drawing resources retire with the node. RENDER_AFTER alone is allowed.
 * Root paint flags are rejected.
 * Rejected registrations leave hook flags, generation, and resize baselines unchanged.
 * No custom measurement or native-to-host callbacks are installed. */
ot_status ot_scene_set_hooks(ot_context *, const ot_handle *node, const ot_scene_hooks *);
/* NULL previous starts an attempt. Otherwise acknowledge the exact returned
 * request, including all identities and dimensions. Invalid replies consume
 * nothing. One ordered request is outstanding; hooks run between native calls.
 * Paint options are copied on each accepted step; max_layout_rounds and
 * max_host_requests stay positive and fixed for the attempt. Yoga completes before host work. Filtered
 * text viewports advance only when refreshed or painted, not during candidate layout.
 * UPDATE runs at most once per node per attempt; getter refresh
 * and resize ordering preserve the mounted and newly placed node contracts.
 * LAYOUT_CHANGED follows an actual Yoga solve, before updates. Layout/preparation
 * limits fail before paint. Request limits also apply during painting. Failure
 * cancels the attempt without presenting partial cells or rolling back mutations.
 * RENDER_BEFORE and RENDER_AFTER bracket a node's own drawing, before children.
 * RENDER_SELF replaces native self drawing with a checked host drawing request.
 * Native editor cursor maintenance follows RENDER_SELF, before RENDER_AFTER.
 * Prepared membership, clipping, and opacity stay fixed. Later paint values and
 * explicitly changed node translations remain live. New nodes wait for the next
 * frame; reparented nodes keep their scheduled positions. Destroyed upcoming nodes
 * skip; an entered node retains its own drawing and after request without reviving
 * its handle or hit identity. Release every qualified scope before resuming.
 * DONE names a retained painted draft, not presentation or a preparation attempt.
 * Native code retains its membership, destination, and storage identity. Neither
 * a paint request nor DONE acquires a buffer lease automatically. Acquire
 * qualified access below only when needed, and explicitly commit or cancel the
 * draft before another frame.
 * During preparation without an explicit YIELD, render, resize, buffer draw,
 * buffer borrowing, setup, and suspend reject with OT_FRAME_BUSY. Close,
 * cancellation, root destruction, and owner teardown invalidate preparation
 * attempts. At an explicit YIELD, an accepted dimension change cancels the
 * attempt; rejection preserves it. Suspension validates terminal phase first
 * and cancels only a preparation/feedback YIELD, without discarding admitted output.
 * During a synchronous paint-hook pause, resize requalifies storage without
 * rebuilding membership. During paint pauses, including paint YIELD, setup and
 * suspend retain the ticket and existing scopes but prevent new access or
 * continuation while terminal-inactive.
 * Root destruction retains the current scope until cancellation, but cannot resume
 * painting. After DONE, destroying nodes
 * or the root leaves painted cells and capture intact without repainting. Commit,
 * frame or Session cancellation, and owner teardown still end draft access.
 *
 * max_paint_members is a positive quota per run between scheduling yields.
 * Each member costs one unit when completed or skipped, including destroyed or
 * stale members. Hook replies
 * do not replenish the quota. Painting starts with max_paint_members units; an
 * exact YIELD acknowledgement replenishes it. A changed maximum on a hook reply
 * clamps the remaining units, including the current member, without adding any.
 * Each call completes or skips at most max_paint_members members. Zero rejects
 * without consuming a request.
 * YIELD pauses only between complete members, never within a node's before/self/
 * after/hit sequence. Its node names the root; num, width, height, and
 * hook_generation are zero. Acknowledge the exact ticket to continue, or cancel
 * the frame. YIELD grants neither buffer access nor commit authority and does not
 * count against max_host_requests. Request IDs increase across both hooks and YIELD.
 * Prepared membership is fixed; partial hits and frame stats are not published.
 *
 * max_work_items is a positive quota for preparation node visits, candidate-view
 * preparation, and feedback records, independent of the paint-member quota.
 * Hook replies clamp remaining work without replenishing it; an exact YIELD reply
 * starts another work quota. Zero rejects without consuming a request.
 * Preparation YIELD also has kind 6, names the root, and requires the exact returned
 * ticket. It grants no buffer access or commit authority. Cancellation and stale
 * ticket checks are unchanged. UINT32_MAX selects synchronous preparation only on
 * begin or an exact YIELD reply. A hook reply cannot switch an already-bounded run
 * to uncharged preparation. Using UINT32_MAX for both quotas from the start keeps
 * preparation and painting synchronous without scheduling yields.
 * Quotas bound counted work items and paint members, not cells or elapsed time.
 * Yoga, allocation/reservation, final paint-list preparation and publication,
 * per-member view/cell work, and output encoding remain synchronous.
 *
 * Geometry observations are produced after phase publication.
 * Geometry is not ticket authority and must not be echoed in acknowledgements.
 * Each flag marks a valid snapshot; absent snapshots are zeroed, including for
 * destroyed continuations, DONE and YIELD. Observation failures do not fail the
 * step: a caller needing that observation must use the checked layout query.
 * Accepted mutations may invalidate these snapshots before the next step.
 * out_geometry requires exact size/version and zero reserved before advancement.
 * All buffers are borrowed only for this call. previous may alias out_request;
 * the two output records must be distinct. */
ot_status ot_scene_frame_step_with_geometry(ot_context *, const ot_handle *session,
    const ot_scene_frame_request *previous, const ot_scene_frame_options *, uint32_t max_paint_members,
    uint32_t max_work_items, ot_scene_frame_request *out_request, ot_scene_frame_geometry *out_geometry);
/* Cancel preparation or a retained painted draft. A stale frame ID rejects without
 * cancelling the active frame. Cancellation immediately revokes qualified access
 * and submission; pending hits cannot publish. Release every acquired scope even
 * when validation returns OT_STALE_LEASE. Scratch NEXT bytes intentionally remain
 * readable through an ordinary storage lease afterward for error inspection;
 * cancellation does not guarantee zeroed cells. */
ot_status ot_scene_frame_cancel(ot_context *, const ot_handle *session, uint64_t frame_id);

/* A root creates one Session scene. Other nodes may remain detached. Nonzero public
 * numbers are immutable; native hit tokens do not recycle. Node handles use the
 * Context table, never the compatibility renderer/Yoga handle registry. */
ot_status ot_scene_create_node(ot_context *, const ot_handle *session, uint32_t kind,
    uint32_t num, ot_handle *out_node);
/* Individual destruction detaches surviving children. Session destruction frees
 * all associated nodes, including detached nodes. NULL parent means detach. */
ot_status ot_scene_destroy_node(ot_context *, const ot_handle *node);
ot_status ot_scene_move_node(ot_context *, const ot_handle *node, const ot_handle *parent, uint32_t index);
/* Synchronous owner-thread measurement on leaves. The callback is borrowed until
 * replacement, unset, node destruction, or Context destruction. NULL clears the
 * single provider slot; it does not restore built-in measurement. The result is
 * two floats (width, height), initialized to NaN, valid only during the callback.
 * Only scene style/layout/text/provider queries may reenter; mutations may not. */
typedef void (*ot_scene_measure_callback)(uint64_t context_id, uint32_t slot, uint32_t generation,
    float width, uint32_t width_mode, float height, uint32_t height_mode, float *out_size);
ot_status ot_scene_set_measure(ot_context *, const ot_handle *node, ot_scene_measure_callback);
ot_status ot_scene_has_measure(ot_context *, const ot_handle *node, uint32_t *out_enabled);
ot_status ot_scene_mark_dirty(ot_context *, const ot_handle *node);
/* Groups: 0 enum, 1 float, 2 value, 3 border (read-only), 4 dimension.
 * Kinds/edges/units follow checked Yoga. Only group 4 accepts flags bit 0,
 * which disables flex shrink atomically with the dimension update. */
ot_status ot_scene_set_style(ot_context *, const ot_handle *node, uint32_t group,
    uint32_t kind, uint32_t edge, uint32_t unit, float value, uint32_t flags);
ot_status ot_scene_get_style(ot_context *, const ot_handle *node, uint32_t group,
    uint32_t kind, uint32_t edge, ot_scene_style_value *out_value);
/* Exact size/version and zero reserved. Borders use L=1 B=2 R=4 T=8;
 * styles are single=0 double=1 rounded=2 heavy=3. Colors retain terminal color intent.
 * focusable is 0 or 1. New nodes default to 0 and focused color {0,170,255,255}.
 * Border layout widths and paint properties publish together on acceptance. */
ot_status ot_scene_set_paint(ot_context *, const ot_handle *node, const ot_scene_paint_options *);
/* --- Staged scene mutations ---
 * ot_scene_flush applies collected style, background, and paint updates under one
 * mutation admission. Entries apply in array order: all styles, then all backgrounds,
 * then all paints. Callers must not submit both a live background entry and a paint
 * entry for the same node in one flush; a background entry whose fields equal
 * OT_SCENE_UPDATE_SKIP is consumed without effect. The first rejected entry stops the
 * flush; out_applied is the exact count of consumed entries across the three arrays in
 * apply order, including skipped entries. No rollback occurs. Each array admits at most
 * OT_SCENE_MUTATIONS_MAX entries; an oversized count returns OT_OBJECT_LIMIT with zero
 * applied before inspecting entries. Style and background entries are plain value
 * records without size/version headers; the paint entry's embedded options carry their
 * own size/version. Arrays are borrowed only for this call and must not alias
 * out_applied. Background entries copy four color words and leave all other paint
 * properties unchanged, with the same color validation as ot_scene_set_paint.
 * A NULL array is valid only with a zero count. out_applied is required
 * and is initialized to zero even when Context admission fails. */
#define OT_SCENE_UPDATE_SKIP UINT32_C(0)
#define OT_SCENE_UPDATE_APPLY UINT32_C(1)

typedef struct ot_scene_style_update {
    ot_handle node;
    uint32_t group;
    uint32_t kind;
    uint32_t edge;
    uint32_t unit;
    float value;
    uint32_t flags;
} ot_scene_style_update;

typedef struct ot_scene_background_update {
    ot_handle node;
    uint32_t fields;
    uint32_t reserved;
    uint16_t background[4];
} ot_scene_background_update;

typedef struct ot_scene_paint_update {
    ot_handle node;
    ot_scene_paint_options paint;
} ot_scene_paint_update;

ot_status ot_scene_flush(ot_context *,
    const ot_scene_style_update *styles, uint32_t style_count,
    const ot_scene_background_update *backgrounds, uint32_t background_count,
    const ot_scene_paint_update *paints, uint32_t paint_count,
    uint32_t *out_applied);
/* Retains a Context-owned buffer for a surface node. NULL clears the binding.
 * Replacement retains the new buffer before releasing the previous binding. */
ot_status ot_scene_set_surface(ot_context *, const ot_handle *node, const ot_handle *buffer);
ot_status ot_scene_set_box_details(ot_context *, const ot_handle *node, const ot_scene_box_details *,
    const uint8_t *title, uint32_t title_bytes, const uint8_t *bottom_title, uint32_t bottom_title_bytes);
/* Accepts border style/sides together and clears custom border characters. */
ot_status ot_scene_set_box_border_style(ot_context *, const ot_handle *node, uint32_t style, uint32_t sides);
/* A box may filter its direct children against a root/box in the same Session.
 * The viewport handle is copied, not pinned. NULL disables filtering. A destroyed
 * viewport fails frame preparation until rebound or disabled. All direct children
 * refresh before selection, including hidden/culled children; hidden nodes do not
 * update or resize. Fewer than 16 total children bypass overlap filtering.
 * Bounds use the full viewport, not its border-inset paint clip. Row/reverse-row
 * use horizontal overlap; column/reverse-column use vertical overlap. Primary
 * overlap is strict, cross-axis touching is included, and padding is zero. */
ot_status ot_scene_set_viewport(ot_context *, const ot_handle *node, const ot_handle *viewport);
/* focused is 0 or 1. Stores one accepted target without host focus/input policy.
 * Focusable boxes on its current ancestor path use focused_border_color. Zero
 * clears only a matching target and remains valid after Session cancellation. */
ot_status ot_scene_set_focus(ot_context *, const ot_handle *node, uint32_t focused);
/* Exact size/version and zero reserved where present. Rejection preserves accepted
 * options and query output. Slider/arrow paint is separate from common node paint;
 * borders are unsupported. No custom arrow strings or native-to-host paint calls. */
ot_status ot_scene_set_slider(ot_context *, const ot_handle *node, const ot_scene_slider_options *);
/* Custom text is copied and bounded by OT_BUFFER_TEXT_BYTES_MAX. NULL selects the standard direction glyph. */
ot_status ot_scene_set_arrow(ot_context *, const ot_handle *node, const ot_scene_arrow_options *, const uint8_t *text, uint32_t byte_count);
/* Uses current observed wrapper dimensions without running Yoga. Before the first
 * observed layout, dimensions come from ot_scene_set_hooks initial_width/height
 * (flags may be zero), or default to zero. Later style changes do not change this
 * constructor baseline. Painting uses completed geometry, not this projection. */
ot_status ot_scene_get_slider_thumb(ot_context *, const ot_handle *node, ot_scene_slider_thumb *out_thumb);
/* Text nodes own their buffer/view and native measure target. Replacements copy
 * UTF-8 and preserve content on rejection. Length is bounded by u32 line/column
 * counts, accounting for tab expansion, not the offscreen drawing call budget.
 * C0/C1/DEL controls are rejected except tab, CR, and LF. Line endings normalize
 * to LF in queries. bytes may be NULL only for zero length. Options require exact
 * size/version; borders and child nodes are not supported on text. */
ot_status ot_scene_set_text(ot_context *, const ot_handle *node, const uint8_t *bytes, uint32_t byte_count);
/* Copies a complete styled replacement. Every chunk requires exact size/version,
 * positive UTF-8 byte_count, and zero reserved. Chunk lengths sum to byte_count.
 * Only FOREGROUND/BACKGROUND flags and attributes bits 0..7 are accepted. Present
 * colors retain terminal color intent; absent colors inherit the node defaults.
 * Chunk widths retain legacy independently measured display-column ranges.
 * All bytes, styles, and listener storage are prepared before publication.
 * Rejection preserves accepted content and resources. No links or style handles.
 * Either array may be NULL only when its count is zero. */
ot_status ot_scene_set_styled_text(ot_context *, const ot_handle *node,
    const uint8_t *bytes, uint32_t byte_count, const ot_scene_text_chunk *chunks, uint32_t chunk_count);
/* Same replacement rules, with the additional LINK flag. link_offset and
 * link_byte_count select bytes in urls; without LINK both must be zero. URLs are
 * copied raw metadata, not parsed or normalized. Empty URLs, URLs over 512 bytes,
 * and chunks with zero independently measured width produce no link. Oversized
 * URLs are not truncated. URLs and their references are prepared before publication;
 * rejection preserves accepted text, styles, and links. urls may be NULL only
 * when url_byte_count is zero. Link IDs stay local to the owning Context. */
ot_status ot_scene_set_styled_text_with_links(ot_context *, const ot_handle *node,
    const uint8_t *bytes, uint32_t byte_count, const ot_scene_linked_text_chunk *chunks, uint32_t chunk_count,
    const uint8_t *urls, uint32_t url_byte_count);
ot_status ot_scene_set_text_options(ot_context *, const ot_handle *node, const ot_scene_text_options *);
/* Select through the owned Text view. Coordinates are local display cells/virtual
 * rows, with signed offscreen positions clamped by the view. Coordinates plus
 * viewport scroll offsets must fit int32_t. UPDATE retains an
 * existing document anchor across scrolling, or acts as SET without an anchor.
 * Exact size/version, zero reserved, and only BACKGROUND/FOREGROUND flags are
 * accepted. Present colors retain terminal color intent; absent color arrays must be zero.
 * out_changed is the view's 0/1 change result. Failure preserves selection and
 * out_changed. RESET needs no allocation and is allowed after Session cancellation.
 * Mutation is forbidden during measurement callbacks, including RESET. */
ot_status ot_scene_set_text_selection(ot_context *, const ot_handle *node,
    const ot_scene_text_selection_options *, uint32_t *out_changed);
/* Packed display-column offsets: start in the high 32 bits, exclusive end in the
 * low 32 bits. UINT64_MAX means absent or zero-width selection. */
ot_status ot_scene_get_text_selection(ot_context *, const ot_handle *node, uint64_t *out_packed);
/* Zero capacity reports a safe full-document UTF-8 byte bound, not the selected
 * byte count; absent/zero-width selection reports zero. A copy requires at least
 * that bound and returns the actual selected byte count, without a terminating
 * NUL. Insufficient capacity rejects before writing bytes or out_count. bytes may
 * be NULL only for zero capacity. These reads follow the text getter rules. */
ot_status ot_scene_get_selected_text(ot_context *, const ot_handle *node,
    uint8_t *bytes, uint32_t capacity, uint32_t *out_count);
/* Copied queries retain no native memory. Zero capacity reports the exact count;
 * otherwise insufficient capacity rejects without writing either output. bytes
 * and lines may be NULL only for zero capacity. Text has no terminating NUL;
 * lines includes all virtual lines, not only the visible viewport. Info requires
 * exact size/version. Queries never perform Yoga layout or resize the viewport. */
ot_status ot_scene_get_text(ot_context *, const ot_handle *node, uint8_t *bytes, uint32_t capacity, uint32_t *out_count);
ot_status ot_scene_get_text_info(ot_context *, const ot_handle *node, ot_scene_text_info *out_info);
ot_status ot_scene_get_text_lines(ot_context *, const ot_handle *node, ot_scene_text_line *lines, uint32_t capacity, uint32_t *out_count);
/* raw_yoga=0 copies local cell geometry from the node's latest preparation refresh.
 * During host phases, mounted nodes retain their preceding projection until that
 * refresh; newly placed children refresh before their own update. screen_x/y
 * combine that geometry with current accepted ancestor relationships
 * and translations immediately, without running layout. raw_yoga=1 instead
 * copies the six actual Yoga computed values, including zero dimensions, and
 * sets screen_x/y to zero. raw_yoga=2 copies cached paint geometry, including
 * screen_x/y. During a paint prefix, reparenting and ancestor translations do not
 * change those coordinates; the node's own translation setters refresh them.
 * These reads do not run layout. Other selectors reject without changing output. */
ot_status ot_scene_get_layout(ot_context *, const ot_handle *node, uint32_t raw_yoga, ot_scene_layout *out_layout);
/* Layout and paint only. No output or hit-grid publication occurs until the
 * existing Session render/output-completion path accepts and presents the frame.
 * Pending presentation rejects painting; accepted scene mutations remain valid.
 * excluded_hit_num is the captured node's public number, or zero. It excludes
 * only that node from this frame's hits, not its painting or descendants.
 * Uses the same phase engine, but rejects registered hooks before layout with
 * OT_UNSUPPORTED_RESOURCE. Use ot_scene_frame_step_with_geometry for host hooks. */
ot_status ot_scene_paint(ot_context *, const ot_handle *session, const uint16_t background[4], uint32_t use_mouse, uint32_t excluded_hit_num);
ot_status ot_scene_hit_test(ot_context *, const ot_handle *session, int32_t x, int32_t y, uint32_t *out_num);
ot_status ot_scene_get_stats(ot_context *, const ot_handle *session, ot_scene_stats *out_stats);
/* Copied renderer cursor state. Style: block=0 line=1 underline=2 default=3.
 * Colors use normalized float channels. Output requires exact size/version. */
ot_status ot_scene_get_cursor_state(ot_context *, const ot_handle *session, ot_scene_cursor_state *out_state);

/* chunk_size, span_capacity, and max_bytes are explicit and positive. max_bytes
 * is a multiple of chunk_size and must fit at most UINT32_MAX chunks. It bounds
 * allocated feed chunks and outstanding payload bytes. span_capacity includes
 * queued and copied output awaiting completion. All chunks are allocated at creation.
 * control_capacity is zero for no reservation. A positive value reserves bytes
 * inside max_bytes, rounded up to whole chunks, with one span slot per chunk.
 * Ordinary writes cannot use this capacity. The reservation must leave at least
 * one ordinary chunk and one ordinary span slot. Terminal setup requires at least
 * OT_SESSION_CONTROL_PACKET_BYTES of rounded control storage. reserved is zero. */
typedef struct ot_session_options {
    uint32_t struct_size;
    uint32_t abi_version;
    uint32_t chunk_size;
    uint32_t span_capacity;
    uint64_t max_bytes;
    uint32_t control_capacity;
    uint32_t reserved;
} ot_session_options;

/* Output bytes are copied into caller-owned storage. Complete this exact ticket
 * only after its bytes reach the transport, not when a write merely queues them.
 * At most one ticket is pending per session. reserved is always zero. */
typedef struct ot_output_ticket {
    ot_handle session;
    uint64_t request_id;
    uint32_t byte_count;
    uint32_t reserved;
} ot_output_ticket;

#define OT_SESSION_OPEN UINT32_C(0)
#define OT_SESSION_CLOSING UINT32_C(1)
#define OT_SESSION_CLOSED_STATE UINT32_C(2)
#define OT_SESSION_FAILED UINT32_C(3)
#define OT_SESSION_CANCELLED_STATE UINT32_C(4)

/* Attach without terminal setup or output. Dimensions are positive terminal
 * cells and obey the Context's render_cells_max. remote is 0 or 1; remote
 * terminals do not inherit the local terminal environment. reserved is zero. */
typedef struct ot_session_renderer_options {
    uint32_t struct_size;
    uint32_t abi_version;
    uint32_t width;
    uint32_t height;
    uint32_t remote;
    uint32_t reserved;
} ot_session_renderer_options;

#define OT_SESSION_REMOTE_AUTO UINT32_C(0)
#define OT_SESSION_REMOTE_LOCAL UINT32_C(1)
#define OT_SESSION_REMOTE_REMOTE UINT32_C(2)
#define OT_SESSION_ENV_ENTRIES_MAX UINT32_C(256)
#define OT_SESSION_ENV_BYTES_MAX UINT32_C(65536)

/* Additive attachment with initialization-only copied host environment. Payload
 * contains entry_count repetitions of little-endian u32 key/value byte lengths,
 * then key bytes and value bytes. UTF-8 keys are nonempty and exclude NUL/'=';
 * values exclude NUL. Duplicate keys use the last value. Empty payload opts out.
 * Auto detects remote sessions but ignores forwarded host hints when remote;
 * explicit local/remote modes apply all supplied hints. No process env is read.
 * reserved is zero. Payload and options are borrowed only for the call. */
typedef struct ot_session_renderer_env_options {
    uint32_t struct_size;
    uint32_t abi_version;
    uint32_t width;
    uint32_t height;
    uint32_t remote_mode;
    uint32_t entry_count;
    uint32_t byte_count;
    uint32_t reserved;
} ot_session_renderer_env_options;

#define OT_RENDER_PRESENTED UINT32_C(0)
#define OT_RENDER_PENDING UINT32_C(1)
#define OT_RENDER_SKIPPED UINT32_C(2)
#define OT_RENDER_FAILED UINT32_C(3)

typedef struct ot_split_snapshot {
    ot_handle buffer;
    uint32_t row_columns;
    uint32_t flags; /* 1 = start on new line, 2 = trailing newline. */
} ot_split_snapshot;

/* command: reset=0, sync=1, output-offset=2, render-offset=3, transition=4,
 * clear-transition=5. Reset uses seed rows/pinned offset; sync and offset commands
 * use argument 0. Transition uses mode (viewport-scroll=1, clear=2), source top,
 * source height, target top, target height, scroll rows. Unused arguments are zero. */
typedef struct ot_split_control {
    uint32_t struct_size;
    uint32_t abi_version;
    uint32_t command;
    uint32_t arguments[6];
} ot_split_control;

/* Copy a checked painted draft into a Context buffer without presenting it. */
ot_status ot_scene_frame_copy_buffer(ot_context *, const ot_handle *session,
    const ot_scene_frame_request *, const ot_handle *target);
/* Solve an idle scene's existing root without frame preparation, hooks, or painting.
 * Custom Yoga measurement providers may run. Read computed dimensions with raw_yoga=1. */
ot_status ot_scene_measure_layout(ot_context *, const ot_handle *session, const ot_handle *root);
/* At most 64 snapshots; Context identities are checked before native bounded copies.
 * A null frame submits snapshots only, without painting or publishing the footer draft.
 * After suspension completes, null-frame snapshots remain permitted without reactivating
 * terminal modes; their output packet leaves the cursor restored. Non-null frames and
 * submissions during terminal transitions retain the ordinary rendering restrictions.
 * force is 0/1. Output records publish only on successful admission. */
ot_status ot_session_render_split(ot_context *, const ot_handle *session, const ot_scene_frame_request *,
    const ot_split_snapshot *, uint32_t count, uint32_t pinned_render_offset, uint32_t force,
    uint32_t *out_status, uint32_t *out_render_offset);
ot_status ot_session_split_control(ot_context *, const ot_handle *session, const ot_split_control *, uint32_t *out_offset);
/* Screen mode, dimensions, and copied trailing output are admitted together.
 * The screen packet plus trailing output must fit within 4096 bytes. */
ot_status ot_session_set_screen(ot_context *, const ot_handle *session, uint32_t alternate, uint32_t width, uint32_t height,
    const uint8_t *trailing_output, uint32_t byte_count);
ot_status ot_session_sync_detached(ot_context *, const ot_handle *session, const ot_handle *parent);

/* Initialize struct_size and abi_version. The remaining fields are output-only.
 * frame_count counts complete presentations, not queued frames. frame_pending
 * is 0 or 1. This copied record borrows no renderer or framebuffer storage. */
typedef struct ot_session_renderer_state {
    uint32_t struct_size;
    uint32_t abi_version;
    uint32_t width;
    uint32_t height;
    uint64_t frame_count;
    uint32_t frame_pending;
    uint32_t reserved;
} ot_session_renderer_state;

#define OT_SESSION_BUFFER_CURRENT UINT32_C(0)
#define OT_SESSION_BUFFER_NEXT UINT32_C(1)

#define OT_WIDTH_METHOD_WCWIDTH UINT32_C(0)
#define OT_WIDTH_METHOD_UNICODE UINT32_C(1)
#define OT_WIDTH_METHOD_NO_ZWJ UINT32_C(2)
#define OT_WIDTH_METHOD_UNICODE_WIDE UINT32_C(3)
#define OT_BUFFER_RESPECT_ALPHA UINT32_C(1)

/* Context-owned offscreen storage, independent of any Session. Dimensions are
 * positive, at most INT32_MAX, and width * height obeys render_cells_max.
 * width_method is one of OT_WIDTH_METHOD_*. flags is zero or
 * OT_BUFFER_RESPECT_ALPHA; all other bits are rejected. */
typedef struct ot_buffer_options {
    uint32_t struct_size;
    uint32_t abi_version;
    uint32_t width;
    uint32_t height;
    uint32_t width_method;
    uint32_t flags;
} ot_buffer_options;

/* Copied records belong to a live Unicode resource. character is not a portable
 * scalar: pooled values may only be drawn through their owning Context resource. */
typedef struct ot_unicode_char {
    uint32_t width;
    uint32_t character;
} ot_unicode_char;

ot_status ot_unicode_create(ot_context *, const uint8_t *bytes, uint32_t byte_count,
    uint32_t width_method, ot_handle *out_unicode);
ot_status ot_unicode_destroy(ot_context *, const ot_handle *unicode);
/* Zero capacity reports the count; insufficient capacity preserves both outputs. */
ot_status ot_unicode_get(ot_context *, const ot_handle *unicode, ot_unicode_char *characters,
    uint32_t capacity, uint32_t *out_count);
ot_status ot_buffer_draw_unicode(ot_context *, const ot_handle *target,
    const ot_scene_frame_request *frame, const ot_handle *unicode, uint32_t index,
    int32_t x, int32_t y, const uint16_t foreground[4], const uint16_t background[4], uint32_t attributes);

typedef struct ot_embedded_terminal_options {
    uint32_t struct_size;
    uint32_t abi_version;
    uint32_t cols;
    uint32_t rows;
    uint32_t max_scrollback;
    uint32_t reserved;
} ot_embedded_terminal_options;

typedef struct ot_embedded_terminal_cursor {
    uint32_t struct_size;
    uint32_t abi_version;
    uint32_t x;
    uint32_t y;
    uint32_t has_value;
    uint32_t visible;
    uint32_t blinking;
    uint32_t wide_tail;
    uint32_t style;
    uint32_t color_has_value;
    uint32_t color_r;
    uint32_t color_g;
    uint32_t color_b;
    uint32_t reserved;
} ot_embedded_terminal_cursor;

typedef struct ot_embedded_terminal_key {
    uint32_t struct_size;
    uint32_t abi_version;
    uint32_t action;
    uint32_t composing;
    uint32_t mods;
    uint32_t consumed_mods;
    uint32_t unshifted_codepoint;
    uint32_t reserved;
} ot_embedded_terminal_key;

typedef struct ot_embedded_terminal_mouse {
    uint32_t struct_size;
    uint32_t abi_version;
    uint32_t action;
    int32_t button;
    uint32_t mods;
    uint32_t any_button_pressed;
    float x;
    float y;
} ot_embedded_terminal_mouse;

/* All option records require exact size/version and zero reserved fields.
 * Booleans are 0/1. Input and output buffers are borrowed only during the call.
 * Columns and rows are positive u16 values within the Context cell budget.
 * Write, key-name, key-text, and paste inputs are each limited to 1 MiB. */
ot_status ot_embedded_terminal_create(ot_context *, const ot_embedded_terminal_options *, ot_handle *out_terminal);
ot_status ot_embedded_terminal_destroy(ot_context *, const ot_handle *terminal);
ot_status ot_embedded_terminal_write(ot_context *, const ot_handle *terminal, const uint8_t *bytes, uint32_t byte_count);
ot_status ot_embedded_terminal_resize(ot_context *, const ot_handle *terminal, uint32_t cols, uint32_t rows);
#define OT_EMBEDDED_TERMINAL_INVALIDATE UINT32_C(0)
#define OT_EMBEDDED_TERMINAL_SCROLL UINT32_C(1)
#define OT_EMBEDDED_TERMINAL_CLEAR_SELECTION UINT32_C(2)
/* argument is a signed row delta for SCROLL, zero otherwise. */
ot_status ot_embedded_terminal_command(ot_context *, const ot_handle *terminal, uint32_t command, int32_t argument);
ot_status ot_embedded_terminal_set_selection(ot_context *, const ot_handle *terminal,
    uint32_t start_x, uint32_t start_y, uint32_t end_x, uint32_t end_y);
/* Selected text and encode calls accept zero capacity to query exact byte counts.
 * Insufficient nonzero capacity preserves output bytes/count and mouse state.
 * No returned buffer includes a terminating NUL. */
ot_status ot_embedded_terminal_get_selected_text(ot_context *, const ot_handle *terminal,
    uint8_t *bytes, uint32_t capacity, uint32_t *out_count);
ot_status ot_embedded_terminal_compose(ot_context *, const ot_handle *terminal, const ot_handle *target,
    const ot_scene_frame_request *frame, int32_t x, int32_t y);
ot_status ot_embedded_terminal_cursor_get(ot_context *, const ot_handle *terminal, ot_embedded_terminal_cursor *out_cursor);
ot_status ot_embedded_terminal_encode_key(ot_context *, const ot_handle *terminal, const ot_embedded_terminal_key *,
    const uint8_t *key, uint32_t key_count, const uint8_t *text, uint32_t text_count,
    uint8_t *bytes, uint32_t capacity, uint32_t *out_count);
ot_status ot_embedded_terminal_encode_mouse(ot_context *, const ot_handle *terminal, const ot_embedded_terminal_mouse *,
    uint8_t *bytes, uint32_t capacity, uint32_t *out_count);
ot_status ot_embedded_terminal_encode_paste(ot_context *, const ot_handle *terminal,
    const uint8_t *input, uint32_t input_count, uint8_t *bytes, uint32_t capacity, uint32_t *out_count);
ot_status ot_embedded_terminal_encode_focus(ot_context *, const ot_handle *terminal,
    uint32_t focused, uint8_t *bytes, uint32_t capacity, uint32_t *out_count);
/* Drains at most capacity bytes, not a sizing query. Response overflow returns
 * OT_OUTPUT_BACKPRESSURE once without consuming the retained 1 MiB prefix. */
ot_status ot_embedded_terminal_drain_responses(ot_context *, const ot_handle *terminal,
    uint8_t *bytes, uint32_t capacity, uint32_t *out_count);

/* Context-owned editor resources use checked handles, never legacy pointers.
 * Options require exact size/version and zero reserved. width_method uses
 * OT_WIDTH_METHOD_*. Creation failures leave output handles unchanged. */
typedef struct ot_edit_buffer_options {
    uint32_t struct_size;
    uint32_t abi_version;
    uint32_t width_method;
    uint32_t reserved;
} ot_edit_buffer_options;

/* Initialize size/version and zero remaining fields. Other fields are copied output.
 * Cursor row is a zero-based document line; col and offset count display columns,
 * not UTF-8 bytes or code points. can_undo and can_redo are 0 or 1.
 * tab_width is the even display-cell width in [2, 254].
 * content_epoch is an invalidation token, not a count of user edits. */
typedef struct ot_edit_buffer_info {
    uint32_t struct_size;
    uint32_t abi_version;
    uint64_t content_epoch;
    uint32_t byte_count;
    uint32_t line_count;
    uint32_t cursor_row;
    uint32_t cursor_col;
    uint32_t cursor_offset;
    uint32_t can_undo;
    uint32_t can_redo;
    uint32_t tab_width;
} ot_edit_buffer_info;

#define OT_EDIT_CURSOR_CHANGED UINT32_C(1)
#define OT_EDIT_CONTENT_CHANGED UINT32_C(2)
#define OT_EDIT_HISTORY_CURSOR_CHANGED UINT32_C(4)

/* Complete cursor options, not a patch. Exact size/version and zero reserved.
 * show_cursor and blinking are 0 or 1. style is block=0, line=1, underline=2, default=3.
 * color retains packed intent for capture; cursor output uses its RGB snapshot.
 * mouse_pointer is 0..5, or 6 to leave it unchanged. */
typedef struct ot_scene_editor_options {
    uint32_t struct_size;
    uint32_t abi_version;
    uint32_t show_cursor;
    uint32_t style;
    uint32_t blinking;
    uint32_t reserved;
    uint16_t color[4];
    uint32_t mouse_pointer;
    uint32_t reserved2;
} ot_scene_editor_options;

ot_status ot_edit_buffer_create(ot_context *, const ot_edit_buffer_options *, ot_handle *out_edit_buffer);
/* Destroying an edit buffer also destroys its views and unbinds their scene nodes.
 * Destroying a view alone leaves its edit buffer alive. */
ot_status ot_edit_buffer_destroy(ot_context *, const ot_handle *edit_buffer);
/* Initial viewport dimensions are display cells, from zero through INT32_MAX. */
ot_status ot_editor_view_create(ot_context *, const ot_handle *edit_buffer,
    uint32_t width, uint32_t height, ot_handle *out_view);
ot_status ot_editor_view_destroy(ot_context *, const ot_handle *view);
/* Creates an empty style table. Destroying it clears attached native references. */
ot_status ot_syntax_style_create(ot_context *, ot_handle *out_style);
ot_status ot_syntax_style_destroy(ot_context *, const ot_handle *style);
/* NULL clears the binding. A non-NULL style must belong to this Context. */
ot_status ot_edit_buffer_set_syntax_style(ot_context *, const ot_handle *edit_buffer, const ot_handle *style);
/* Copy UTF-8 bytes into owned storage; bytes may be NULL only for zero length.
 * C0/C1/DEL controls reject except tab, CR, and LF. Queries normalize line endings
 * to LF. preserve_history is 0 (clear history) or 1 (create an undo point).
 * Replacement resets the cursor to the origin; insertion uses the primary cursor.
 * No input memory remains borrowed after return. */
ot_status ot_edit_buffer_set_text(ot_context *, const ot_handle *edit_buffer,
    const uint8_t *bytes, uint32_t byte_count, uint32_t preserve_history);
ot_status ot_edit_buffer_insert_text(ot_context *, const ot_handle *edit_buffer,
    const uint8_t *bytes, uint32_t byte_count);
/* Zero-based document rows and display columns. Deletion orders its endpoints and
 * excludes the end; equal endpoints do nothing. Cursor setting clamps to the text. */
ot_status ot_edit_buffer_delete_range(ot_context *, const ot_handle *edit_buffer,
    uint32_t start_row, uint32_t start_col, uint32_t end_row, uint32_t end_col);
ot_status ot_edit_buffer_set_cursor(ot_context *, const ot_handle *edit_buffer, uint32_t row, uint32_t col);
/* Zero capacity reports the exact UTF-8 byte count. Otherwise capacity must fit
 * all bytes; undersized calls preserve both outputs. No terminating NUL is added.
 * bytes may be NULL only for zero capacity. Copied outputs borrow no native memory.
 * These getters and the view getter allow readonly measurement-callback reentry,
 * but not reentry from an edit notification during a mutation. */
ot_status ot_edit_buffer_get_text(ot_context *, const ot_handle *edit_buffer,
    uint8_t *bytes, uint32_t capacity, uint32_t *out_count);
ot_status ot_edit_buffer_get_info(ot_context *, const ot_handle *edit_buffer, ot_edit_buffer_info *out_info);
/* width is a display-cell tab stop. Native code rounds it up to an even value in [2, 254]. */
ot_status ot_edit_buffer_set_tab_width(ot_context *, const ot_handle *edit_buffer, uint32_t width);

/* Editor transport records require exact size/version. Unknown selectors and
 * unused nonzero arguments reject. Mutations reject callback reentry and validate
 * every native measure dependency. Invalidation never reinstalls an unset provider.
 * All coordinates and offsets count display cells, never UTF-8 bytes. */
#define OT_EDIT_DELETE_FORWARD UINT32_C(0)
#define OT_EDIT_BACKSPACE UINT32_C(1)
#define OT_EDIT_NEW_LINE UINT32_C(2)
#define OT_EDIT_DELETE_LINE UINT32_C(3)
#define OT_EDIT_MOVE_LEFT UINT32_C(4)
#define OT_EDIT_MOVE_RIGHT UINT32_C(5)
#define OT_EDIT_MOVE_UP UINT32_C(6)
#define OT_EDIT_MOVE_DOWN UINT32_C(7)
#define OT_EDIT_GOTO_LINE UINT32_C(8)
#define OT_EDIT_CURSOR_OFFSET UINT32_C(9)
#define OT_EDIT_CLEAR UINT32_C(10)
#define OT_EDIT_CLEAR_HISTORY UINT32_C(11)
#define OT_EDIT_DEBUG_ROPE UINT32_C(12)
/* argument is a line/offset for GOTO_LINE/CURSOR_OFFSET, zero otherwise. */
ot_status ot_edit_buffer_command(ot_context *, const ot_handle *, uint32_t command, uint32_t argument);
/* redo is 0/1. Capacity must be at least 64, the native cursor-metadata bound,
 * before history is changed. No history returns zero bytes. */
ot_status ot_edit_buffer_history(ot_context *, const ot_handle *, uint32_t redo,
    uint8_t *bytes, uint32_t capacity, uint32_t *out_count);

#define OT_EDIT_POSITION_CURSOR UINT32_C(0)
#define OT_EDIT_POSITION_NEXT_WORD UINT32_C(1)
#define OT_EDIT_POSITION_PREV_WORD UINT32_C(2)
#define OT_EDIT_POSITION_EOL UINT32_C(3)
#define OT_EDIT_POSITION_OFFSET UINT32_C(4)
#define OT_EDIT_POSITION_COORDS UINT32_C(5)
#define OT_EDIT_POSITION_LINE_START UINT32_C(6)
typedef struct ot_edit_position {
    uint32_t struct_size;
    uint32_t abi_version;
    uint32_t valid;
    uint32_t row;
    uint32_t col;
    uint32_t offset;
} ot_edit_position;
/* a is offset, row, or line for OFFSET, COORDS, LINE_START; b is col for COORDS.
 * Other inputs are zero. Invalid positions return valid=0 and zero coordinates. */
ot_status ot_edit_buffer_get_position(ot_context *, const ot_handle *, uint32_t query,
    uint32_t a, uint32_t b, ot_edit_position *out_position);
/* by_coords=0 uses start_col/end_col as offsets and requires zero rows;
 * by_coords=1 uses all coordinates. Zero capacity returns a safe document byte
 * bound; nonzero capacity must fit that bound and returns the actual byte count. */
ot_status ot_edit_buffer_get_range(ot_context *, const ot_handle *, uint32_t by_coords,
    uint32_t start_row, uint32_t start_col, uint32_t end_row, uint32_t end_col,
    uint8_t *bytes, uint32_t capacity, uint32_t *out_count);

#define OT_EDITOR_STYLE_FOREGROUND UINT32_C(1)
#define OT_EDITOR_STYLE_BACKGROUND UINT32_C(2)
#define OT_EDITOR_STYLE_ATTRIBUTES UINT32_C(4)
typedef struct ot_editor_style {
    uint32_t struct_size;
    uint32_t abi_version;
    uint32_t flags;
    uint32_t attributes;
    uint16_t foreground[4];
    uint16_t background[4];
} ot_editor_style;
/* mask selects fields to update. flags identifies present (non-null) values.
 * Absent fields are zero; colors retain terminal color intent, attributes bits 0..7.
 * Reset uses mask=7 and flags=0. */
ot_status ot_edit_buffer_set_defaults(ot_context *, const ot_handle *, uint32_t mask, const ot_editor_style *);
/* Names are copied UTF-8; registering an existing name replaces its definition.
 * Empty names are valid; name may be NULL only when byte_count is zero. */
ot_status ot_syntax_style_register(ot_context *, const ot_handle *, const uint8_t *name,
    uint32_t byte_count, const ot_editor_style *, uint32_t *out_id);
/* Unknown names return id=0. Names are borrowed only for the query. */
ot_status ot_syntax_style_resolve(ot_context *, const ot_handle *, const uint8_t *name,
    uint32_t byte_count, uint32_t *out_id);
ot_status ot_syntax_style_get_count(ot_context *, const ot_handle *, uint32_t *out_count);

#define OT_EDIT_HIGHLIGHT_ADD_LINE UINT32_C(0)
#define OT_EDIT_HIGHLIGHT_ADD_RANGE UINT32_C(1)
#define OT_EDIT_HIGHLIGHT_REMOVE_REF UINT32_C(2)
#define OT_EDIT_HIGHLIGHT_CLEAR_LINE UINT32_C(3)
#define OT_EDIT_HIGHLIGHT_CLEAR_ALL UINT32_C(4)
typedef struct ot_edit_highlight {
    uint32_t start;
    uint32_t end;
    uint32_t style_id;
    uint32_t priority;
    uint32_t ref;
} ot_edit_highlight;
/* highlight is required only for ADD operations. argument is line for ADD_LINE/
 * CLEAR_LINE, ref for REMOVE_REF, zero otherwise. priority<=255, ref<=65535. */
ot_status ot_edit_buffer_highlight(ot_context *, const ot_handle *, uint32_t operation,
    uint32_t argument, const ot_edit_highlight *highlight);
ot_status ot_edit_buffer_get_highlights(ot_context *, const ot_handle *, uint32_t line,
    ot_edit_highlight *highlights, uint32_t capacity, uint32_t *out_count);

typedef struct ot_editor_viewport {
    uint32_t struct_size;
    uint32_t abi_version;
    uint32_t x;
    uint32_t y;
    uint32_t width;
    uint32_t height;
} ot_editor_viewport;
/* size_only and move_cursor are 0/1. size_only requires zero x/y and move_cursor.
 * Viewports and their coordinate sums must fit INT32_MAX. */
ot_status ot_editor_view_set_viewport(ot_context *, const ot_handle *, const ot_editor_viewport *,
    uint32_t size_only, uint32_t move_cursor);
ot_status ot_editor_view_get_viewport(ot_context *, const ot_handle *, ot_editor_viewport *out_viewport);
ot_status ot_editor_view_set_scroll_margin(ot_context *, const ot_handle *, float margin);
#define OT_EDITOR_MOVE_UP UINT32_C(0)
#define OT_EDITOR_MOVE_DOWN UINT32_C(1)
#define OT_EDITOR_GOTO_LINE_END UINT32_C(2)
#define OT_EDITOR_DELETE_SELECTION UINT32_C(3)
#define OT_EDITOR_CURSOR_OFFSET UINT32_C(4)
#define OT_EDITOR_WRAP_MODE UINT32_C(5)
#define OT_EDITOR_TAB_INDICATOR UINT32_C(6)
/* argument is offset, OT_SCENE_WRAP_*, or Unicode scalar (0 disables) for the
 * last three commands, and zero otherwise. */
ot_status ot_editor_view_command(ot_context *, const ot_handle *, uint32_t command, uint32_t argument);
/* Atomic selected delete-then-insert using native editor history and event order.
 * Without a selection inserts at the primary cursor. Input bytes are copied. */
/* out_steps reports committed history steps: 1 = deletion, 2 = insertion. */
ot_status ot_editor_view_replace_selection(ot_context *, const ot_handle *, const uint8_t *bytes,
    uint32_t byte_count, uint32_t *out_steps);
/* NULL clears the tab color. */
ot_status ot_editor_view_set_tab_color(ot_context *, const ot_handle *, const uint16_t color[4]);

#define OT_EDITOR_SELECT_SET UINT32_C(0)
#define OT_EDITOR_SELECT_UPDATE UINT32_C(1)
#define OT_EDITOR_SELECT_RESET UINT32_C(2)
#define OT_EDITOR_SELECT_LOCAL UINT32_C(3)
#define OT_EDITOR_SELECT_LOCAL_UPDATE UINT32_C(4)
#define OT_EDITOR_SELECT_LOCAL_RESET UINT32_C(5)
#define OT_EDITOR_SELECT_CELL UINT32_C(6)
#define OT_EDITOR_SELECT_OCCUPANCY UINT32_C(7)
#define OT_EDITOR_SELECT_INCLUSIVE UINT32_C(8)
#define OT_EDITOR_SELECT_COLORS UINT32_C(9)
typedef struct ot_editor_selection {
    uint32_t struct_size;
    uint32_t abi_version;
    uint32_t operation;
    uint32_t behavior;
    uint32_t start;
    uint32_t end;
    int32_t anchor_x;
    int32_t anchor_y;
    int32_t focus_x;
    int32_t focus_y;
    uint32_t update_cursor;
    uint32_t follow_cursor;
    uint32_t flags;
    uint32_t reserved;
    uint16_t foreground[4];
    uint16_t background[4];
} ot_editor_selection;
/* flags uses FOREGROUND/BACKGROUND; behavior is cell=0 word=1 line=2 for local
 * operations, or occupancy cell=0 boundary=1 for OCCUPANCY. Unused fields are zero.
 * out_changed is meaningful for LOCAL/LOCAL_UPDATE/CELL, otherwise zero. */
ot_status ot_editor_view_select(ot_context *, const ot_handle *, const ot_editor_selection *, uint32_t *out_changed);
typedef struct ot_editor_view_info {
    uint32_t struct_size;
    uint32_t abi_version;
    uint32_t virtual_line_count;
    uint32_t total_virtual_line_count;
    uint32_t selection_present;
    uint32_t selection_start;
    uint32_t selection_end;
    uint32_t selection_occupancy;
} ot_editor_view_info;
/* follow_cursor is 0/1. Zero preserves the viewport during observational queries;
 * one retains editor render-preparation behavior for visible line-count queries. */
ot_status ot_editor_view_get_info(ot_context *, const ot_handle *, uint32_t follow_cursor, ot_editor_view_info *out_info);
/* Reads selection without preparing lines or following the cursor. Reuses the
 * info record with both line counts zero; absent or zero-width selections report
 * selection_present=0 and zero offsets. */
ot_status ot_editor_view_get_selection(ot_context *, const ot_handle *, ot_editor_view_info *out_info);
ot_status ot_editor_view_get_selected_text(ot_context *, const ot_handle *,
    uint8_t *bytes, uint32_t capacity, uint32_t *out_count);
#define OT_EDITOR_POSITION_CURSOR UINT32_C(0)
#define OT_EDITOR_POSITION_NEXT_WORD UINT32_C(1)
#define OT_EDITOR_POSITION_PREV_WORD UINT32_C(2)
#define OT_EDITOR_POSITION_EOL UINT32_C(3)
#define OT_EDITOR_POSITION_VISUAL_SOL UINT32_C(4)
#define OT_EDITOR_POSITION_VISUAL_EOL UINT32_C(5)
typedef struct ot_editor_position {
    uint32_t struct_size;
    uint32_t abi_version;
    uint32_t visual_row;
    uint32_t visual_col;
    uint32_t logical_row;
    uint32_t logical_col;
    uint32_t offset;
} ot_editor_position;
ot_status ot_editor_view_get_position(ot_context *, const ot_handle *, uint32_t query, ot_editor_position *out_position);
typedef struct ot_editor_measure {
    uint32_t struct_size;
    uint32_t abi_version;
    uint32_t line_count;
    uint32_t width_cols_max;
} ot_editor_measure;
/* logical=0 copies current viewport line info; logical=1 copies logical line info.
 * Zero capacity reports the count; otherwise all records must fit. */
ot_status ot_editor_view_get_lines(ot_context *, const ot_handle *, uint32_t logical,
    ot_scene_text_line *lines, uint32_t capacity, ot_editor_measure *out_info);
ot_status ot_editor_view_measure(ot_context *, const ot_handle *, uint32_t width, uint32_t height, ot_editor_measure *out_info);
/* Copies owned placeholder text and styles; zero chunks clears the placeholder.
 * Uses the same no-link chunk validation as ot_scene_set_styled_text. */
ot_status ot_editor_view_set_placeholder(ot_context *, const ot_handle *, const uint8_t *bytes,
    uint32_t byte_count, const ot_scene_text_chunk *chunks, uint32_t chunk_count);
/* One synchronous owner-thread observer per Context, borrowed until replacement,
 * NULL clearing, or Context destruction. event is one OT_EDIT_* value, not a mask.
 * The identity names the edit buffer in this native image. Queue host work before
 * returning: mutations, callback replacement, drains, and destruction reject
 * reentry with OT_CONTEXT_BUSY. */
typedef void (*ot_edit_event_callback)(uint64_t context_id, uint32_t slot, uint32_t generation, uint32_t event);
ot_status ot_context_set_edit_event_callback(ot_context *, ot_edit_event_callback);
/* Bind only OT_SCENE_EDITOR nodes. A view binds at most one node at a time.
 * NULL unbinds. Binding retains no host memory and does not transfer ownership.
 * Session/node destruction unbinds without destroying the view or edit buffer. */
ot_status ot_scene_set_editor_view(ot_context *, const ot_handle *node, const ot_handle *view);
ot_status ot_scene_set_editor_options(ot_context *, const ot_handle *node, const ot_scene_editor_options *);

#define OT_IMAGE_FIT UINT32_C(0)
#define OT_IMAGE_COVER UINT32_C(1)
#define OT_IMAGE_FILL UINT32_C(2)
#define OT_IMAGE_PROTOCOL_AUTO UINT32_C(0)
#define OT_IMAGE_PROTOCOL_KITTY UINT32_C(1)
#define OT_IMAGE_PROTOCOL_SIXEL UINT32_C(2)
#define OT_IMAGE_PROTOCOL_BLOCKS UINT32_C(3)
#define OT_IMAGE_DRAW_SOURCE_WIDTH UINT32_C(1)
#define OT_IMAGE_DRAW_SOURCE_HEIGHT UINT32_C(2)

/* Clone a live compatibility image into Context-owned storage, including retained
 * encoded PNG data. This explicit bridge is the only image call accepting a legacy
 * u32 token. The source remains caller-owned; no compatibility token is attached
 * to the copy. Failure preserves out_image. */
ot_status ot_image_import_compat(ot_context *, uint32_t source, ot_handle *out_image);
ot_status ot_image_destroy(ot_context *, const ot_handle *image);
/* Bind only IMAGE nodes. NULL image clears the binding. Nodes and drawn placements
 * retain their image independently of the imported handle. Optional buffer names
 * Context-owned backing storage for buffered Image drawing, not a legacy buffer.
 * fit and protocol use OT_IMAGE_*; mutations reject measurement-callback reentry. */
ot_status ot_scene_set_image(ot_context *, const ot_handle *node, const ot_handle *image,
    uint32_t fit, uint32_t protocol, const ot_handle *buffer);

/* x/y and width/height count terminal cells. pixel_* and source_* count image
 * pixels. Absent source extents and reserved fields must be zero. Exact size and
 * version are required. Only the two SOURCE_* flags are accepted. */
typedef struct ot_image_draw_options {
    uint32_t struct_size;
    uint32_t abi_version;
    uint32_t flags;
    uint32_t protocol;
    int32_t x;
    int32_t y;
    uint32_t width;
    uint32_t height;
    uint32_t pixel_width;
    uint32_t pixel_height;
    uint32_t source_x;
    uint32_t source_y;
    uint32_t source_width;
    uint32_t source_height;
    uint32_t reserved[2];
} ot_image_draw_options;

/* Offscreen buffers require NULL frame; Session drawing requires its current
 * frame ticket. out_drawn is 0 for empty/clipped draws and 1 for accepted drawing.
 * Invalid options preserve both target cells and out_drawn. */
ot_status ot_buffer_draw_image(ot_context *, const ot_handle *target, const ot_scene_frame_request *frame,
    const ot_handle *image, const ot_image_draw_options *, uint32_t *out_drawn);
/* Store terminal cell and pixel dimensions for native Image fit calculations.
 * All four values are positive, or all zero to clear the resolution. */
ot_status ot_session_set_image_resolution(ot_context *, const ot_handle *session,
    uint32_t terminal_width, uint32_t terminal_height, uint32_t pixel_width, uint32_t pixel_height);

/* Kitty image transport is renderer state, not a terminal control packet.
 * requested is 0=raw, 1=zlib, 2=file. effective is 0=raw, 1=zlib, 2=png, 3=file.
 * file_state is 0=disabled, 1=probing, 2=ready, 3=unsupported, 4=timeout,
 * 5=io-error, 6=cancelled. fallback is 0=none, 1=not-ready, 2=unavailable,
 * 3=budget, 4=busy, 5=preparation, 6=compression. pending_bytes fits u32.
 * Set, poll, cancel, and reply require an attached renderer and may run in any
 * open phase so resume can consume probe replies before JS restores control.
 * File probes emit only while the terminal is active and not suspended. */
typedef struct ot_session_kitty_image_transport {
    uint32_t struct_size;
    uint32_t abi_version;
    uint32_t requested;
    uint32_t effective;
    uint32_t file_state;
    uint32_t fallback;
    uint32_t pending_files;
    uint32_t pending_bytes;
} ot_session_kitty_image_transport;

ot_status ot_session_set_kitty_image_transport(ot_context *, const ot_handle *session, uint32_t mode);
ot_status ot_session_get_kitty_image_transport(
    ot_context *,
    const ot_handle *session,
    ot_session_kitty_image_transport *out_status);
ot_status ot_session_poll_kitty_image_transport(ot_context *, const ot_handle *session, uint32_t *out_retry);
ot_status ot_session_cancel_kitty_image_transport(ot_context *, const ot_handle *session, uint32_t failed);
/* out_result is 0=ignored, 1=consumed, 2=consumed and images should retransmit. */
ot_status ot_session_process_kitty_image_reply(
    ot_context *,
    const ot_handle *session,
    const uint8_t *bytes,
    uint32_t byte_count,
    uint32_t *out_result);
ot_status ot_session_start_kitty_file_probe(ot_context *, const ot_handle *session);

/* Shared text buffers own copied bytes, styles and links. Destroying a buffer
 * destroys its dependent views; destroying a node only unbinds its view.
 * Existing editor style, highlight, viewport, selection and measurement records
 * retain their ABI1 layouts. Text selection rejects cursor-only flags. */
typedef struct ot_text_buffer_info {
    uint32_t struct_size;
    uint32_t abi_version;
    uint64_t content_epoch;
    uint32_t byte_count;
    uint32_t text_length;
    uint32_t line_count;
    uint32_t highlight_count;
    uint32_t tab_width;
    uint32_t reserved;
} ot_text_buffer_info;

#define OT_TEXT_VIEW_WRAP_WIDTH UINT32_C(0)
#define OT_TEXT_VIEW_WRAP_MODE UINT32_C(1)
#define OT_TEXT_VIEW_FIRST_LINE_OFFSET UINT32_C(2)
#define OT_TEXT_VIEW_TAB_INDICATOR UINT32_C(3)
#define OT_TEXT_VIEW_TRUNCATE UINT32_C(4)

ot_status ot_text_buffer_create(ot_context *, const ot_edit_buffer_options *, ot_handle *out_buffer);
ot_status ot_text_buffer_destroy(ot_context *, const ot_handle *);
ot_status ot_text_buffer_view_create(ot_context *, const ot_handle *buffer, ot_handle *out_view);
ot_status ot_text_buffer_view_destroy(ot_context *, const ot_handle *);
ot_status ot_text_buffer_set_text(ot_context *, const ot_handle *, const uint8_t *, uint32_t byte_count);
ot_status ot_text_buffer_append(ot_context *, const ot_handle *, const uint8_t *, uint32_t byte_count);
ot_status ot_text_buffer_clear(ot_context *, const ot_handle *, uint32_t reset);
/* Empty chunks retain their ordinal for generated chunkN names, but register no
 * style or link. Unlike direct scene text, chunk_count can exceed byte_count. */
ot_status ot_text_buffer_set_styled_text(ot_context *, const ot_handle *, const uint8_t *, uint32_t byte_count,
    const ot_scene_linked_text_chunk *, uint32_t chunk_count, const uint8_t *urls, uint32_t url_byte_count);
/* Atomic replacement of buffer-owned styled text. Every buffer appears once and
 * view must be its dependent view. Borrowed SyntaxStyles are not supported.
 * Success resets selection on each named view, retaining defaults and geometry.
 * Failure leaves every buffer, view and output unchanged. Inputs are borrowed
 * only for the call. Output has count entries; NULL spans require zero count.
 * These aggregate limits bound synchronous preparation and temporary storage. */
#define OT_TEXT_REPLACEMENT_COUNT_MAX UINT32_C(256)
#define OT_TEXT_REPLACEMENT_CHUNKS_MAX UINT32_C(4096)
#define OT_TEXT_REPLACEMENT_BYTES_MAX UINT32_C(4194304)
#define OT_TEXT_REPLACEMENT_URL_BYTES_MAX UINT32_C(1048576)
typedef struct ot_text_buffer_replacement {
    uint32_t struct_size;
    uint32_t abi_version;
    ot_handle buffer;
    ot_handle view;
    uint32_t byte_offset;
    uint32_t byte_count;
    uint32_t chunk_offset;
    uint32_t chunk_count;
} ot_text_buffer_replacement;
typedef struct ot_text_buffer_replacement_info {
    uint32_t text_length;
    uint32_t byte_count;
} ot_text_buffer_replacement_info;
ot_status ot_text_buffer_replace_styled_batch(ot_context *, const ot_text_buffer_replacement *, uint32_t count,
    const uint8_t *bytes, uint32_t byte_count, const ot_scene_linked_text_chunk *, uint32_t chunk_count,
    const uint8_t *urls, uint32_t url_byte_count, ot_text_buffer_replacement_info *out);
ot_status ot_text_buffer_set_syntax_style(ot_context *, const ot_handle *, const ot_handle *style);
ot_status ot_text_buffer_get_info(ot_context *, const ot_handle *, ot_text_buffer_info *);
/* Zero capacity reports a byte bound. Nonzero capacity must fit that bound;
 * out_count is the actual copied byte count. Outputs are unchanged on rejection. */
ot_status ot_text_buffer_get_text(ot_context *, const ot_handle *, uint8_t *, uint32_t capacity, uint32_t *out_count);
ot_status ot_text_buffer_get_range(ot_context *, const ot_handle *, uint32_t start, uint32_t end,
    uint8_t *, uint32_t capacity, uint32_t *out_count);
ot_status ot_text_buffer_set_defaults(ot_context *, const ot_handle *, uint32_t mask, const ot_editor_style *);
ot_status ot_text_buffer_set_tab_width(ot_context *, const ot_handle *, uint32_t width);
ot_status ot_text_buffer_highlight(ot_context *, const ot_handle *, uint32_t operation,
    uint32_t argument, const ot_edit_highlight *);
ot_status ot_text_buffer_get_highlights(ot_context *, const ot_handle *, uint32_t line,
    ot_edit_highlight *, uint32_t capacity, uint32_t *out_count);
ot_status ot_text_buffer_view_set_viewport(ot_context *, const ot_handle *, const ot_editor_viewport *, uint32_t size_only);
ot_status ot_text_buffer_view_command(ot_context *, const ot_handle *, uint32_t command, uint32_t argument);
ot_status ot_text_buffer_view_set_tab_color(ot_context *, const ot_handle *, const uint16_t color[4]);
ot_status ot_text_buffer_view_select(ot_context *, const ot_handle *, const ot_editor_selection *, uint32_t *out_changed);
ot_status ot_text_buffer_view_get_info(ot_context *, const ot_handle *, ot_editor_view_info *);
ot_status ot_text_buffer_view_get_selected_text(ot_context *, const ot_handle *, uint8_t *, uint32_t capacity, uint32_t *out_count);
ot_status ot_text_buffer_view_get_lines(ot_context *, const ot_handle *, uint32_t logical,
    ot_scene_text_line *, uint32_t capacity, ot_editor_measure *);
ot_status ot_text_buffer_view_measure(ot_context *, const ot_handle *, uint32_t width, uint32_t height, ot_editor_measure *);
ot_status ot_scene_set_text_view(ot_context *, const ot_handle *node, const ot_handle *view);
/* Only gates built-in painting, not layout, viewport preparation or hit membership. */
ot_status ot_scene_set_text_view_paint(ot_context *, const ot_handle *node, uint32_t enabled);
/* Select native text drawing for the exact active self request, independently
 * of the persistent paint gate. Reuses the existing frame request record. */
ot_status ot_scene_select_text_view_paint(ot_context *, const ot_handle *node,
    const ot_scene_frame_request *, uint32_t enabled);
/* NULL frame selects an owned offscreen buffer. A frame requires the exact active
 * custom paint destination. The source view must belong to this Context. */
ot_status ot_buffer_draw_text_view(ot_context *, const ot_handle *target, const ot_scene_frame_request *,
    const ot_handle *view, int32_t x, int32_t y);
/* Same destination rules as ot_buffer_draw_text_view. Paints synchronously with
 * the destination's current clipping and opacity, without publishing cursor state.
 * The scene-text source is a native Text node, not an independent text-view handle. */
ot_status ot_buffer_draw_editor_view(ot_context *, const ot_handle *target, const ot_scene_frame_request *,
    const ot_handle *view, int32_t x, int32_t y);
ot_status ot_buffer_draw_scene_text(ot_context *, const ot_handle *target, const ot_scene_frame_request *,
    const ot_handle *node, int32_t x, int32_t y);

#define OT_BUFFER_TEXT_BYTES_MAX UINT32_C(65536)
#define OT_BUFFER_TEXT_HAS_BACKGROUND UINT32_C(1)

/* Draw one plain UTF-8 row at unsigned cell coordinates, clipped to the buffer.
 * Colors use packed RGBA with canonical RGB, indexed, or terminal-default intent.
 * flags is zero or OT_BUFFER_TEXT_HAS_BACKGROUND. Without that flag, background
 * must be all zero; drawing uses the background at each glyph or tab start.
 * attributes accepts bits 0..7: bold, dim, italic, underline, blink, inverse,
 * hidden, and strikethrough. Packed resource IDs and other bits are invalid. */
typedef struct ot_buffer_text_options {
    uint32_t struct_size;
    uint32_t abi_version;
    uint32_t x;
    uint32_t y;
    uint16_t foreground[4];
    uint16_t background[4];
    uint32_t attributes;
    uint32_t flags;
} ot_buffer_text_options;

#define OT_BUFFER_DRAW_CLEAR UINT32_C(0)
#define OT_BUFFER_DRAW_FILL UINT32_C(1)
#define OT_BUFFER_DRAW_TEXT UINT32_C(2)
#define OT_BUFFER_DRAW_CELL UINT32_C(3)
#define OT_BUFFER_DRAW_CELL_BLEND UINT32_C(4)
#define OT_BUFFER_DRAW_CHAR UINT32_C(5)
#define OT_BUFFER_DRAW_BOX UINT32_C(6)
#define OT_BUFFER_DRAW_COMPOSE UINT32_C(7)
#define OT_BUFFER_DRAW_RESPECT_ALPHA UINT32_C(8)
#define OT_BUFFER_DRAW_HAS_BACKGROUND UINT32_C(1)
#define OT_BUFFER_DRAW_HAS_SOURCE_WIDTH UINT32_C(2)
#define OT_BUFFER_DRAW_HAS_SOURCE_HEIGHT UINT32_C(4)

#define OT_BUFFER_STACK_DEPTH_MAX UINT32_C(256)
#define OT_BUFFER_STACK_GET_OPACITY UINT32_C(0)
#define OT_BUFFER_STACK_PUSH_SCISSOR UINT32_C(1)
#define OT_BUFFER_STACK_POP_SCISSOR UINT32_C(2)
#define OT_BUFFER_STACK_CLEAR_SCISSORS UINT32_C(3)
#define OT_BUFFER_STACK_PUSH_OPACITY UINT32_C(4)
#define OT_BUFFER_STACK_POP_OPACITY UINT32_C(5)
#define OT_BUFFER_STACK_CLEAR_OPACITY UINT32_C(6)

typedef struct ot_buffer_draw_options {
    uint32_t struct_size;
    uint32_t abi_version;
    uint32_t operation;
    uint32_t flags;
    int32_t x;
    int32_t y;
    uint32_t width;
    uint32_t height;
    uint32_t character;
    uint32_t attributes;
    uint32_t packed_options;
    uint32_t reserved;
    uint16_t foreground[4];
    uint16_t background[4];
    uint16_t title_color[4];
    uint32_t border_chars[11];
    uint32_t source_x;
    uint32_t source_y;
    uint32_t source_width;
    uint32_t source_height;
    uint32_t reserved2;
} ot_buffer_draw_options;

#define OT_BUFFER_GRID_INNER UINT32_C(1)
#define OT_BUFFER_GRID_OUTER UINT32_C(2)

typedef struct ot_buffer_grid_options {
    uint32_t struct_size;
    uint32_t abi_version;
    uint32_t flags;
    uint32_t reserved;
    uint16_t foreground[4];
    uint16_t background[4];
    uint32_t border_chars[11];
} ot_buffer_grid_options;

/* Initialize struct_size, abi_version, and zero reserved before acquisition.
 * All other fields are output-only. The record has an exact 80-byte layout on
 * supported 64-bit targets. Addresses are native-endian uint64_t values; convert
 * through uintptr_t, for example (uint32_t *)(uintptr_t)record.char_ptr.
 * char_ptr and attributes_ptr each address width * height uint32_t elements.
 * fg_ptr and bg_ptr each address width * height * 4 uint16_t RGBA components.
 * Literal RGBA channels use 0..255; high bytes carry native color metadata.
 * This retains storage, not a frozen frame. Rendering can change cells without
 * changing generation. CURRENT is the encoder's comparison buffer, which can
 * change before output admission or presentation; it is not a last-presented
 * snapshot. NEXT is drawing storage and rendering clears it after encoding.
 * Raw planes must not add, replace, or remove pooled grapheme/link IDs. Use
 * ot_buffer_draw_text for checked plain UTF-8 on an owned offscreen buffer.
 * Styled-text/editor resources, hyperlinks, and images need separate checked APIs. */
typedef struct ot_buffer_lease_snapshot {
    uint32_t struct_size;
    uint32_t abi_version;
    ot_handle lease;
    uint32_t width;
    uint32_t height;
    uint64_t generation;
    uint64_t char_ptr;
    uint64_t fg_ptr;
    uint64_t bg_ptr;
    uint64_t attributes_ptr;
    uint64_t reserved;
} ot_buffer_lease_snapshot;

/* Acquire local frame access for the exact pending RENDER_BEFORE, RENDER_SELF,
 * RENDER_AFTER, or retained DONE record. which is
 * OT_SESSION_BUFFER_CURRENT or NEXT. Both require this qualified operation while
 * a draft is live; ordinary Session draw, render, and borrowing cannot bypass it.
 * The frame and snapshot require exact size/version and zero reserved fields.
 * Rejection leaves out_snapshot unchanged and acquires no lease. Native code
 * validates frame membership, destination, and storage identity; copied or forged
 * record fields do not replace that validation. Existing lease limits, raw-plane
 * restrictions, validation, capture, and release operations apply.
 * Release all qualified scopes before resume, commit, or a new frame, including stale ones.
 * An accepted size-changing resize replaces and requalifies draft storage natively
 * without repainting. Old scopes return OT_STALE_LEASE; later acquisitions use the
 * new size with the same request record. Setup before the first accepted frame and
 * suspend retain existing scopes, but new acquisitions and commit return
 * OT_INVALID_PHASE outside a rendering phase. */
ot_status ot_scene_frame_acquire_buffer_lease(ot_context *, const ot_handle *session,
    const ot_scene_frame_request *frame_request, uint32_t which, ot_buffer_lease_snapshot *out_snapshot);

/* Submit the exact retained DONE record through ordered Session output. force is
 * 0 or 1; out_status uses OT_RENDER_* and the existing Session output admission
 * and publication rules. Only output completion publishes frame_count and pending
 * hits. No qualified scope may remain, or commit returns OT_FRAME_BUSY. The frame
 * requires exact size/version and zero reserved fields. Rejection leaves out_status
 * unchanged. A consumed, cancelled, foreign, or altered frame cannot submit again. */
ot_status ot_scene_frame_commit(ot_context *, const ot_handle *session,
    const ot_scene_frame_request *frame_request, uint32_t force, uint32_t *out_status);

#define OT_SESSION_CONTROL_PACKET_BYTES UINT32_C(4096)
#define OT_TERMINAL_ALTERNATE_SCREEN UINT32_C(1)
#define OT_TERMINAL_MOUSE UINT32_C(2)
#define OT_TERMINAL_MOUSE_MOVEMENT UINT32_C(4)
#define OT_TERMINAL_CLEAR_ON_CLOSE UINT32_C(8)

/* flags is a combination of the four OT_TERMINAL_* option bits above. Other bits
 * must be zero. kitty_keyboard_flags accepts bits 0 through 4, or zero to disable
 * Kitty keyboard. clear-on-close also controls surface clearing on suspend. */
typedef struct ot_session_terminal_options {
    uint32_t struct_size;
    uint32_t abi_version;
    uint32_t flags;
    uint32_t kitty_keyboard_flags;
} ot_session_terminal_options;

#define OT_CONTROL_CAPABILITY_RESPONSE UINT32_C(1)
#define OT_CONTROL_TITLE UINT32_C(2)
#define OT_CONTROL_MOUSE UINT32_C(3)
#define OT_CONTROL_KITTY_KEYBOARD_FLAGS UINT32_C(4)
#define OT_CONTROL_RESTORE_MODES UINT32_C(5)
#define OT_CONTROL_QUERY_PIXEL_RESOLUTION UINT32_C(6)
#define OT_CONTROL_QUERY_THEME_COLORS UINT32_C(7)
#define OT_CONTROL_CURSOR UINT32_C(8)
#define OT_CONTROL_RESET_BACKGROUND UINT32_C(9)
#define OT_CONTROL_PALETTE_QUERY UINT32_C(10)

/* argument is 0/1/2 (disabled/drag/motion) for MOUSE, 0..31 for Kitty flags,
 * and zero otherwise. CAPABILITY_RESPONSE, TITLE, CURSOR, and PALETTE_QUERY accept payload bytes.
 * reserved must be zero. */
typedef struct ot_session_control_options {
    uint32_t struct_size;
    uint32_t abi_version;
    uint32_t kind;
    uint32_t argument;
    uint32_t reserved;
} ot_session_control_options;

#define OT_CURSOR_POSITION UINT32_C(1)
#define OT_CURSOR_STYLE UINT32_C(2)
#define OT_CURSOR_BLINKING UINT32_C(4)
#define OT_CURSOR_COLOR UINT32_C(8)
#define OT_CURSOR_MOUSE_POINTER UINT32_C(16)

/* CURSOR payload is exactly one copied ot_session_cursor_update, with native
 * byte order and no alignment requirement. fields selects updated properties;
 * other bits must be zero. x/y clamp to 1 and must not exceed 65536. visible and
 * blinking are 0/1. style is 0=block, 1=line, 2=underline, 3=default. mouse_pointer
 * is 0=default, 1=pointer, 2=text, 3=crosshair, 4=move, 5=not-allowed. Color uses
 * the packed RGBA lanes. Unselected fields must be zero. */
typedef struct ot_session_cursor_update {
    uint32_t fields;
    int32_t x;
    int32_t y;
    uint8_t visible;
    uint8_t style;
    uint8_t blinking;
    uint8_t mouse_pointer;
    uint16_t color[4];
} ot_session_cursor_update;

#define OT_CAP_KITTY_KEYBOARD UINT32_C(1)
#define OT_CAP_KITTY_GRAPHICS UINT32_C(2)
#define OT_CAP_RGB UINT32_C(4)
#define OT_CAP_ANSI256 UINT32_C(8)
#define OT_CAP_SGR_PIXELS UINT32_C(16)
#define OT_CAP_COLOR_SCHEME_UPDATES UINT32_C(32)
#define OT_CAP_EXPLICIT_WIDTH UINT32_C(64)
#define OT_CAP_SCALED_TEXT UINT32_C(128)
#define OT_CAP_SIXEL UINT32_C(256)
#define OT_CAP_FOCUS_TRACKING UINT32_C(512)
#define OT_CAP_SYNC UINT32_C(1024)
#define OT_CAP_BRACKETED_PASTE UINT32_C(2048)
#define OT_CAP_HYPERLINKS UINT32_C(4096)
#define OT_CAP_OSC52 UINT32_C(8192)
#define OT_CAP_NOTIFICATIONS UINT32_C(16384)
#define OT_CAP_EXPLICIT_CURSOR_POSITIONING UINT32_C(32768)
#define OT_CAP_REMOTE UINT32_C(65536)

/* Initialize struct_size and abi_version. All other fields are copied output.
 * width_method is 0=wcwidth, 1=unicode, 2=no_zwj, 3=unicode_wide.
 * multiplexer is 0=none, 1=tmux, 2=zellij, 3=screen, 4=unknown.
 * image_protocol is 0=auto, 1=kitty, 2=sixel, 3=blocks.
 * osc52_support is 0=unknown, 1=supported, 2=unsupported.
 * kitty_keyboard_flags is accepted intent, not confirmation of enabled modes.
 * String lengths count bytes, not NUL terminators. Unused bytes and reserved
 * are zero. No native memory is borrowed; failure leaves the record unchanged. */
typedef struct ot_session_capabilities {
    uint32_t struct_size;
    uint32_t abi_version;
    uint32_t flags;
    uint32_t width_method;
    uint32_t multiplexer;
    uint32_t image_protocol;
    uint32_t osc52_support;
    uint32_t kitty_keyboard_flags;
    uint32_t term_name_len;
    uint32_t term_version_len;
    uint32_t term_from_xtversion;
    uint32_t reserved;
    uint8_t term_name[64];
    uint8_t term_version[32];
} ot_session_capabilities;

#define OT_TERMINAL_UNINITIALIZED UINT32_C(0)
#define OT_TERMINAL_SETTING_UP UINT32_C(1)
#define OT_TERMINAL_ACTIVE UINT32_C(2)
#define OT_TERMINAL_SUSPENDING UINT32_C(3)
#define OT_TERMINAL_SUSPENDED UINT32_C(4)
#define OT_TERMINAL_RESUMING UINT32_C(5)
#define OT_TERMINAL_CLOSING UINT32_C(6)
#define OT_TERMINAL_RESTORED UINT32_C(7)
#define OT_TERMINAL_FAILED UINT32_C(8)
#define OT_TERMINAL_CANCELLED UINT32_C(9)

#define OT_PUMP_IDLE UINT32_C(0)
#define OT_PUMP_AGAIN UINT32_C(1)
#define OT_PUMP_OUTPUT_PENDING UINT32_C(2)
#define OT_PUMP_WAIT_UNTIL UINT32_C(3)
#define OT_PUMP_CLOSED UINT32_C(4)

/* Initialize struct_size and abi_version. status, reserved, and deadline_ns are
 * output-only. deadline_ns is nonzero only for OT_PUMP_WAIT_UNTIL. No memory is
 * borrowed. A rejected call leaves the entire output record unchanged. */
typedef struct ot_session_pump_result {
    uint32_t struct_size;
    uint32_t abi_version;
    uint32_t status;
    uint32_t reserved;
    uint64_t deadline_ns;
} ot_session_pump_result;

/* Zero-initialize, then set struct_size to sizeof(ot_context_options) and
 * abi_version to OT_CONTEXT_ABI_VERSION. Version 1 requires the exact size,
 * zero flags, zero reserved fields, and positive resource limits.
 * object_capacity counts native object slots, not bytes. render_cells_max
 * bounds each renderer's width * height in terminal cells, not bytes or total
 * context memory. Neither limit uses a default when zero.
 * Allocator and I/O injection are available only through the direct Zig API. */
typedef struct ot_context_options {
    uint32_t struct_size;
    uint32_t abi_version;
    uint32_t flags;
    uint32_t object_capacity;
    uint32_t render_cells_max;
    uint32_t reserved[3];
} ot_context_options;

/* Initialize struct_size and abi_version before querying. The library writes
 * status and clears reserved on success. This record contains no borrowed
 * memory and remains valid after context destruction. */
typedef struct ot_context_error {
    uint32_t struct_size;
    uint32_t abi_version;
    ot_status status;
    uint32_t reserved;
} ot_context_error;

#define OT_DIAGNOSTIC_MESSAGE_BYTES UINT32_C(4096)
#define OT_DIAGNOSTIC_TRUNCATED UINT32_C(1)

/* Copied diagnostic record. level is 0 (error), 1 (warning), 2 (info), or
 * 3 (debug). message_len counts bytes, not a terminating NUL. Unused message
 * bytes and reserved are zero. Truncation can split a UTF-8 sequence. */
typedef struct ot_diagnostic {
    uint32_t level;
    uint32_t message_len;
    uint32_t flags;
    uint32_t reserved;
    uint8_t message[OT_DIAGNOSTIC_MESSAGE_BYTES];
} ot_diagnostic;

/* Initialize struct_size and abi_version before each drain. dropped is a
 * saturating lifetime total. Draining does not reset it. */
typedef struct ot_diagnostic_drain {
    uint32_t struct_size;
    uint32_t abi_version;
    uint32_t count;
    uint32_t remaining;
    uint64_t dropped;
} ot_diagnostic_drain;

uint32_t ot_context_abi_version(void);

/* Create a context without setting up a terminal or starting worker threads.
 * Both pointers must be non-NULL and correctly aligned. Options are borrowed
 * only for this call. The function checks options before native allocation
 * and sets *out_context to NULL on every failure when out_context is non-NULL.
 * Creation failures have no context-local error record; use the return status.
 * OT_OUT_OF_MEMORY includes Yoga configuration allocation failure. Yoga C++
 * allocations use separate failure-injection tests, not Zig allocators.
 * Destroy a successful result with ot_context_destroy, never free(). */
ot_status ot_context_create(const ot_context_options *options, ot_context **out_context);

/* Destroy a live context on its owner thread. NULL returns OT_INVALID_ARGUMENT.
 * OT_WRONG_THREAD leaves the context alive and does not change its error.
 * An active operation, teardown, or unreleased checked storage lease returns and
 * records OT_CONTEXT_BUSY without releasing the context or its I/O storage. */
ot_status ot_context_destroy(ot_context *context);

/* Copy this context's most recent owner-thread error, initially OT_OK.
 * Successful queries do not clear it. Invalid query arguments update it.
 * The output requires the exact version-1 size and version; its status and
 * reserved fields are output-only. On failure, the output remains unchanged.
 * NULL contexts and wrong-thread calls return a status without changing any
 * context-local state. The caller owns the output for the entire call. */
ot_status ot_context_get_last_error(ot_context *context, ot_context_error *out_error);

/* Copy up to capacity records in arrival order without allocation or callbacks.
 * Version 1 C contexts hold at most 64 records and drop newest on overflow.
 * records may be NULL only when capacity is zero. A zero-capacity drain reports
 * queue pressure without removing records. out_drain must have the exact size
 * and version. The caller owns both outputs for the call. Outputs and queued
 * records remain unchanged on failure. Active operations return OT_CONTEXT_BUSY.
 * Copied records remain valid after context destruction. */
ot_status ot_context_drain_diagnostics(
    ot_context *context,
    ot_diagnostic *records,
    uint32_t capacity,
    ot_diagnostic_drain *out_drain);

/* Copy a live interned hyperlink URL. Zero capacity reports the byte count.
 * Nonzero capacity must fit that count; out_count is the copied byte count.
 * bytes may be NULL only when capacity is zero. URLs are at most 512 bytes.
 * Unknown or retired IDs return OT_INVALID_ARGUMENT. Outputs are unchanged on
 * rejection. Owner-thread and busy-operation rules apply. */
ot_status ot_context_get_link_url(ot_context *context, uint32_t link_id,
    uint8_t *bytes, uint32_t capacity, uint32_t *out_count);

/* Options require the exact size and version. Failure leaves out_buffer unchanged.
 * The Context owns the buffer and its pools; legacy buffer handles are not accepted.
 * These functions obey the Context owner-thread and busy-operation rules. */
ot_status ot_buffer_create(
    ot_context *context,
    const ot_buffer_options *options,
    ot_handle *out_buffer);
ot_status ot_buffer_destroy(ot_context *context, const ot_handle *buffer);

/* Rejected resize preserves dimensions and cells. Size-changing resize or
 * destruction retires leased storage, which stays allocated until release. */
ot_status ot_buffer_resize(
    ot_context *context,
    const ot_handle *buffer,
    uint32_t width,
    uint32_t height);

/* Clear to spaces, zero attributes, white foreground, and this packed RGBA
 * background with canonical RGB, indexed, or terminal-default intent. Failure preserves
 * cells. Existing leases stay current; clear does not replace storage. */
ot_status ot_buffer_clear(
    ot_context *context,
    const ot_handle *buffer,
    const uint16_t background[4]);

/* Fill a clipped cell rectangle using packed RGBA with canonical color intent. Zero-sized
 * or offscreen rectangles are no-ops. Existing storage leases remain current. */
ot_status ot_buffer_fill_rect(ot_context *context, const ot_handle *buffer,
    uint32_t x, uint32_t y, uint32_t width, uint32_t height, const uint16_t background[4]);

/* Draw at most OT_BUFFER_TEXT_BYTES_MAX bytes without borrowing them after return.
 * Options require the exact size/version. bytes may be NULL only for zero length.
 * Byte-limit violations, invalid UTF-8, C0/C1/DEL controls except tab, and rendered
 * graphemes over the native 128-byte limit return OT_INVALID_ARGUMENT.
 * Tabs occupy two cells.
 * Image-bearing targets return OT_UNSUPPORTED_RESOURCE. Rejection preserves
 * cells and output, though prepared capacity may remain. No output is emitted;
 * use ot_session_draw_buffer to copy into a Session before rendering. */
ot_status ot_buffer_draw_text(
    ot_context *context,
    const ot_handle *buffer,
    const ot_buffer_text_options *options,
    const uint8_t *bytes,
    uint32_t byte_count);

/* Draw into an owned buffer, or a Session's next buffer with the exact active
 * prefix/painted ticket. source is a same-Context buffer for COMPOSE only.
 * Text/title byte counts are bounded by OT_BUFFER_TEXT_BYTES_MAX. Raw resource
 * IDs are rejected. Any Box title drawing failure may partially modify the
 * destination; callers must cancel the frame or discard the offscreen draft.
 * No native framebuffer pointer is accepted. */
ot_status ot_buffer_draw(ot_context *context, const ot_handle *target,
    const ot_scene_frame_request *frame, const ot_buffer_draw_options *options,
    const ot_handle *source, const uint8_t *text, uint32_t text_len,
    const uint8_t *bottom_title, uint32_t bottom_title_len);

/* Checked drawing stacks use the same target/frame authority as ot_buffer_draw.
 * Pushes intersect clips or multiply opacity using the native buffer rules.
 * At most OT_BUFFER_STACK_DEPTH_MAX custom entries per stack are permitted;
 * exceeding this limit returns OT_OBJECT_LIMIT without changing either stack.
 * Clip sizes and signed endpoints must fit int32_t; empty clips are valid.
 * Opacity must be finite and is clamped to [0, 1]. Pass it as a one-float
 * buffer so host FFI can keep the portable integer/buffer calling convention.
 * Only PUSH operations use their corresponding rectangle/opacity arguments.
 * Pop on an empty custom stack is a no-op. Pop/clear cannot remove inherited
 * scene clip or opacity. Custom frame stacks reset on callback acknowledgement
 * or frame cancellation; owned buffer stacks persist until explicitly
 * popped/cleared or destroyed. out_opacity is required and receives the
 * effective opacity on success only. */
ot_status ot_buffer_stack(ot_context *context, const ot_handle *target,
    const ot_scene_frame_request *frame, uint32_t operation,
    int32_t x, int32_t y, uint32_t width, uint32_t height,
    const float *opacity, float *out_opacity);

/* Draw a grid with the same target/frame authority as ot_buffer_draw. Counts are
 * offset-array lengths, not cell counts. Arrays must be strictly increasing,
 * with at most render_cells_max + 1 entries each; fewer than two is a no-op.
 * NULL arrays require zero length. Glyphs must be single-cell Unicode scalars
 * or zero. Colors use packed RGBA with canonical color intent. Input is borrowed only for this
 * call. Invalid input preserves the destination. Image-bearing targets reject. */
ot_status ot_buffer_draw_grid(ot_context *context, const ot_handle *target,
    const ot_scene_frame_request *frame, const ot_buffer_grid_options *options,
    const int32_t *columns, uint32_t column_count,
    const int32_t *rows, uint32_t row_count);

/* Pixel drawing uses the same target/frame authority as ot_buffer_draw. Input
 * spans are borrowed for this call only and must not overlap destination planes.
 * NULL input requires zero length. Images reject; clipping, opacity, and pooled
 * cell replacement use the native buffer rules. Rejection preserves cells.
 * Packed cells are 48 native-endian bytes: bg[4] f32, fg[4] f32, character u32,
 * and 12 padding bytes. Input may be unaligned and must contain complete cells,
 * at least width * height. Visible color samples must be finite; finite channels
 * are clamped to 0..1. Invalid/non-cell characters use the existing block fallback.
 * Supersampling uses format 0=BGRA, 1=RGBA, and a nonzero stride divisible by 4.
 * Input must contain whole rows. Row padding is input; destination width clips it.
 * Missing neighbors at odd source edges are transparent.
 * Grayscale sample_count counts floats, not bytes; width * height must fit u32
 * and the supplied span. Visible samples must be finite. supersampled is 0 or 1;
 * 2x grayscale ignores an incomplete final sample row/column. Optional colors
 * contain packed RGBA with canonical color intent. Preflight work is destination-bounded. */
ot_status ot_buffer_draw_packed(ot_context *, const ot_handle *, const ot_scene_frame_request *,
    const uint8_t *data, uint32_t byte_count, uint32_t x, uint32_t y, uint32_t width, uint32_t height);
ot_status ot_buffer_draw_supersample(ot_context *, const ot_handle *, const ot_scene_frame_request *,
    const uint8_t *data, uint32_t byte_count, uint32_t x, uint32_t y, uint32_t format, uint32_t stride);
ot_status ot_buffer_draw_grayscale(ot_context *, const ot_handle *, const ot_scene_frame_request *,
    const float *data, uint32_t sample_count, int32_t x, int32_t y, uint32_t width, uint32_t height,
    const uint16_t *foreground, const uint16_t *background, uint32_t supersampled);

/* Color matrices borrow 16 floats and optional (x, y, weight) triples for this
 * call. NULL mask selects uniform application and requires zero mask_count;
 * a non-NULL empty mask selects no cells. Counts are floats, not bytes; incomplete
 * triples are ignored. Matrix/global strength must be finite. channel is 1=FG,
 * 2=BG, 3=both. Mask triples are bounded by render_cells_max; invalid coordinates
 * and non-finite effective cell strengths are skipped. Effects retain whole-buffer
 * semantics without applying scissor/opacity again. Target/frame authority is the
 * same as ot_buffer_draw, including no-ops. Inputs are not retained. */
ot_status ot_buffer_color_matrix(ot_context *, const ot_handle *, const ot_scene_frame_request *,
    const float *matrix, uint32_t matrix_count, const float *mask, uint32_t mask_count,
    const float *strength, uint32_t channel);

/* Retain one offscreen storage generation under the same limits and raw-plane
 * restrictions as Session leases. The snapshot requires exact size/version and
 * zero reserved. Rejection leaves it unchanged and acquires no lease. */
ot_status ot_buffer_acquire_lease(
    ot_context *context,
    const ot_handle *buffer,
    ot_buffer_lease_snapshot *out_snapshot);

/* Create only the transport. No renderer, terminal modes, or worker starts.
 * Options require the exact size and OT_CONTEXT_ABI_VERSION. A failed call leaves
 * out_session unchanged. All session functions obey the context thread rule. */
ot_status ot_session_create(
    ot_context *context,
    const ot_session_options *options,
    ot_handle *out_session);

/* Attach once. A rejected call preserves the Session and its queued output.
 * The renderer uses its Context's pools and cannot consume legacy FFI handles. */
ot_status ot_session_attach_renderer(
    ot_context *context,
    const ot_handle *session,
    const ot_session_renderer_options *options);
ot_status ot_session_attach_renderer_with_env(
    ot_context *context,
    const ot_handle *session,
    const ot_session_renderer_env_options *options,
    const uint8_t *environment);

/* Submit at most one frame. force is 0 or 1. OT_RENDER_PENDING also means that
 * an earlier accepted frame is still pending; no second frame was accepted.
 * SKIPPED and FAILED accept no output and require an explicit new submission.
 * Only output completion publishes frame_count and the pending hit grid.
 * A live scene preparation or painted draft returns OT_FRAME_BUSY; submit a
 * painted draft with ot_scene_frame_commit instead.
 * On an error return, out_result remains unchanged. */
ot_status ot_session_render(
    ot_context *context,
    const ot_handle *session,
    uint32_t force,
    uint32_t *out_result);

/* Pending output prevents resize. Rejection preserves accepted dimensions.
 * Scene preparation returns OT_FRAME_BUSY. A painted draft allows resize under
 * the storage requalification rules of ot_scene_frame_acquire_buffer_lease. */
ot_status ot_session_resize_renderer(
    ot_context *context,
    const ot_handle *session,
    uint32_t width,
    uint32_t height);

/* Copy the full offscreen source into the Session's next framebuffer, clipped
 * at signed cell coordinates. Both handles must belong to this Context.
 * Pending presentation and non-rendering phases reject drawing. Images in the
 * source or destination return OT_UNSUPPORTED_RESOURCE. Rejection preserves
 * cells and output; success retains no source borrow and emits no output. */
ot_status ot_session_draw_buffer(
    ot_context *context,
    const ot_handle *session,
    const ot_handle *source,
    int32_t x,
    int32_t y);

/* Same resource and coordinate rules as ot_session_draw_buffer, but authorized
 * by a current before/self/after-paint request or painted draft. Preserves the native
 * fixed-membership paint scope, including scissor and opacity. No source borrow
 * survives return; pending presentation and stale tickets reject drawing. */
ot_status ot_scene_frame_draw_buffer(ot_context *context, const ot_handle *session,
    const ot_scene_frame_request *frame_request, const ot_handle *source, int32_t x, int32_t y);

/* Diagnostics require an open Session and attached renderer, not terminal setup
 * or an idle frame. They emit no terminal output. enabled is 0 or 1; corner is
 * 0 top-left, 1 top-right, 2 bottom-left, or 3 bottom-right. Times must be finite
 * and nonnegative. Memory byte counts use the renderer's existing u32 range.
 * Hit-grid dumping retains the renderer's best-effort file I/O semantics and
 * uses Context I/O, writing hitgrid_<timestamp>.txt in the working directory. */
ot_status ot_session_set_debug_overlay(ot_context *, const ot_handle *session, uint32_t enabled, uint32_t corner);
ot_status ot_session_update_stats(ot_context *, const ot_handle *session, double overall_ms, uint32_t fps, double callback_ms);
ot_status ot_session_update_memory_stats(ot_context *, const ot_handle *session, uint32_t heap_used, uint32_t heap_total, uint32_t array_buffers);
ot_status ot_session_dump_hit_grid(ot_context *, const ot_handle *session);

/* The record requires the exact size and version. Failure preserves it. */
ot_status ot_session_get_renderer_state(
    ot_context *context,
    const ot_handle *session,
    ot_session_renderer_state *out_state);

/* Retain one Session-owned framebuffer storage generation without creating a
 * renderer or buffer owner. which is OT_SESSION_BUFFER_CURRENT or NEXT.
 * Acquisition requires a rendering phase and no pending presentation. Finish
 * drawing before submitting a frame; an ordinary storage lease does not block
 * rendering. A live scene preparation or painted draft returns OT_FRAME_BUSY;
 * use ot_scene_frame_acquire_buffer_lease for painted-frame access.
 * The output requires the exact size/version and zero reserved. Rejection leaves
 * it unchanged and acquires no lease. Leases share object_capacity; C contexts
 * allow at most 4096 leases and 64 MiB of distinct leased storage, including
 * retired arrays and tracker capacity. Shared Context pools are not in that charge.
 * Release every accepted lease, even after Session resize or destruction. */
ot_status ot_session_acquire_buffer_lease(
    ot_context *context,
    const ot_handle *session,
    uint32_t which,
    ot_buffer_lease_snapshot *out_snapshot);

/* Ordinary leases check storage lifetime, not contents or Session phase. Qualified
 * leases also check retained painted-frame membership, destination, and storage
 * identity. Buffer replacement, destruction, or frame cancellation makes affected
 * leases return OT_STALE_LEASE. Arrays remain allocated until release, but stale
 * qualified access is revoked.
 * Duplicate release or a reused lease slot returns OT_STALE_HANDLE. All calls obey the Context
 * owner-thread rule. Keep the Context and native image alive until release.
 * Copies of the record do not retain storage. Release cannot revoke saved raw
 * addresses: callers must not use them after release. */
ot_status ot_buffer_lease_validate(ot_context *context, const ot_handle *lease);
ot_status ot_buffer_lease_release(ot_context *context, const ot_handle *lease);

/* Resolve text through the leased storage's own grapheme pool. Keep one lease
 * across sizing and writing. add_line_breaks is 0 or 1. An undersized output
 * returns OT_INVALID_ARGUMENT and may contain a partial prefix; out_written
 * remains unchanged on error. Stale or released leases reject both operations.
 * Optional cell_lengths receives one UTF-8 byte length per cell, excluding row
 * separators. Continuations have length zero. Set it to NULL with cell_capacity
 * zero when lengths are not needed; otherwise reserve at least width * height. */
ot_status ot_buffer_lease_get_real_char_size(
    ot_context *context, const ot_handle *lease,
    uint32_t add_line_breaks, uint32_t *out_size);
ot_status ot_buffer_lease_write_resolved_chars(
    ot_context *context, const ot_handle *lease,
    uint8_t *bytes, uint32_t capacity,
    uint32_t add_line_breaks, uint8_t *cell_lengths, uint32_t cell_capacity,
    uint32_t *out_written);

/* Accept a terminal lifecycle request; pump performs output and timed work.
 * Setup requires an attached renderer and sufficient reserved control storage,
 * and must precede the first accepted frame. Earlier raw output is allowed.
 * It does not wait for capability replies. Ordinary writes and rendering are
 * rejected during transitions. Suspended sessions allow raw writes and null-frame
 * split snapshots, not ordinary frames.
 * Resume reuses the accepted setup options without repeating detection. */
ot_status ot_session_setup_terminal(
    ot_context *context,
    const ot_handle *session,
    const ot_session_terminal_options *options);
ot_status ot_session_suspend(ot_context *context, const ot_handle *session);
ot_status ot_session_resume(ot_context *context, const ot_handle *session);
ot_status ot_session_get_terminal_state(ot_context *context, const ot_handle *session, uint32_t *out_phase);

/* Accept capability replies during setup after pump publishes the initial query
 * packet, even before output completion. Also accept replies during resume.
 * CURSOR updates synchronous intent in any open phase; only a subsequent accepted
 * frame emits it. Other controls require an active terminal. Capability payloads
 * contain complete supported 7-bit CSI/DCS/OSC/APC replies, not stream fragments,
 * at most 4096 bytes.
 * Titles are UTF-8 without C0, DEL, or C1 controls, at most 4091 bytes.
 * All output uses ordinary capacity and stays behind earlier raw/frame bytes,
 * including copied tickets. Setup enables detected features after screen selection.
 * Admission failure changes neither terminal state nor accepted output.
 * Zero Kitty flags disable; other flags apply when support is detected. Mouse
 * and Kitty intent survive suspend/resume. bytes may be NULL only for zero length. */
ot_status ot_session_control(
    ot_context *context,
    const ot_handle *session,
    const ot_session_control_options *options,
    const uint8_t *bytes,
    uint32_t byte_count);
ot_status ot_session_get_capabilities(
    ot_context *context,
    const ot_handle *session,
    ot_session_capabilities *out_capabilities);

/* Write or clear terminal clipboard selection 0..3 (clipboard/primary/select/secondary).
 * Empty bytes clear the selection. Requires an active terminal. Uses ordinary output
 * capacity behind earlier raw/frame bytes. Unsupported capability or rejected output
 * returns out_written=0 without accepting bytes. Payloads retain the terminal's u32 byte limit.
 * bytes may be NULL only for zero length; all input is consumed during this call. */
ot_status ot_session_clipboard(
    ot_context *context,
    const ot_handle *session,
    uint32_t target,
    const uint8_t *bytes,
    uint32_t byte_count,
    uint32_t *out_written);

/* Palette queries are bounded, validated OSC query packets admitted through
 * ot_session_control. Palette publication copies up to 256 literal RGBA colors;
 * every channel must be 0..255. All operations require an active terminal. */
ot_status ot_session_set_palette_state(ot_context *, const ot_handle *,
    const uint16_t *palette, uint32_t color_count, const uint16_t *foreground,
    const uint16_t *background, uint32_t epoch);

/* Notifications reuse terminal protocol selection and ordinary output capacity.
 * Unsupported capability or rejected output returns out_written=0. Message and
 * optional title are consumed only during this call; NULL requires zero length. */
ot_status ot_session_notification(ot_context *, const ot_handle *,
    const uint8_t *message, uint32_t message_len, const uint8_t *title,
    uint32_t title_len, uint32_t *out_written);

/* Run bounded owner-thread work without waiting, sleeping, or sampling a clock.
 * now_ns must be monotonic across accepted pumps. work_budget must be positive;
 * one unit visits one image entry, emits at most OT_SESSION_CONTROL_PACKET_BYTES,
 * or advances one lifecycle step. AGAIN needs another turn, OUTPUT_PENDING needs
 * output completion, and WAIT_UNTIL needs a clock turn at deadline_ns. Cursor
 * delays start at the first pump observing completed restoration output.
 * The first wait requires time range for both cursor waits. Later retry times
 * must leave room for the final wait. Exhausted clock range returns
 * OT_INVALID_ARGUMENT; a host with no valid later time must cancel explicitly.
 * No second frame is accepted or implicitly retried by this operation. */
ot_status ot_session_pump(
    ot_context *context,
    const ot_handle *session,
    uint64_t now_ns,
    uint32_t work_budget,
    ot_session_pump_result *out_result);

/* Maximum ordinary atomic write in an empty queue, excluding control reservations
 * and bounded by both chunk storage and span slots, at most UINT32_MAX bytes.
 * This is not current free capacity; pending output can still reject a smaller
 * write. Failure leaves out_bytes unchanged. */
ot_status ot_session_get_write_limit(ot_context *context, const ot_handle *session, uint64_t *out_bytes);

/* Copy the complete write or reject it without changing accepted output.
 * bytes may be NULL only when byte_count is zero. Queued and unacknowledged
 * bytes share the finite limits. The caller retains no native memory borrow. */
ot_status ot_session_write(
    ot_context *context,
    const ot_handle *session,
    const uint8_t *bytes,
    uint32_t byte_count);

/* Copy at most capacity bytes in write order. bytes may be NULL only for zero
 * capacity. A successful empty read returns a zero byte_count and request_id.
 * Failure leaves both outputs unchanged. The next read requires completion of
 * the previous ticket. Copied bytes remain valid after cancellation/destruction. */
ot_status ot_session_read_output(
    ot_context *context,
    const ot_handle *session,
    uint8_t *bytes,
    uint32_t capacity,
    ot_output_ticket *out_ticket);

/* success must be 0 or 1. Failure stops the transport without replaying bytes.
 * Wrong-session, stale, altered, and repeated tickets do not consume output. */
ot_status ot_session_complete_output(
    ot_context *context,
    const ot_handle *session,
    const ot_output_ticket *ticket,
    uint32_t success);

/* Stop new writes. Queued output and terminal restoration must finish before
 * the session becomes closed. Terminal-managed sessions require continued pumping.
 * cancel explicitly discards pending output after transport disconnection.
 * Neither operation waits or sleeps. */
ot_status ot_session_close(ot_context *context, const ot_handle *session);
/* Process-exit fallback: stop admission and visit one restoration work unit
 * without cursor-settle waits. Returns OT_PUMP_AGAIN, OT_PUMP_OUTPUT_PENDING, or
 * OT_PUMP_CLOSED. The host must still deliver and complete output in order.
 * Never acknowledges or replays pending copies, and rejects failed transports.
 * Normal asynchronous shutdown must use close and pump instead. */
ot_status ot_session_pump_exit(ot_context *context, const ot_handle *session, uint32_t *out_status);
ot_status ot_session_cancel(ot_context *context, const ot_handle *session);
ot_status ot_session_get_state(ot_context *context, const ot_handle *session, uint32_t *out_state);

/* Pending output or an unrestored terminal prevents destruction unless cancelled.
 * Context destruction follows the same rule. Successful destruction invalidates
 * the session handle and all its tickets, but not caller-owned output copies. */
ot_status ot_session_destroy(ot_context *context, const ot_handle *session);

#ifdef __cplusplus
}
#endif

#endif
