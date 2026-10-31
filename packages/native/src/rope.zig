const std = @import("std");
const text_work = @import("text-work.zig");
const Allocator = std.mem.Allocator;

/// This is a persistent/immutable rope - operations create new nodes without
/// freeing old ones. Use an ArenaAllocator to avoid manual memory management:
///
///   var arena = std.heap.ArenaAllocator.init(allocator);
///   defer arena.deinit();
///   var rope = try Rope(T).init(arena.allocator());
///
/// TODO: Needs a startTransaction and endTransaction to track changes
/// -> used to trigger a change event _after_ a batch of changes is complete (group as operation)
/// -> used to group history operations (undo/redo), so not everything is a single history entry
///
pub fn Rope(comptime T: type) type {
    return struct {
        const Self = @This();

        pub const max_imbalance = 7;

        pub const Config = struct {
            max_undo_depth: ?usize = null, // null = unlimited
        };

        const boundary_enabled = @hasDecl(T, "BoundaryAction");
        pub const BoundaryAction = if (boundary_enabled) T.BoundaryAction else struct {
            delete_left: bool = false,
            delete_right: bool = false,
            insert_between: []const T = &[_]T{},
        };

        pub const Metrics = struct {
            count: u32 = 0,
            depth: u32 = 1,
            custom: if (@hasDecl(T, "Metrics")) T.Metrics else void = if (@hasDecl(T, "Metrics")) .{} else {},

            pub fn add(self: *Metrics, other: Metrics) void {
                self.count += other.count;
                self.depth = @max(self.depth, other.depth);

                if (@hasDecl(T, "Metrics")) {
                    if (@hasDecl(T.Metrics, "add")) {
                        self.custom.add(other.custom);
                    }
                }
            }

            pub fn weight(self: *const Metrics) u32 {
                if (@hasDecl(T, "Metrics")) {
                    if (@hasDecl(T.Metrics, "weight")) {
                        return self.custom.weight();
                    }
                }
                return self.count;
            }

            /// Balancing size: the weight plus the leaf count, so leaves without weight still count.
            fn size(self: *const Metrics) u64 {
                return @as(u64, self.weight()) + self.count;
            }
        };

        pub const Branch = struct {
            left: *const Node,
            right: *const Node,
            total_metrics: Metrics,

            fn is_balanced(self: *const Branch) bool {
                const left_size = self.left.metrics().size();
                const right_size = self.right.metrics().size();
                const max_side = ((left_size + right_size) * 3) / 4;
                return left_size <= max_side and right_size <= max_side;
            }
        };

        pub const Leaf = struct {
            data: T,
            is_sentinel: bool = false,

            fn metrics(self: *const Leaf) Metrics {
                var m = Metrics{
                    .count = if (self.is_sentinel) 0 else 1,
                    .depth = 1,
                };

                if (@hasDecl(T, "Metrics")) {
                    if (@hasDecl(T, "measure")) {
                        m.custom = self.data.measure();
                    }
                }

                return m;
            }
        };

        pub const Node = union(enum) {
            branch: Branch,
            leaf: Leaf,

            pub fn metrics(self: *const Node) Metrics {
                return switch (self.*) {
                    .branch => |*b| b.total_metrics,
                    .leaf => |*l| l.metrics(),
                };
            }

            pub fn depth(self: *const Node) u32 {
                return self.metrics().depth;
            }

            pub fn count(self: *const Node) u32 {
                return self.metrics().count;
            }

            pub fn is_balanced(self: *const Node) bool {
                return switch (self.*) {
                    .branch => |*b| b.is_balanced(),
                    .leaf => true,
                };
            }

            pub fn is_empty(self: *const Node) bool {
                return switch (self.*) {
                    .branch => |*b| b.left.is_empty() and b.right.is_empty(),
                    .leaf => |*l| {
                        if (@hasDecl(T, "is_empty")) {
                            return l.data.is_empty();
                        }
                        return false;
                    },
                };
            }

            pub fn is_sentinel(self: *const Node, empty_leaf: *const Node) bool {
                return self == empty_leaf;
            }

            pub fn init_branch(left: *const Node, right: *const Node) Node {
                var total_metrics = Metrics{};
                total_metrics.add(left.metrics());
                total_metrics.add(right.metrics());
                total_metrics.depth += 1;

                return .{ .branch = .{
                    .left = left,
                    .right = right,
                    .total_metrics = total_metrics,
                } };
            }

            pub fn new_branch(allocator: Allocator, left: *const Node, right: *const Node) !*const Node {
                const node = try allocator.create(Node);
                node.* = init_branch(left, right);
                return node;
            }

            pub fn new_leaf(allocator: Allocator, data: T) !*const Node {
                const node = try allocator.create(Node);
                errdefer allocator.destroy(node);

                node.* = .{ .leaf = .{ .data = data } };
                return node;
            }

            pub fn get(self: *const Node, index: u32) ?*const T {
                return switch (self.*) {
                    .branch => |*b| {
                        const left_count = b.left.metrics().count;
                        if (index < left_count) {
                            return b.left.get(index);
                        }
                        return b.right.get(index - left_count);
                    },
                    .leaf => |*l| if (index == 0) &l.data else null,
                };
            }

            pub const WalkerFn = *const fn (ctx: *anyopaque, data: *const T, index: u32) WalkerResult;

            pub const WalkerResult = struct {
                keep_walking: bool = true,
                err: ?anyerror = null,
            };

            pub fn walk(self: *const Node, ctx: *anyopaque, f: WalkerFn, current_index: *u32) WalkerResult {
                return switch (self.*) {
                    .branch => |*b| {
                        const left_result = b.left.walk(ctx, f, current_index);
                        if (!left_result.keep_walking or left_result.err != null) {
                            return left_result;
                        }
                        return b.right.walk(ctx, f, current_index);
                    },
                    .leaf => |*l| {
                        const result = f(ctx, &l.data, current_index.*);
                        current_index.* += 1;
                        return result;
                    },
                };
            }

            pub fn walk_from(self: *const Node, start_index: u32, ctx: *anyopaque, f: WalkerFn) WalkerResult {
                var current_index: u32 = start_index;
                return self.walk_from_internal(start_index, ctx, f, &current_index);
            }

            fn walk_from_internal(self: *const Node, start_index: u32, ctx: *anyopaque, f: WalkerFn, current_index: *u32) WalkerResult {
                return switch (self.*) {
                    .branch => |*b| {
                        const left_count = b.left.metrics().count;
                        if (start_index >= left_count) {
                            return b.right.walk_from_internal(start_index - left_count, ctx, f, current_index);
                        }

                        const left_result = b.left.walk_from_internal(start_index, ctx, f, current_index);
                        if (!left_result.keep_walking or left_result.err != null) {
                            return left_result;
                        }
                        return b.right.walk(ctx, f, current_index);
                    },
                    .leaf => |*l| {
                        if (start_index == 0) {
                            const result = f(ctx, &l.data, current_index.*);
                            current_index.* += 1;
                            return result;
                        }
                        return .{};
                    },
                };
            }

            fn collect(self: *const Node, list: *std.ArrayListUnmanaged(*const Node), allocator: Allocator) !void {
                switch (self.*) {
                    .branch => |*b| {
                        try b.left.collect(list, allocator);
                        try b.right.collect(list, allocator);
                    },
                    .leaf => try list.append(allocator, self),
                }
            }

            fn merge_leaves(leaves: []*const Node, allocator: Allocator) error{OutOfMemory}!*const Node {
                const len = leaves.len;
                if (len == 0) return error.OutOfMemory; // Should not happen
                if (len == 1) return leaves[0];
                if (len == 2) return try Node.new_branch(allocator, leaves[0], leaves[1]);

                const mid = len / 2;
                return try Node.new_branch(
                    allocator,
                    try merge_leaves(leaves[0..mid], allocator),
                    try merge_leaves(leaves[mid..], allocator),
                );
            }

            pub fn rebalance(self: *const Node, allocator: Allocator, tmp_allocator: Allocator) !*const Node {
                if (self.is_balanced()) return self;

                var leaves: std.ArrayListUnmanaged(*const Node) = .empty;
                defer leaves.deinit(tmp_allocator);

                try leaves.ensureTotalCapacity(tmp_allocator, self.count());
                try self.collect(&leaves, tmp_allocator);

                return try merge_leaves(leaves.items, allocator);
            }

            /// Structural split at index - returns (left, right) without flattening
            pub fn split_at(node: *const Node, index: u32, allocator: Allocator, empty_leaf: *const Node) error{OutOfMemory}!struct { left: *const Node, right: *const Node } {
                if (index == 0) return .{ .left = empty_leaf, .right = node };
                if (index >= node.count()) return .{ .left = node, .right = empty_leaf };
                return switch (node.*) {
                    .leaf => unreachable,
                    .branch => |*b| {
                        const left_count = b.left.metrics().count;
                        if (index < left_count) {
                            const result = try split_at(b.left, index, allocator, empty_leaf);
                            const new_right = try join_balanced(result.right, b.right, allocator);
                            return .{ .left = result.left, .right = new_right };
                        } else if (index > left_count) {
                            const result = try split_at(b.right, index - left_count, allocator, empty_leaf);
                            const new_left = try join_balanced(b.left, result.left, allocator);
                            return .{ .left = new_left, .right = result.right };
                        } else {
                            return .{ .left = b.left, .right = b.right };
                        }
                    },
                };
            }

            pub fn join_balanced(left: *const Node, right: *const Node, allocator: Allocator) error{OutOfMemory}!*const Node {
                const left_count = left.metrics().count;
                const right_count = right.metrics().count;

                if (left_count == 0) return right;
                if (right_count == 0) return left;

                const left_size = left.metrics().size();
                const right_size = right.metrics().size();
                const max_side = ((left_size + right_size) * 3) / 4;
                if (left_size <= max_side and right_size <= max_side) {
                    return try new_branch(allocator, left, right);
                }

                if (left_size > right_size * 3) {
                    return switch (left.*) {
                        .leaf => try new_branch(allocator, left, right),
                        .branch => |*b| {
                            const new_right = try join_balanced(b.right, right, allocator);
                            if (new_right.metrics().size() > b.left.metrics().size() * 3) {
                                switch (new_right.*) {
                                    .branch => |*nr| {
                                        const new_left = try join_balanced(b.left, nr.left, allocator);
                                        return try new_branch(allocator, new_left, nr.right);
                                    },
                                    .leaf => {},
                                }
                            }
                            return try new_branch(allocator, b.left, new_right);
                        },
                    };
                }

                return switch (right.*) {
                    .leaf => try new_branch(allocator, left, right),
                    .branch => |*b| {
                        const new_left = try join_balanced(left, b.left, allocator);
                        if (new_left.metrics().size() > b.right.metrics().size() * 3) {
                            switch (new_left.*) {
                                .branch => |*nl| {
                                    const new_right = try join_balanced(nl.right, b.right, allocator);
                                    return try new_branch(allocator, nl.left, new_right);
                                },
                                .leaf => {},
                            }
                        }
                        return try new_branch(allocator, new_left, b.right);
                    },
                };
            }

            pub const LeafSplitResult = struct { left: T, right: T };

            /// Leaves that replace two neighbors; `more` asks to check the last of them against the next leaf.
            /// `span` holds the weights, within `joined`, of the grapheme that crosses the old boundary.
            pub const LeafJoin = struct { left: ?T = null, joined: T, right: ?T = null, span: ?[2]u32 = null, more: bool };

            pub const LeafSplitFn = struct {
                ctx: ?*anyopaque = null,
                splitFn: *const fn (allocator: Allocator, ctx: ?*anyopaque, leaf: *const T, weight_in_leaf: u32) error{ OutOfBounds, OutOfMemory }!LeafSplitResult,
                /// Joins or reshapes two neighboring leaves, or returns null to keep them. Without it, they stay apart.
                joinFn: ?*const fn (ctx: ?*anyopaque, left: *const T, right: *const T) error{OutOfMemory}!?LeafJoin = null,

                pub fn call(self: *const @This(), allocator: Allocator, leaf: *const T, weight: u32) error{ OutOfBounds, OutOfMemory }!LeafSplitResult {
                    return self.splitFn(allocator, self.ctx, leaf, weight);
                }
            };

            /// The side that takes the zero-weight leaves at the split weight; null leaves it to the tree shape.
            pub const Bias = enum { left, right };

            pub fn split_at_weight(
                node: *const Node,
                target_weight: u32,
                bias: ?Bias,
                allocator: Allocator,
                empty_leaf: *const Node,
                split_leaf_fn: *const LeafSplitFn,
            ) error{ OutOfMemory, OutOfBounds }!struct { left: *const Node, right: *const Node } {
                return switch (node.*) {
                    .leaf => |*l| {
                        const leaf_weight = node.metrics().weight();

                        if (target_weight == 0 and (leaf_weight > 0 or bias != .left)) {
                            return .{ .left = empty_leaf, .right = node };
                        } else if (target_weight >= leaf_weight) {
                            return .{ .left = node, .right = empty_leaf };
                        }

                        const split_result = try split_leaf_fn.call(allocator, &l.data, target_weight);
                        // An empty left piece, as when a wide grapheme straddles the weight, leaves no
                        // leaf that would sit between the leaves a join must see. A split keeps the
                        // grapheme that passes the weight, so the right piece holds bytes.
                        if (@hasDecl(T, "isVoid")) std.debug.assert(!split_result.right.isVoid());
                        const left_node = if (@hasDecl(T, "isVoid") and split_result.left.isVoid()) empty_leaf else try new_leaf(allocator, split_result.left);
                        const right_node = try new_leaf(allocator, split_result.right);
                        return .{ .left = left_node, .right = right_node };
                    },
                    .branch => |*b| {
                        const left_weight = b.left.metrics().weight();

                        if (target_weight < left_weight or (target_weight == left_weight and bias == .right)) {
                            const result = try split_at_weight(b.left, target_weight, bias, allocator, empty_leaf, split_leaf_fn);
                            const new_right = try join_balanced(result.right, b.right, allocator);
                            return .{ .left = result.left, .right = new_right };
                        } else if (target_weight > left_weight or bias == .left) {
                            const result = try split_at_weight(b.right, target_weight - left_weight, bias, allocator, empty_leaf, split_leaf_fn);
                            const new_left = try join_balanced(b.left, result.left, allocator);
                            return .{ .left = new_left, .right = result.right };
                        } else {
                            return .{ .left = b.left, .right = b.right };
                        }
                    },
                };
            }
        };

        pub const UndoNode = struct {
            root: *const Node,
            metrics_generation: u64,
            next: ?*UndoNode = null,
            branches: ?*UndoBranch = null,
            meta: []const u8,
        };

        pub const UndoBranch = struct {
            redo: *UndoNode,
            next: ?*UndoBranch,
        };

        root: *const Node,
        metrics_generation: u64 = 0,
        allocator: Allocator,
        empty_leaf: *const Node,
        undo_history: ?*UndoNode = null,
        redo_history: ?*UndoNode = null,
        curr_history: ?*UndoNode = null,
        config: Config = .{},
        undo_depth: usize = 0,

        pub fn init(allocator: Allocator) error{OutOfMemory}!Self {
            return initWithConfig(allocator, .{});
        }

        pub fn initWithConfig(allocator: Allocator, config: Config) error{OutOfMemory}!Self {
            const empty_data = if (@hasDecl(T, "empty"))
                T.empty()
            else
                std.mem.zeroes(T);

            const node = try allocator.create(Node);
            node.* = .{ .leaf = .{ .data = empty_data, .is_sentinel = true } };

            var self = Self{
                .root = node,
                .allocator = allocator,
                .empty_leaf = node,
                .config = config,
            };

            try self.applyEndsInvariant();

            return self;
        }

        pub fn from_item(allocator: Allocator, data: T) !Self {
            return from_itemWithConfig(allocator, data, .{});
        }

        pub fn from_itemWithConfig(allocator: Allocator, data: T, config: Config) !Self {
            const root = try Node.new_leaf(allocator, data);
            const empty_data = if (@hasDecl(T, "empty"))
                T.empty()
            else
                std.mem.zeroes(T);

            const empty_node = try allocator.create(Node);
            empty_node.* = .{ .leaf = .{ .data = empty_data, .is_sentinel = true } };

            return .{
                .root = root,
                .allocator = allocator,
                .empty_leaf = empty_node,
                .config = config,
            };
        }

        pub fn from_slice(allocator: Allocator, items: []const T) !Self {
            return from_sliceWithConfig(allocator, items, .{});
        }

        pub fn from_sliceWithConfig(allocator: Allocator, items: []const T, config: Config) !Self {
            if (items.len == 0) {
                return try initWithConfig(allocator, config);
            }

            const root = try rootFromSlice(allocator, items);
            const empty_data = if (@hasDecl(T, "empty"))
                T.empty()
            else
                std.mem.zeroes(T);

            const empty_node = try allocator.create(Node);
            empty_node.* = .{ .leaf = .{ .data = empty_data, .is_sentinel = true } };

            return .{
                .root = root,
                .allocator = allocator,
                .empty_leaf = empty_node,
                .config = config,
            };
        }

        fn rootFromSlice(allocator: Allocator, items: []const T) error{OutOfMemory}!*const Node {
            std.debug.assert(items.len > 0);
            const node_count = std.math.mul(usize, items.len, 2) catch return error.OutOfMemory;
            const nodes = try allocator.alloc(Node, node_count - 1);
            return rootFromSliceInto(nodes, items);
        }

        fn rootFromSliceInto(nodes: []Node, items: []const T) *const Node {
            std.debug.assert(items.len > 0);
            std.debug.assert(nodes.len == 2 * items.len - 1);
            if (items.len == 1) {
                nodes[0] = .{ .leaf = .{ .data = items[0] } };
                return &nodes[0];
            }

            const mid = items.len / 2;
            const left_nodes = 2 * mid - 1;
            const left = rootFromSliceInto(nodes[1 .. 1 + left_nodes], items[0..mid]);
            const right = rootFromSliceInto(nodes[1 + left_nodes ..], items[mid..]);
            nodes[0] = Node.init_branch(left, right);
            return &nodes[0];
        }

        pub fn count(self: *const Self) u32 {
            return self.root.count();
        }

        pub fn get(self: *const Self, index: u32) ?*const T {
            return self.root.get(index);
        }

        pub fn walk(self: *const Self, ctx: *anyopaque, f: Node.WalkerFn) !void {
            var index: u32 = 0;
            const result = self.walkNode(self.root, ctx, f, &index);
            if (result.err) |e| return e;
        }

        pub fn metricsGeneration(self: *const Self) u64 {
            return self.metrics_generation;
        }

        pub fn setMetricsGeneration(self: *Self, generation: u64) void {
            self.metrics_generation = generation;
            // An undo/redo history node may alias the active root; keep its stamp
            // current so revisiting that root does not restore a stale generation.
            if (self.curr_history) |current| {
                if (current.root == self.root) current.metrics_generation = generation;
            }
        }

        /// Recompute cached branch metrics after the owner updates derived leaf data.
        /// The persistent structure is unchanged; only aggregate caches are mutated.
        pub fn remeasure(self: *Self) void {
            _ = remeasureNode(self.root);
        }

        fn remeasureNode(node: *const Node) Metrics {
            text_work.add(.remeasure_nodes, 1);
            return switch (node.*) {
                .leaf => |*leaf| leaf.metrics(),
                .branch => |*branch| blk: {
                    const left_metrics = remeasureNode(branch.left);
                    const right_metrics = remeasureNode(branch.right);
                    var total_metrics = Metrics{};
                    total_metrics.add(left_metrics);
                    total_metrics.add(right_metrics);
                    total_metrics.depth += 1;

                    const mutable = @constCast(branch);
                    mutable.total_metrics = total_metrics;
                    break :blk total_metrics;
                },
            };
        }

        fn walkNode(self: *const Self, node: *const Node, ctx: *anyopaque, f: Node.WalkerFn, current_index: *u32) Node.WalkerResult {
            return switch (node.*) {
                .branch => |*b| {
                    const left_result = self.walkNode(b.left, ctx, f, current_index);
                    if (!left_result.keep_walking or left_result.err != null) {
                        return left_result;
                    }
                    return self.walkNode(b.right, ctx, f, current_index);
                },
                .leaf => |*l| {
                    if (node.count() == 0) {
                        return .{};
                    }
                    const result = f(ctx, &l.data, current_index.*);
                    current_index.* += 1;
                    return result;
                },
            };
        }

        pub fn walk_from(self: *const Self, start_index: u32, ctx: *anyopaque, f: Node.WalkerFn) !void {
            var current_index: u32 = 0;
            const result = self.walkFromNode(self.root, start_index, ctx, f, &current_index);
            if (result.err) |e| return e;
        }

        fn walkFromNode(self: *const Self, node: *const Node, start_index: u32, ctx: *anyopaque, f: Node.WalkerFn, current_index: *u32) Node.WalkerResult {
            return switch (node.*) {
                .branch => |*b| {
                    const left_count = b.left.metrics().count;
                    if (start_index >= left_count) {
                        return self.walkFromNode(b.right, start_index - left_count, ctx, f, current_index);
                    }

                    const left_result = self.walkFromNode(b.left, start_index, ctx, f, current_index);
                    if (!left_result.keep_walking or left_result.err != null) {
                        return left_result;
                    }
                    return self.walkNode(b.right, ctx, f, current_index);
                },
                .leaf => |*l| {
                    if (node.count() == 0) {
                        return .{};
                    }
                    if (start_index == 0) {
                        const result = f(ctx, &l.data, current_index.*);
                        current_index.* += 1;
                        return result;
                    }
                    return .{};
                },
            };
        }

        pub fn rebalance(self: *Self, tmp_allocator: Allocator) !void {
            self.root = try self.root.rebalance(self.allocator, tmp_allocator);
        }

        pub fn insert(self: *Self, index: u32, data: T) !void {
            try self.insert_slice(index, &[_]T{data});
        }

        pub fn delete(self: *Self, index: u32) !void {
            try self.delete_range(index, index + 1);
        }

        pub fn replace(self: *Self, index: u32, data: T) !void {
            if (index >= self.count()) return;

            try self.delete_range(index, index + 1);
            try self.insert_slice(index, &[_]T{data});
        }

        pub fn append(self: *Self, data: T) !void {
            try self.insert(self.count(), data);
        }

        pub fn prepend(self: *Self, data: T) !void {
            try self.insert(0, data);
        }

        pub fn concat(self: *Self, other: *const Self) !void {
            self.root = try self.joinWithBoundary(self.root, other.root, null, null);
        }

        pub fn split(self: *Self, index: u32) !Self {
            const result = try Node.split_at(self.root, index, self.allocator, self.empty_leaf);
            self.root = result.left;
            return Self{
                .root = result.right,
                .metrics_generation = self.metrics_generation,
                .allocator = self.allocator,
                .empty_leaf = self.empty_leaf,
                .undo_history = null,
                .redo_history = null,
                .curr_history = null,
            };
        }

        pub fn slice(self: *const Self, start: u32, end: u32, allocator: Allocator) ![]T {
            if (start >= end) return &[_]T{};

            const SliceContext = struct {
                items: std.ArrayListUnmanaged(T),
                allocator: Allocator,
                start: u32,
                end: u32,
                current_index: u32 = 0,

                fn walker(ctx: *anyopaque, data: *const T, idx: u32) Node.WalkerResult {
                    _ = idx;
                    const context = @as(*@This(), @ptrCast(@alignCast(ctx)));
                    if (context.current_index >= context.start and context.current_index < context.end) {
                        context.items.append(context.allocator, data.*) catch |e| return .{ .err = e };
                    }
                    context.current_index += 1;
                    if (context.current_index >= context.end) {
                        return .{ .keep_walking = false };
                    }
                    return .{};
                }
            };

            var context = SliceContext{
                .items = .empty,
                .allocator = allocator,
                .start = start,
                .end = end,
            };
            errdefer context.items.deinit(allocator);

            try self.walk(&context, SliceContext.walker);
            return context.items.toOwnedSlice(allocator);
        }

        pub fn delete_range(self: *Self, start: u32, end: u32) !void {
            if (start >= end) return;

            const first_split = try Node.split_at(self.root, start, self.allocator, self.empty_leaf);
            const second_split = try Node.split_at(first_split.right, end - start, self.allocator, self.empty_leaf);

            self.root = try self.joinWithBoundary(first_split.left, second_split.right, null, null);
            try self.applyEndsInvariant();
        }

        pub fn insert_slice(self: *Self, index: u32, items: []const T) !void {
            if (items.len == 0) return;

            const insert_root = try rootFromSlice(self.allocator, items);

            const split_result = try Node.split_at(self.root, index, self.allocator, self.empty_leaf);

            const left_joined = try self.joinWithBoundary(split_result.left, insert_root, null, null);
            self.root = try self.joinWithBoundary(left_joined, split_result.right, null, null);
            try self.applyEndsInvariant();
        }

        pub fn to_array(self: *const Self, allocator: Allocator) ![]T {
            const ToArrayContext = struct {
                items: std.ArrayListUnmanaged(T),
                allocator: Allocator,

                fn walker(ctx: *anyopaque, data: *const T, idx: u32) Node.WalkerResult {
                    _ = idx;
                    const context = @as(*@This(), @ptrCast(@alignCast(ctx)));
                    context.items.append(context.allocator, data.*) catch |e| return .{ .err = e };
                    return .{};
                }
            };

            var context = ToArrayContext{
                .items = .empty,
                .allocator = allocator,
            };
            errdefer context.items.deinit(allocator);

            try self.walk(&context, ToArrayContext.walker);
            return context.items.toOwnedSlice(allocator);
        }

        pub fn toText(self: *const Self, allocator: Allocator) ![]u8 {
            var buffer: std.Io.Writer.Allocating = .init(allocator);
            defer buffer.deinit();

            try buffer.writer.writeAll("[root");
            try nodeToText(self.root, &buffer.writer);
            try buffer.writer.writeByte(']');

            return buffer.toOwnedSlice();
        }

        fn nodeToText(node: *const Node, writer: *std.Io.Writer) !void {
            switch (node.*) {
                .branch => |*b| {
                    try writer.writeAll("[branch");
                    try nodeToText(b.left, writer);
                    try nodeToText(b.right, writer);
                    try writer.writeByte(']');
                },
                .leaf => |*l| {
                    if (l.is_sentinel) {
                        try writer.writeAll("[empty]");
                        return;
                    }

                    if (@typeInfo(T) == .@"union") {
                        const tag = std.meta.activeTag(l.data);
                        const tag_name = @tagName(tag);

                        try writer.writeByte('[');
                        try writer.writeAll(tag_name);

                        if (@hasDecl(T, "Metrics")) {
                            const metrics = l.metrics();
                            try writer.writeByte(':');
                            try writer.print("w{d}", .{metrics.weight()});

                            if (@hasDecl(T.Metrics, "total_width_cols")) {
                                try writer.print(",tw{d}", .{metrics.custom.total_width_cols});
                            }
                            if (@hasDecl(T.Metrics, "total_bytes")) {
                                try writer.print(",b{d}", .{metrics.custom.total_bytes});
                            }
                        }

                        try writer.writeByte(']');
                    } else {
                        try writer.writeAll("[leaf");
                        if (@hasDecl(T, "Metrics")) {
                            const metrics = l.metrics();
                            try writer.writeByte(':');
                            try writer.print("w{d}", .{metrics.weight()});
                        }
                        try writer.writeByte(']');
                    }
                },
            }
        }

        pub fn totalWeight(self: *const Self) u32 {
            return self.root.metrics().weight();
        }

        pub fn splitByWeight(self: *Self, weight: u32, split_leaf_fn: *const Node.LeafSplitFn) !Self {
            const result = try Node.split_at_weight(self.root, weight, null, self.allocator, self.empty_leaf, split_leaf_fn);
            self.root = result.left;
            return Self{
                .root = result.right,
                .metrics_generation = self.metrics_generation,
                .allocator = self.allocator,
                .empty_leaf = self.empty_leaf,
                .undo_history = null,
                .redo_history = null,
                .curr_history = null,
            };
        }

        fn getLastLeaf(self: *const Self) ?*const T {
            if (self.count() == 0) return null;
            return self.get(self.count() - 1);
        }

        fn getFirstLeaf(self: *const Self) ?*const T {
            if (self.count() == 0) return null;
            return self.get(0);
        }

        fn getFirstLeafIn(node: *const Node) ?*const T {
            return switch (node.*) {
                .branch => |*b| getFirstLeafIn(b.left),
                .leaf => |*l| if (node.count() == 0) null else &l.data,
            };
        }

        fn getLastLeafIn(node: *const Node) ?*const T {
            return switch (node.*) {
                .branch => |*b| getLastLeafIn(b.right),
                .leaf => |*l| if (node.count() == 0) null else &l.data,
            };
        }

        fn dropFirst(node: *const Node, allocator: Allocator, empty_leaf: *const Node) error{OutOfMemory}!*const Node {
            if (node.count() == 0) return node;
            const split_result = try Node.split_at(node, 1, allocator, empty_leaf);
            return split_result.right;
        }

        fn dropLast(node: *const Node, allocator: Allocator, empty_leaf: *const Node) error{OutOfMemory}!*const Node {
            const cnt = node.count();
            if (cnt == 0) return node;
            const split_result = try Node.split_at(node, cnt - 1, allocator, empty_leaf);
            return split_result.left;
        }

        /// The weights, in a joined rope, of the grapheme that holds the junction; empty at a break.
        pub const JoinSpan = struct { start: u32, end: u32 };

        fn joinWithBoundary(self: *Self, left: *const Node, right: *const Node, leaf_fn: ?*const Node.LeafSplitFn, span: ?*JoinSpan) error{OutOfMemory}!*const Node {
            // The rewrite drops or adds only weightless markers.
            if (span) |held| held.* = .{ .start = left.metrics().weight(), .end = left.metrics().weight() };
            if (!boundary_enabled or !@hasDecl(T, "rewriteBoundary")) {
                return try Node.join_balanced(left, right, self.allocator);
            }

            const action = try T.rewriteBoundary(self.allocator, getLastLeafIn(left), getFirstLeafIn(right));

            var L = left;
            var R = right;

            if (action.delete_left) {
                L = try dropLast(L, self.allocator, self.empty_leaf);
            }
            if (action.delete_right) {
                R = try dropFirst(R, self.allocator, self.empty_leaf);
            }

            if (action.insert_between.len > 0) {
                const insert_root = try rootFromSlice(self.allocator, action.insert_between);
                const left_with_insert = try Node.join_balanced(L, insert_root, self.allocator);
                return try Node.join_balanced(left_with_insert, R, self.allocator);
            }

            // Join after the rewrite: dropping an orphaned linestart can bring two text leaves together.
            const join_fn = if (leaf_fn) |f| f.joinFn orelse null else null;
            var open = span != null;
            var held = false;
            while (join_fn) |join| {
                const joined = try join(leaf_fn.?.ctx, getLastLeafIn(L) orelse break, getFirstLeafIn(R) orelse break) orelse break;
                L = try dropLast(L, self.allocator, self.empty_leaf);
                R = try dropFirst(R, self.allocator, self.empty_leaf);
                // The last leaf placed on the left meets the next leaf on the right in the next round.
                for ([_]?T{ joined.left, joined.joined, joined.right }, 0..) |maybe_leaf, i| {
                    if (i == 1 and open) if (joined.span) |within| {
                        const base = L.metrics().weight();
                        if (!held) span.?.start = base + within[0];
                        span.?.end = base + within[1];
                        held = true;
                    };
                    if (maybe_leaf) |leaf| L = try Node.join_balanced(L, try Node.new_leaf(self.allocator, leaf), self.allocator);
                }
                // The grapheme can go on into the next leaf only from a joined leaf that it ends.
                open = open and joined.span != null and joined.right == null and span.?.end == L.metrics().weight();
                if (!joined.more) break;
            }

            return try Node.join_balanced(L, R, self.allocator);
        }

        fn applyEndsInvariant(self: *Self) !void {
            if (!boundary_enabled or !@hasDecl(T, "rewriteEnds")) return;

            const first = self.getFirstLeaf();
            const last = self.getLastLeaf();
            const action = try T.rewriteEnds(self.allocator, first, last);

            // Handle deletion operations first
            if (action.delete_left and self.count() > 0) {
                const split_result = try Node.split_at(self.root, 1, self.allocator, self.empty_leaf);
                self.root = split_result.right;
            }
            if (action.delete_right and self.count() > 0) {
                const cnt = self.count();
                const split_result = try Node.split_at(self.root, cnt - 1, self.allocator, self.empty_leaf);
                self.root = split_result.left;
            }

            // Handle insertion
            if (action.insert_between.len > 0) {
                const insert_root = try rootFromSlice(self.allocator, action.insert_between);
                self.root = try Node.join_balanced(insert_root, self.root, self.allocator);
            }
        }

        /// Puts `items` in place of the range right of the start split and left of the end split.
        /// Returns the grapheme that holds the end of `items` (or of the range, without items).
        pub fn replaceRangeByWeight(self: *Self, start: u32, end: u32, start_bias: Node.Bias, end_bias: Node.Bias, items: []const T, split_leaf_fn: *const Node.LeafSplitFn) !JoinSpan {
            std.debug.assert(start <= end);
            const first_split = try Node.split_at_weight(self.root, start, start_bias, self.allocator, self.empty_leaf, split_leaf_fn);
            const second_split = try Node.split_at_weight(first_split.right, end - start, end_bias, self.allocator, self.empty_leaf, split_leaf_fn);

            const left = if (items.len == 0) first_split.left else try self.joinWithBoundary(first_split.left, try rootFromSlice(self.allocator, items), split_leaf_fn, null);
            var span: JoinSpan = undefined;
            self.root = try self.joinWithBoundary(left, second_split.right, split_leaf_fn, &span);
            try self.applyEndsInvariant();
            return span;
        }

        /// `bias` picks the side of the zero-weight leaves at `weight`, so the tree shape cannot.
        /// Returns the grapheme that holds the end of `items`.
        pub fn insertSliceByWeight(self: *Self, weight: u32, bias: Node.Bias, items: []const T, split_leaf_fn: *const Node.LeafSplitFn) !JoinSpan {
            if (items.len == 0) return .{ .start = weight, .end = weight };

            const insert_root = try rootFromSlice(self.allocator, items);

            const split_result = try Node.split_at_weight(self.root, weight, bias, self.allocator, self.empty_leaf, split_leaf_fn);

            const left_joined = try self.joinWithBoundary(split_result.left, insert_root, split_leaf_fn, null);
            var span: JoinSpan = undefined;
            self.root = try self.joinWithBoundary(left_joined, split_result.right, split_leaf_fn, &span);
            try self.applyEndsInvariant();
            return span;
        }

        pub const WeightFindResult = struct { leaf: *const T, start_weight: u32, leaf_index: u32 };

        pub fn findByWeight(self: *const Self, weight: u32) ?WeightFindResult {
            if (weight >= self.totalWeight()) return null;
            var node = self.root;
            var start_weight: u32 = 0;
            var leaf_index: u32 = 0;
            while (true) switch (node.*) {
                .branch => |*b| {
                    const left_weight = b.left.metrics().weight();
                    if (weight < start_weight + left_weight) {
                        node = b.left;
                    } else {
                        node = b.right;
                        start_weight += left_weight;
                        leaf_index += b.left.metrics().count;
                    }
                },
                .leaf => |*l| return .{ .leaf = &l.data, .start_weight = start_weight, .leaf_index = leaf_index },
            };
        }

        pub const Position = struct { leaf_index: u32, weight: u32 };

        /// Position of the leaf that holds occurrence `n` of the leaves that `counted` counts,
        /// found by one descent; null when there are not that many.
        pub fn seekCount(self: *const Self, comptime counted: fn (*const Metrics) u32, n: u32) ?Position {
            if (n >= counted(&self.root.metrics())) return null;
            text_work.add(.line_seeks, 1);
            var node = self.root;
            var rest = n;
            var position: Position = .{ .leaf_index = 0, .weight = 0 };
            while (node.* == .branch) {
                text_work.add(.line_seek_nodes, 1);
                const left = node.branch.left.metrics();
                if (rest < counted(&left)) {
                    node = node.branch.left;
                } else {
                    rest -= counted(&left);
                    position.leaf_index += left.count;
                    position.weight += left.weight();
                    node = node.branch.right;
                }
            }
            return position;
        }

        /// Number of leaves that `counted` counts and that start at or before `target`, measured
        /// along `key`, found by one descent. Leaves without key at `target` count.
        pub fn countThrough(self: *const Self, comptime key: fn (*const Metrics) u32, comptime counted: fn (*const Metrics) u32, target: u32) u32 {
            text_work.add(.line_seeks, 1);
            var node = self.root;
            var rest = target;
            var total: u32 = 0;
            while (node.* == .branch) {
                text_work.add(.line_seek_nodes, 1);
                const left = node.branch.left.metrics();
                if (rest < key(&left)) {
                    node = node.branch.left;
                } else {
                    rest -= key(&left);
                    total += counted(&left);
                    node = node.branch.right;
                }
            }
            return total + counted(&node.metrics());
        }

        pub const Side = enum { start, end };
        const shared_leaves_depth_max = 96;

        /// Leaves at the start (or end) of this rope that are the same leaf as in `other`, at most
        /// `limit`. Edits keep every leaf they do not touch, so a walk that skips the subtrees both
        /// trees share finds them in O(depth²) steps. Null when a tree is too deep for the stack.
        pub fn sharedLeaves(self: *const Self, other: *const Node, comptime side: Side, limit: u32) ?u32 {
            if (self.root.depth() > shared_leaves_depth_max or other.depth() > shared_leaves_depth_max) return null;
            var stacks: [2][shared_leaves_depth_max]*const Node = undefined;
            var lens: [2]usize = .{ 0, 0 };
            var nodes: [2]*const Node = .{ self.root, other };
            var shared: u32 = 0;
            while (true) {
                text_work.add(.rope_diff_nodes, 1);
                if (nodes[0] == nodes[1]) {
                    // Both cursors stand at the same leaf index, so a shared subtree is shared leaves.
                    shared += nodes[0].count();
                    if (shared >= limit) return limit;
                    // A tree whose leaves are all shared has at least `limit` of them.
                    std.debug.assert(lens[0] > 0 and lens[1] > 0);
                    for (&nodes, &lens, &stacks) |*node, *len, *stack| {
                        len.* -= 1;
                        node.* = stack[len.*];
                    }
                    continue;
                }
                // Descend the larger node; two different leaves end the shared run.
                const larger: usize = if (nodes[0].* == .branch and (nodes[1].* == .leaf or nodes[0].count() >= nodes[1].count())) 0 else 1;
                const branch = switch (nodes[larger].*) {
                    .branch => |*b| b,
                    .leaf => return shared,
                };
                std.debug.assert(lens[larger] < shared_leaves_depth_max);
                stacks[larger][lens[larger]] = if (side == .start) branch.right else branch.left;
                lens[larger] += 1;
                nodes[larger] = if (side == .start) branch.left else branch.right;
            }
        }

        /// Undo/Redo operations
        pub fn store_undo(self: *Self, meta: []const u8) !void {
            const undo_node = try self.create_undo_node(self.root, meta);
            errdefer {
                self.allocator.free(undo_node.meta);
                self.allocator.destroy(undo_node);
            }
            if (self.redo_history) |redo_node| {
                const branch = try self.allocator.create(UndoBranch);
                branch.* = .{ .redo = redo_node, .next = null };
                undo_node.branches = branch;
            }
            self.push_undo(undo_node);
            self.curr_history = null;
            self.redo_history = null;
        }

        fn create_undo_node(self: *const Self, root: *const Node, meta_: []const u8) !*UndoNode {
            const undo_node = try self.allocator.create(UndoNode);
            errdefer self.allocator.destroy(undo_node);
            const meta = try self.allocator.dupe(u8, meta_);
            undo_node.* = UndoNode{
                .root = root,
                .metrics_generation = self.metrics_generation,
                .meta = meta,
            };
            return undo_node;
        }

        fn push_undo(self: *Self, undo_node: *UndoNode) void {
            const next = self.undo_history;
            self.undo_history = undo_node;
            undo_node.next = next;
            self.undo_depth += 1;

            // Trim history if we exceed max_undo_depth
            if (self.config.max_undo_depth) |max_depth| {
                if (self.undo_depth > max_depth) {
                    self.trimUndoHistory(max_depth);
                }
            }
        }

        fn trimUndoHistory(self: *Self, max_depth: usize) void {
            var current = self.undo_history;
            var depth_count: usize = 0;
            var prev: ?*UndoNode = null;

            while (current) |node| {
                depth_count += 1;
                if (depth_count >= max_depth) {
                    // Cut off the rest of the history
                    if (prev) |p| {
                        p.next = null;
                    }
                    self.undo_depth = max_depth;
                    return;
                }
                prev = node;
                current = node.next;
            }
        }

        fn push_redo(self: *Self, undo_node: *UndoNode) void {
            const next = self.redo_history;
            self.redo_history = undo_node;
            undo_node.next = next;
        }

        pub fn undo(self: *Self, meta: []const u8) ![]const u8 {
            const r = self.curr_history orelse try self.create_undo_node(self.root, meta);
            const h = self.undo_history orelse return error.Stop;
            self.undo_history = h.next;
            self.curr_history = h;
            self.root = h.root;
            self.metrics_generation = h.metrics_generation;
            self.push_redo(r);
            if (self.undo_depth > 0) self.undo_depth -= 1;
            return h.meta;
        }

        pub fn redo(self: *Self) ![]const u8 {
            const u = self.curr_history orelse return error.Stop;
            const h = self.redo_history orelse return error.Stop;
            if (u.root != self.root) return error.Stop;
            self.redo_history = h.next;
            self.curr_history = h;
            self.root = h.root;
            self.metrics_generation = h.metrics_generation;
            self.push_undo(u);
            return h.meta;
        }

        pub fn can_undo(self: *const Self) bool {
            return self.undo_history != null;
        }

        pub fn can_redo(self: *const Self) bool {
            return self.redo_history != null and self.curr_history != null;
        }

        /// Returns whether an undo or redo root can still reference replaced nodes.
        pub fn hasHistory(self: *const Self) bool {
            return self.undo_history != null or self.redo_history != null or self.curr_history != null;
        }

        pub fn clear_history(self: *Self) void {
            self.undo_history = null;
            self.redo_history = null;
            self.curr_history = null;
            self.undo_depth = 0;
        }

        pub fn clear(self: *Self) !void {
            try self.clearWithUndo(null);
        }

        pub fn clearWithUndo(self: *Self, meta: ?[]const u8) !void {
            // Prepare the empty root before publishing an undo point.
            var empty = self.*;
            empty.root = self.empty_leaf;
            try empty.applyEndsInvariant();
            if (meta) |value| try self.store_undo(value);
            self.root = empty.root;
        }

        /// Replace the rope content with new items, using same structure as from_slice
        /// This is useful for repeated setText operations without creating a new rope instance
        pub fn setSegments(self: *Self, items: []const T) !void {
            if (items.len == 0) {
                try self.clear();
                return;
            }

            self.root = try rootFromSlice(self.allocator, items);
        }
    };
}
