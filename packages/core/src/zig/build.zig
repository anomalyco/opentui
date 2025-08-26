const std = @import("std");
const builtin = @import("builtin");

const SupportedZigVersion = struct {
    major: u32,
    minor: u32,
    patch: u32,
};

const SUPPORTED_ZIG_VERSIONS = [_]SupportedZigVersion{
    .{ .major = 0, .minor = 15, .patch = 1 },
};

const SupportedTarget = struct {
    cpu_arch: std.Target.Cpu.Arch,
    os_tag: std.Target.Os.Tag,
    description: []const u8,
};

const SUPPORTED_TARGETS = [_]SupportedTarget{
    .{ .cpu_arch = .x86_64, .os_tag = .linux, .description = "Linux x86_64" },
    .{ .cpu_arch = .x86_64, .os_tag = .macos, .description = "macOS x86_64 (Intel)" },
    .{ .cpu_arch = .aarch64, .os_tag = .macos, .description = "macOS aarch64 (Apple Silicon)" },
    .{ .cpu_arch = .x86_64, .os_tag = .windows, .description = "Windows x86_64" },
    .{ .cpu_arch = .aarch64, .os_tag = .windows, .description = "Windows aarch64" },
    .{ .cpu_arch = .aarch64, .os_tag = .linux, .description = "Linux aarch64" },
};

const LIB_NAME = "opentui";
const ROOT_SOURCE_FILE = "lib.zig";

fn checkZigVersion() void {
    const current_version = builtin.zig_version;
    var is_supported = false;

    for (SUPPORTED_ZIG_VERSIONS) |supported| {
        if (current_version.major == supported.major and
            current_version.minor == supported.minor and
            current_version.patch == supported.patch)
        {
            is_supported = true;
            break;
        }
    }

    if (!is_supported) {
        std.debug.print("\x1b[31mError: Unsupported Zig version {}.{}.{}\x1b[0m\n", .{
            current_version.major,
            current_version.minor,
            current_version.patch,
        });
        std.debug.print("Supported Zig versions:\n", .{});
        for (SUPPORTED_ZIG_VERSIONS) |supported| {
            std.debug.print("  - {}.{}.{}\n", .{
                supported.major,
                supported.minor,
                supported.patch,
            });
        }
        std.debug.print("\nPlease install a supported Zig version to continue.\n", .{});
        std.process.exit(1);
    }
}

pub fn build(b: *std.Build) void {
    checkZigVersion();

    const optimize = b.option(std.builtin.OptimizeMode, "optimize", "Optimization level (Debug, ReleaseFast, ReleaseSafe, ReleaseSmall)") orelse .Debug;
    const target_option = b.option([]const u8, "target", "Build for specific target (e.g., 'x86_64-linux'). If not specified, builds for all supported targets.");

    if (target_option) |target_str| {
        buildSingleTarget(b, target_str, optimize) catch |err| {
            std.debug.print("Error building target '{s}': {}\n", .{ target_str, err });
            std.process.exit(1);
        };
    } else {
        buildAllTargets(b, optimize);
    }
}

fn buildAllTargets(b: *std.Build, optimize: std.builtin.OptimizeMode) void {
    for (SUPPORTED_TARGETS) |supported_target| {
        const target_query = std.Target.Query{
            .cpu_arch = supported_target.cpu_arch,
            .os_tag = supported_target.os_tag,
        };

        buildTargetFromQuery(b, target_query, supported_target.description, optimize) catch |err| {
            std.debug.print("Failed to build target {s}: {}\n", .{ supported_target.description, err });
            continue;
        };
    }
}

fn buildSingleTarget(b: *std.Build, target_str: []const u8, optimize: std.builtin.OptimizeMode) !void {
    const target_query = try std.Target.Query.parse(.{ .arch_os_abi = target_str });
    const description = try std.fmt.allocPrint(b.allocator, "Custom target: {s}", .{target_str});
    try buildTargetFromQuery(b, target_query, description, optimize);
}

fn buildTargetFromQuery(
    b: *std.Build,
    target_query: std.Target.Query,
    description: []const u8,
    optimize: std.builtin.OptimizeMode,
) !void {
    const target = b.resolveTargetQuery(target_query);
    var target_output: *std.Build.Step.Compile = undefined;

    const module = b.addModule(LIB_NAME, .{
        .root_source_file = b.path(ROOT_SOURCE_FILE),
        .target = target,
        .optimize = optimize,
        .link_libc = false,
    });
    target_output = b.addLibrary(.{
        .name = LIB_NAME,
        .root_module = module,
        .linkage = .dynamic,
    });

    const target_name = try createTargetName(b.allocator, target.result);
    defer b.allocator.free(target_name);

    const install_dir = b.addInstallArtifact(target_output, .{
        .dest_dir = .{
            .override = .{
                .custom = try std.fmt.allocPrint(b.allocator, "../lib/{s}", .{target_name}),
            },
        },
    });

    const build_step_name = try std.fmt.allocPrint(b.allocator, "build-{s}", .{target_name});
    const build_step = b.step(build_step_name, try std.fmt.allocPrint(b.allocator, "Build for {s}", .{description}));
    build_step.dependOn(&install_dir.step);

    b.getInstallStep().dependOn(&install_dir.step);
}

fn createTargetName(allocator: std.mem.Allocator, target: std.Target) ![]u8 {
    return std.fmt.allocPrint(
        allocator,
        "{s}-{s}",
        .{
            @tagName(target.cpu.arch),
            @tagName(target.os.tag),
        },
    );
}
