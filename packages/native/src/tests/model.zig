//! Shared harness for seeded model tests (markdown-highlight-ssot-models.md, 3.1): generate a
//! command list from a seed, run it against the system and its oracle, and on a failure shrink
//! the list (drop chunks of n/2 down to 1, then simplify each command) and print the trace.
//!
//! Environment: MODEL_SEED=<n> runs one seed, MODEL_SEEDS=<n> sets how many seeds run,
//! MODEL_SKIP=<property,...> ignores failures of the named properties.
const std = @import("std");

pub const Failure = struct {
    property: []const u8,
    step: usize,
};

pub const Options = struct {
    seeds: u64,
    steps: usize,
};

/// `Context` provides:
///   Command: type
///   generate(self, arena, random, steps) ![]Command
///   run(self, arena, commands) !?Failure
///   simplify(self, arena, command) !?Command   (a smaller command, or null)
///   format(self, command, writer) void       (one trace line)
pub fn check(comptime Context: type, context: *Context, default: Options) !void {
    var arena_state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    const seed_value = environment(arena, "MODEL_SEED");
    const seeds = if (environment(arena, "MODEL_SEEDS")) |text| try std.fmt.parseInt(u64, text, 10) else default.seeds;
    const skip = environment(arena, "MODEL_SKIP") orelse "";
    var seed: u64 = if (seed_value) |text| try std.fmt.parseInt(u64, text, 10) else 0;
    const last = if (seed_value != null) seed + 1 else seeds;
    while (seed < last) : (seed += 1) {
        var run_arena = std.heap.ArenaAllocator.init(std.testing.allocator);
        defer run_arena.deinit();
        const ra = run_arena.allocator();
        var prng = std.Random.DefaultPrng.init(seed);
        const commands = try context.generate(ra, prng.random(), default.steps);
        const failure = (try context.run(ra, commands)) orelse continue;
        if (listed(skip, failure.property)) continue;
        const shrunk = try shrink(Context, context, ra, commands, failure.property);
        std.debug.print("model failure: seed {d}, property {s}, shrunk to {d} commands:\n", .{ seed, failure.property, shrunk.len });
        for (shrunk) |command| {
            var buffer: [512]u8 = undefined;
            var writer = std.Io.Writer.fixed(&buffer);
            context.format(command, &writer);
            std.debug.print("  {s}\n", .{writer.buffered()});
        }
        return error.ModelFailure;
    }
}

fn shrink(comptime Context: type, context: *Context, arena: std.mem.Allocator, initial: []const Context.Command, property: []const u8) ![]const Context.Command {
    var current = initial;
    var chunk = @max(1, current.len / 2);
    while (chunk >= 1) {
        var start: usize = 0;
        var removed_any = false;
        while (start < current.len) {
            const end = @min(current.len, start + chunk);
            const candidate = try std.mem.concat(arena, Context.Command, &.{ current[0..start], current[end..] });
            if (try failsWith(Context, context, arena, candidate, property)) {
                current = candidate;
                removed_any = true;
            } else {
                start = end;
            }
        }
        if (chunk == 1 and !removed_any) break;
        if (!removed_any) chunk /= 2;
    }
    // Simplify each command while the failure stays.
    const result = try arena.dupe(Context.Command, current);
    for (result) |*command| {
        while (try context.simplify(arena, command.*)) |simpler| {
            const saved = command.*;
            command.* = simpler;
            if (!try failsWith(Context, context, arena, result, property)) {
                command.* = saved;
                break;
            }
        }
    }
    return result;
}

fn failsWith(comptime Context: type, context: *Context, arena: std.mem.Allocator, commands: []const Context.Command, property: []const u8) !bool {
    const failure = (try context.run(arena, commands)) orelse return false;
    return std.mem.eql(u8, failure.property, property);
}

fn listed(list: []const u8, name: []const u8) bool {
    var it = std.mem.splitScalar(u8, list, ',');
    while (it.next()) |item| {
        if (std.mem.eql(u8, item, name)) return true;
    }
    return false;
}

pub fn environment(arena: std.mem.Allocator, key: []const u8) ?[]const u8 {
    return std.testing.environ.getAlloc(arena, key) catch null;
}
