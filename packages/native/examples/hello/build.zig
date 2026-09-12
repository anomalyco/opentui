const std = @import("std");
const builtin = @import("builtin");

pub fn build(b: *std.Build) void {
    var default_target = b.graph.host.query;
    if (builtin.os.tag == .linux) {
        default_target.abi = .musl;
        default_target.glibc_version = null;
    }
    const target = b.standardTargetOptions(.{ .default_target = default_target });
    const optimize = b.standardOptimizeOption(.{});
    const opentui = b.dependency("opentui", .{
        .target = target,
        .optimize = optimize,
    });

    const module = b.createModule(.{
        .root_source_file = b.path("src/main.zig"),
        .target = target,
        .optimize = optimize,
    });
    module.addImport("opentui", opentui.module("opentui"));

    const executable = b.addExecutable(.{
        .name = "opentui-hello",
        .root_module = module,
    });
    b.installArtifact(executable);

    const run = b.addRunArtifact(executable);
    run.step.dependOn(b.getInstallStep());
    const run_step = b.step("run", "Render two frames without JavaScript");
    run_step.dependOn(&run.step);

    const test_module = b.createModule(.{
        .root_source_file = b.path("src/acceptance_test.zig"),
        .target = target,
        .optimize = optimize,
    });
    test_module.addImport("opentui", opentui.module("opentui"));
    const tests = b.addTest(.{
        .root_module = test_module,
        .filters = if (b.option([]const u8, "test-filter", "Skip tests that do not match filter")) |f| &.{f} else &.{},
    });
    const run_tests = b.addRunArtifact(tests);
    const test_step = b.step("test", "Run no-JavaScript acceptance tests");
    test_step.dependOn(&run_tests.step);
}
