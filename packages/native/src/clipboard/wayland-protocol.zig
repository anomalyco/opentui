const linux = @import("linux.zig");

const WlInterface = linux.WlInterface;
const WlMessage = linux.WlMessage;

pub const Kind = enum { ext, wlr };

const Names = struct {
    manager: [*:0]const u8,
    device: [*:0]const u8,
    source: [*:0]const u8,
    offer: [*:0]const u8,
    version: c_int,
    primary_signature: [*:0]const u8,
};

pub const Metadata = struct {
    types: [10]?*const WlInterface,
    manager_requests: [3]WlMessage,
    device_requests: [3]WlMessage,
    device_events: [4]WlMessage,
    source_requests: [2]WlMessage,
    source_events: [2]WlMessage,
    offer_requests: [2]WlMessage,
    offer_events: [1]WlMessage,
    manager: WlInterface,
    device: WlInterface,
    source: WlInterface,
    offer: WlInterface,

    pub fn init(self: *Metadata, kind: Kind, seat: *const WlInterface) void {
        const names: Names = switch (kind) {
            .ext => .{
                .manager = "ext_data_control_manager_v1",
                .device = "ext_data_control_device_v1",
                .source = "ext_data_control_source_v1",
                .offer = "ext_data_control_offer_v1",
                .version = 1,
                .primary_signature = "?o",
            },
            .wlr => .{
                .manager = "zwlr_data_control_manager_v1",
                .device = "zwlr_data_control_device_v1",
                .source = "zwlr_data_control_source_v1",
                .offer = "zwlr_data_control_offer_v1",
                .version = 2,
                .primary_signature = "2?o",
            },
        };

        self.manager = interface(names.manager, names.version, 3, &self.manager_requests, 0, null);
        self.device = interface(names.device, names.version, 3, &self.device_requests, 4, &self.device_events);
        self.source = interface(names.source, 1, 2, &self.source_requests, 2, &self.source_events);
        self.offer = interface(names.offer, 1, 2, &self.offer_requests, 1, &self.offer_events);
        self.types = .{
            null,
            null,
            &self.source,
            &self.device,
            seat,
            &self.source,
            &self.source,
            &self.offer,
            &self.offer,
            &self.offer,
        };
        self.manager_requests = .{
            message("create_data_source", "n", self.types[2..].ptr),
            message("get_data_device", "no", self.types[3..].ptr),
            message("destroy", "", self.types[0..].ptr),
        };
        self.device_requests = .{
            message("set_selection", "?o", self.types[5..].ptr),
            message("destroy", "", self.types[0..].ptr),
            message("set_primary_selection", names.primary_signature, self.types[6..].ptr),
        };
        self.device_events = .{
            message("data_offer", "n", self.types[7..].ptr),
            message("selection", "?o", self.types[8..].ptr),
            message("finished", "", self.types[0..].ptr),
            message("primary_selection", names.primary_signature, self.types[9..].ptr),
        };
        self.source_requests = .{
            message("offer", "s", self.types[0..].ptr),
            message("destroy", "", self.types[0..].ptr),
        };
        self.source_events = .{
            message("send", "sh", self.types[0..].ptr),
            message("cancelled", "", self.types[0..].ptr),
        };
        self.offer_requests = .{
            message("receive", "sh", self.types[0..].ptr),
            message("destroy", "", self.types[0..].ptr),
        };
        self.offer_events = .{message("offer", "s", self.types[0..].ptr)};
    }
};

fn interface(
    name: [*:0]const u8,
    version: c_int,
    method_count: c_int,
    methods: ?[*]const WlMessage,
    event_count: c_int,
    events: ?[*]const WlMessage,
) WlInterface {
    return .{
        .name = name,
        .version = version,
        .method_count = method_count,
        .methods = methods,
        .event_count = event_count,
        .events = events,
    };
}

fn message(name: [*:0]const u8, signature: [*:0]const u8, types: [*]const ?*const WlInterface) WlMessage {
    return .{ .name = name, .signature = signature, .types = types };
}

test "Wayland data-control metadata preserves protocol names and versions" {
    const std = @import("std");
    const seat = WlInterface{
        .name = "wl_seat",
        .version = 9,
        .method_count = 0,
        .methods = null,
        .event_count = 0,
        .events = null,
    };
    var ext: Metadata = undefined;
    ext.init(.ext, &seat);
    try std.testing.expectEqualStrings("ext_data_control_manager_v1", std.mem.span(ext.manager.name));
    try std.testing.expectEqual(@as(c_int, 1), ext.manager.version);
    try std.testing.expectEqualStrings("?o", std.mem.span(ext.device_requests[2].signature));

    var wlr: Metadata = undefined;
    wlr.init(.wlr, &seat);
    try std.testing.expectEqualStrings("zwlr_data_control_manager_v1", std.mem.span(wlr.manager.name));
    try std.testing.expectEqual(@as(c_int, 2), wlr.manager.version);
    try std.testing.expectEqualStrings("2?o", std.mem.span(wlr.device_requests[2].signature));
}
