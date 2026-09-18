const std = @import("std");
const builtin = @import("builtin");

const SupportedZigVersion = struct {
    major: u32,
    minor: u32,
    patch: u32,
};

const SUPPORTED_ZIG_VERSIONS = [_]SupportedZigVersion{
    .{ .major = 0, .minor = 16, .patch = 0 },
};

const SupportedTarget = struct {
    zig_target: []const u8,
    output_name: []const u8,
    description: []const u8,
};

// Unpinned linux-gnu targets can bind host libm symbols such as GLIBC_2.29.
const SUPPORTED_TARGETS = [_]SupportedTarget{
    .{ .zig_target = "x86_64-linux-gnu.2.17", .output_name = "x86_64-linux", .description = "Linux x86_64" },
    .{ .zig_target = "aarch64-linux-gnu.2.17", .output_name = "aarch64-linux", .description = "Linux aarch64" },
    .{ .zig_target = "x86_64-linux-musl", .output_name = "x86_64-linux-musl", .description = "Linux x86_64 (musl)" },
    .{ .zig_target = "aarch64-linux-musl", .output_name = "aarch64-linux-musl", .description = "Linux aarch64 (musl)" },
    .{ .zig_target = "x86_64-macos.13.0", .output_name = "x86_64-macos", .description = "macOS x86_64 (Intel)" },
    .{ .zig_target = "aarch64-macos.13.0", .output_name = "aarch64-macos", .description = "macOS aarch64 (Apple Silicon)" },
    .{ .zig_target = "x86_64-freebsd", .output_name = "x86_64-freebsd", .description = "FreeBSD x86_64" },
    .{ .zig_target = "aarch64-freebsd", .output_name = "aarch64-freebsd", .description = "FreeBSD aarch64" },
    .{ .zig_target = "x86_64-windows-gnu", .output_name = "x86_64-windows", .description = "Windows x86_64" },
    .{ .zig_target = "aarch64-windows-gnu", .output_name = "aarch64-windows", .description = "Windows aarch64" },
};

const DEFAULT_MACOS_SDK_PATH = "/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk";

const LIB_NAME = "opentui";
const ROOT_SOURCE_FILE = "src/lib.zig";
const GHOSTTY_VT_VERSION = "0.1.0-dev+b988efcf";

const YOGA_CXX_FLAGS = [_][]const u8{
    "-std=c++20",
    "-fexceptions",
    "-frtti",
};

const YOGA_CXX_SOURCES = [_][]const u8{
    "yoga/YGConfig.cpp",
    "yoga/YGEnums.cpp",
    "yoga/YGNode.cpp",
    "yoga/YGNodeLayout.cpp",
    "yoga/YGNodeStyle.cpp",
    "yoga/YGPixelGrid.cpp",
    "yoga/YGValue.cpp",
    "yoga/algorithm/AbsoluteLayout.cpp",
    "yoga/algorithm/Baseline.cpp",
    "yoga/algorithm/Cache.cpp",
    "yoga/algorithm/CalculateLayout.cpp",
    "yoga/algorithm/FlexLine.cpp",
    "yoga/algorithm/PixelGrid.cpp",
    "yoga/config/Config.cpp",
    "yoga/debug/AssertFatal.cpp",
    "yoga/debug/Log.cpp",
    "yoga/event/event.cpp",
    "yoga/node/LayoutResults.cpp",
    "yoga/node/Node.cpp",
};

const LCMS2_SOURCES = [_][]const u8{
    "src/cmsalpha.c",
    "src/cmscam02.c",
    "src/cmscgats.c",
    "src/cmscnvrt.c",
    "src/cmserr.c",
    "src/cmsgamma.c",
    "src/cmsgmt.c",
    "src/cmshalf.c",
    "src/cmsintrp.c",
    "src/cmsio0.c",
    "src/cmsio1.c",
    "src/cmslut.c",
    "src/cmsmd5.c",
    "src/cmsmtrx.c",
    "src/cmsnamed.c",
    "src/cmsopt.c",
    "src/cmspack.c",
    "src/cmspcs.c",
    "src/cmsplugin.c",
    "src/cmsps2.c",
    "src/cmssamp.c",
    "src/cmssm.c",
    "src/cmstypes.c",
    "src/cmsvirt.c",
    "src/cmswtpnt.c",
    "src/cmsxform.c",
};

fn nativeExecutableTarget(b: *std.Build) std.Build.ResolvedTarget {
    if (builtin.os.tag != .linux) {
        return b.resolveTargetQuery(.{});
    }

    // Zig 0.16's ELF linker still fails on newer glibc startup objects that
    // ship .sframe relocations. Keep shipped libraries on linux-gnu, but use
    // musl for local native executables so test/debug/bench still work.
    var query = b.graph.host.query;
    query.abi = .musl;
    query.glibc_version = null;
    return b.resolveTargetQuery(query);
}

fn pathExists(b: *std.Build, path: []const u8) bool {
    if (path.len == 0) return false;
    std.Io.Dir.cwd().access(b.graph.io, path, .{}) catch return false;
    return true;
}

fn isMacOSSDKPath(path: []const u8) bool {
    const trimmed_path = std.mem.trimEnd(u8, path, "/");
    if (trimmed_path.len == 0) return false;

    const base_name = std.fs.path.basename(trimmed_path);
    return std.mem.startsWith(u8, base_name, "MacOSX") and std.mem.endsWith(u8, base_name, ".sdk");
}

fn macOSSDKHasFramework(b: *std.Build, sdk_path: []const u8, framework: []const u8) bool {
    return pathExists(b, b.pathJoin(&.{ sdk_path, "System", "Library", "Frameworks", b.fmt("{s}.framework", .{framework}) }));
}

fn isMacOSSDKAvailable(b: *std.Build, sdk_path: []const u8) bool {
    return isMacOSSDKPath(sdk_path) and
        pathExists(b, b.pathJoin(&.{ sdk_path, "usr", "lib" })) and
        macOSSDKHasFramework(b, sdk_path, "CoreFoundation") and
        macOSSDKHasFramework(b, sdk_path, "AppKit") and
        macOSSDKHasFramework(b, sdk_path, "Foundation") and
        macOSSDKHasFramework(b, sdk_path, "ImageIO") and
        macOSSDKHasFramework(b, sdk_path, "CoreAudio") and
        macOSSDKHasFramework(b, sdk_path, "AudioToolbox");
}

fn resolveMacOSSDKPath(b: *std.Build) ?[]const u8 {
    if (b.option([]const u8, "macos-sdk", "Path to a macOS SDK for CoreAudio headers and framework linking")) |sdk_path| {
        if (isMacOSSDKAvailable(b, sdk_path)) return sdk_path;
        std.debug.print("macOS SDK path '{s}' must be a MacOSX*.sdk with the required frameworks\n", .{sdk_path});
        return null;
    }

    const env_vars = [_][]const u8{ "SDKROOT", "MACOS_SDK_PATH", "MACOSX_SDK_PATH" };
    for (env_vars) |env_var| {
        if (b.graph.environ_map.get(env_var)) |sdk_path| {
            if (isMacOSSDKAvailable(b, sdk_path)) return sdk_path;
        }
    }

    if (builtin.os.tag == .macos and std.zig.system.darwin.isSdkInstalled(b.allocator, b.graph.io)) {
        const sdk_target = b.resolveTargetQuery(.{ .cpu_arch = .aarch64, .os_tag = .macos });
        if (std.zig.system.darwin.getSdk(b.allocator, b.graph.io, &sdk_target.result)) |sdk_path| {
            if (isMacOSSDKAvailable(b, sdk_path)) return sdk_path;
        }
    }

    if (isMacOSSDKAvailable(b, DEFAULT_MACOS_SDK_PATH)) return DEFAULT_MACOS_SDK_PATH;
    return null;
}

fn printMissingMacOSSDK(target_description: []const u8) void {
    std.debug.print(
        "macOS SDK not found for {s}. Set SDKROOT, MACOS_SDK_PATH, or -Dmacos-sdk=/path/to/MacOSX.sdk.\n",
        .{target_description},
    );
}

fn addMiniaudioShim(
    b: *std.Build,
    module: *std.Build.Module,
    target: std.Build.ResolvedTarget,
    macos_sdk_path: ?[]const u8,
) void {
    const c_flags: []const []const u8 = switch (target.result.os.tag) {
        .macos => blk: {
            const flags = b.allocator.alloc([]const u8, 4) catch @panic("OOM");
            flags[0] = "-std=c99";
            flags[1] = "-DMA_NO_RUNTIME_LINKING";
            flags[2] = "-isysroot";
            flags[3] = macos_sdk_path.?;
            break :blk flags;
        },
        else => &.{"-std=c99"},
    };

    module.addIncludePath(b.path("src"));
    module.link_libc = true;
    module.addCSourceFile(.{
        .file = b.path("src/miniaudio_shim.c"),
        .flags = c_flags,
    });
}

fn appendCFlags(b: *std.Build, base: []const []const u8, extra: []const []const u8) []const []const u8 {
    const flags = b.allocator.alloc([]const u8, base.len + extra.len) catch @panic("OOM");
    @memcpy(flags[0..base.len], base);
    @memcpy(flags[base.len..], extra);
    return flags;
}

fn addImageShim(b: *std.Build, module: *std.Build.Module, target: std.Build.ResolvedTarget, macos_sdk_path: ?[]const u8) void {
    const flags: []const []const u8 = switch (target.result.os.tag) {
        .macos => &.{ "-std=c99", "-ffp-contract=off", "-fvisibility=hidden", "-isysroot", macos_sdk_path.? },
        else => &.{ "-std=c99", "-ffp-contract=off", "-fvisibility=hidden" },
    };

    module.addCSourceFile(.{
        .file = b.path("src/image-shim.c"),
        .flags = flags,
    });
    module.addIncludePath(b.path("src/vendor/lcms2/include"));
    module.addIncludePath(b.path("src/vendor/lcms2/src"));
    module.addCSourceFiles(.{
        .root = b.path("src/vendor/lcms2"),
        .files = &LCMS2_SOURCES,
        // image.zig serializes every LittleCMS operation with icc_cache_mutex.
        .flags = flags,
    });

    // One upstream SIMD sRGB idiom forms `fp32_to_srgb8_tab4 - 912`; its
    // clamped indexes 912...1015 resolve to actual table elements 0...103.
    // The reads are in range, but the pre-array pointer trips C bounds
    // instrumentation. Disable only `bounds` for this translation unit;
    // pointer-overflow, alignment, and other sanitizers remain enabled. This
    // is separate from our coefficient-copy alignment patch. See vendor/stb/README.md.
    const resize_flags: []const []const u8 = switch (target.result.os.tag) {
        .macos => &.{ "-std=c99", "-ffp-contract=off", "-fvisibility=hidden", "-fno-sanitize=bounds", "-isysroot", macos_sdk_path.? },
        else => &.{ "-std=c99", "-ffp-contract=off", "-fvisibility=hidden", "-fno-sanitize=bounds" },
    };
    module.addCSourceFile(.{
        .file = b.path("src/image-resize-shim.c"),
        .flags = resize_flags,
    });

    const webp_flags: []const []const u8 = switch (target.result.os.tag) {
        .macos => &.{ "-std=c99", "-fvisibility=hidden", "-DWEBP_EXTERN=extern", "-isysroot", macos_sdk_path.? },
        else => &.{ "-std=c99", "-fvisibility=hidden", "-DWEBP_EXTERN=extern" },
    };
    const webp_dispatch_flags = if (target.result.cpu.arch == .x86_64)
        appendCFlags(b, webp_flags, &.{ "-DWEBP_HAVE_SSE2", "-DWEBP_HAVE_SSE41", "-DWEBP_HAVE_AVX2" })
    else
        webp_flags;
    module.addIncludePath(b.path("src/vendor/libwebp"));
    module.addCSourceFile(.{
        .file = b.path("src/image-webp-config.c"),
        .flags = webp_dispatch_flags,
    });
    module.addCSourceFiles(.{
        .root = b.path("src/vendor/libwebp"),
        .files = &.{
            "src/dec/alpha_dec.c",
            "src/dec/buffer_dec.c",
            "src/dec/frame_dec.c",
            "src/dec/idec_dec.c",
            "src/dec/io_dec.c",
            "src/dec/quant_dec.c",
            "src/dec/tree_dec.c",
            "src/dec/vp8_dec.c",
            "src/dec/vp8l_dec.c",
            "src/dec/webp_dec.c",
            "src/dsp/alpha_processing.c",
            "src/dsp/cpu.c",
            "src/dsp/dec.c",
            "src/dsp/dec_clip_tables.c",
            "src/dsp/filters.c",
            "src/dsp/lossless.c",
            "src/dsp/rescaler.c",
            "src/dsp/upsampling.c",
            "src/dsp/yuv.c",
            "src/utils/bit_reader_utils.c",
            "src/utils/color_cache_utils.c",
            "src/utils/filters_utils.c",
            "src/utils/huffman_utils.c",
            "src/utils/palette.c",
            "src/utils/quant_levels_dec_utils.c",
            "src/utils/random_utils.c",
            "src/utils/rescaler_utils.c",
            "src/utils/thread_utils.c",
            "src/utils/utils.c",
        },
        .flags = webp_dispatch_flags,
    });

    switch (target.result.cpu.arch) {
        .x86_64 => {
            module.addCSourceFiles(.{
                .root = b.path("src/vendor/libwebp"),
                .files = &.{
                    "src/dsp/alpha_processing_sse2.c",
                    "src/dsp/dec_sse2.c",
                    "src/dsp/filters_sse2.c",
                    "src/dsp/lossless_sse2.c",
                    "src/dsp/rescaler_sse2.c",
                    "src/dsp/upsampling_sse2.c",
                    "src/dsp/yuv_sse2.c",
                },
                .flags = webp_flags,
            });
            module.addCSourceFile(.{
                .file = b.path("src/image-webp-sse41.c"),
                .flags = webp_flags,
            });
            module.addCSourceFile(.{
                .file = b.path("src/image-webp-avx2.c"),
                .flags = webp_flags,
            });
        },
        .aarch64 => module.addCSourceFiles(.{
            .root = b.path("src/vendor/libwebp"),
            .files = &.{
                "src/dsp/alpha_processing_neon.c",
                "src/dsp/dec_neon.c",
                "src/dsp/filters_neon.c",
                "src/dsp/lossless_neon.c",
                "src/dsp/rescaler_neon.c",
                "src/dsp/upsampling_neon.c",
                "src/dsp/yuv_neon.c",
            },
            .flags = webp_flags,
        }),
        else => {},
    }
}

fn addMacOSSDKSearchPaths(b: *std.Build, module: *std.Build.Module, sdk_path: []const u8) void {
    const include_path = b.pathJoin(&.{ sdk_path, "usr", "include" });
    const framework_path = b.pathJoin(&.{ sdk_path, "System", "Library", "Frameworks" });
    const lib_path = b.pathJoin(&.{ sdk_path, "usr", "lib" });

    module.addSystemIncludePath(.{ .cwd_relative = include_path });
    module.addSystemFrameworkPath(.{ .cwd_relative = framework_path });
    module.addFrameworkPath(.{ .cwd_relative = framework_path });
    module.addLibraryPath(.{ .cwd_relative = lib_path });
}

fn addMacOSClipboardDependencies(b: *std.Build, module: *std.Build.Module, sdk_path: []const u8) void {
    module.addCSourceFile(.{
        .file = b.path("src/clipboard/macos-shim.m"),
        .flags = &.{ "-fobjc-arc", "-fobjc-arc-exceptions", "-isysroot", sdk_path },
    });
    module.linkFramework("AppKit", .{});
    module.linkFramework("Foundation", .{});
    module.linkFramework("ImageIO", .{});
    module.linkSystemLibrary("pthread", .{});
    addMacOSSDKSearchPaths(b, module, sdk_path);
}

fn addMacOSSystemLibraries(b: *std.Build, module: *std.Build.Module, sdk_path: []const u8) void {
    addMacOSClipboardDependencies(b, module, sdk_path);
    module.linkFramework("CoreFoundation", .{});
    module.linkFramework("CoreAudio", .{});
    module.linkFramework("AudioToolbox", .{});
}

fn addNativeAudioDependencies(
    b: *std.Build,
    module: *std.Build.Module,
    target: std.Build.ResolvedTarget,
    macos_sdk_path: ?[]const u8,
) void {
    addMiniaudioShim(b, module, target, macos_sdk_path);
    addImageShim(b, module, target, macos_sdk_path);

    switch (target.result.os.tag) {
        .macos => addMacOSSystemLibraries(b, module, macos_sdk_path.?),
        .linux => {
            module.linkSystemLibrary("dl", .{});
            module.linkSystemLibrary("pthread", .{});
            module.linkSystemLibrary("m", .{});
        },
        .freebsd => {
            module.linkSystemLibrary("pthread", .{});
            module.linkSystemLibrary("m", .{});
        },
        else => {},
    }
}

fn addYogaDependencies(b: *std.Build, module: *std.Build.Module) void {
    const yoga_dep = b.dependency("yoga", .{});

    module.link_libcpp = true;
    module.addIncludePath(yoga_dep.path(""));
    module.addCSourceFiles(.{
        .root = yoga_dep.path(""),
        .files = &YOGA_CXX_SOURCES,
        .flags = &YOGA_CXX_FLAGS,
    });
}

fn ghosttyVtAvailable(target: std.Build.ResolvedTarget) bool {
    switch (target.result.cpu.arch) {
        .x86_64, .aarch64 => {},
        else => return false,
    }
    return switch (target.result.os.tag) {
        .linux => target.result.abi.isMusl() or target.result.abi == .gnu,
        .macos => true,
        .windows => target.result.abi == .gnu,
        else => false,
    };
}

fn addTranslatedCImports(
    b: *std.Build,
    module: *std.Build.Module,
    optimize: std.builtin.OptimizeMode,
    target: std.Build.ResolvedTarget,
) void {
    const miniaudio_translate = b.addTranslateC(.{
        .root_source_file = b.path("src/vendor/miniaudio/miniaudio.h"),
        .target = target,
        .optimize = optimize,
    });
    miniaudio_translate.addIncludePath(b.path("src"));
    module.addImport("miniaudio", miniaudio_translate.createModule());

    const yoga_dep = b.dependency("yoga", .{});
    const yoga_translate = b.addTranslateC(.{
        .root_source_file = yoga_dep.path("yoga/Yoga.h"),
        .target = target,
        .optimize = optimize,
    });
    yoga_translate.addIncludePath(yoga_dep.path(""));
    module.addImport("yoga", yoga_translate.createModule());
}

/// Apply dependencies to a module
fn applyDependencies(
    b: *std.Build,
    module: *std.Build.Module,
    optimize: std.builtin.OptimizeMode,
    target: std.Build.ResolvedTarget,
    build_options: *std.Build.Step.Options,
) void {
    module.addOptions("build_options", build_options);
    addTranslatedCImports(b, module, optimize, target);

    const ghostty_vt_available = ghosttyVtAvailable(target);
    const ghostty_vt_options = b.addOptions();
    ghostty_vt_options.addOption(bool, "available", ghostty_vt_available);
    module.addOptions("ghostty_vt_options", ghostty_vt_options);
    if (ghostty_vt_available) {
        if (b.lazyDependency("ghostty", .{
            .target = target,
            .optimize = .ReleaseFast,
            // Enable once OpenTUI uses Ghostty VT at runtime. Until then,
            // Highway and simdutf only add binary size and exported symbols.
            .simd = false,
            .@"emit-lib-vt" = true,
            .@"emit-xcframework" = false,
            .@"emit-themes" = false,
            .i18n = false,
            .@"lib-version-string" = GHOSTTY_VT_VERSION,
        })) |ghostty| {
            module.addImport("ghostty_vt", ghostty.module("ghostty-vt"));
        }
    }

    // Add uucode for grapheme break detection and width calculation
    if (b.lazyDependency("uucode", .{
        .target = target,
        .optimize = optimize,
        .fields = @as([]const []const u8, &.{
            "grapheme_break",
            "east_asian_width",
            "general_category",
            "is_emoji_presentation",
        }),
        .fields_1 = @as([]const []const u8, &.{"wcwidth_zero_in_grapheme"}),
    })) |uucode_dep| {
        module.addImport("uucode", uucode_dep.module("uucode"));
    }
}

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

    const optimize = b.standardOptimizeOption(.{});
    const bench_optimize = b.option(std.builtin.OptimizeMode, "bench-optimize", "Optimize mode for benchmarks") orelse .ReleaseFast;
    const debug_use_llvm = b.option(bool, "debug-llvm", "Use LLVM backend for debug/test artifacts");
    const target_option = b.option([]const u8, "library-target", "Build shared library for a specific target (e.g., 'x86_64-linux-gnu.2.17').");
    const build_all = b.option(bool, "all", "Build for all supported targets") orelse false;
    const gpa_safe_stats = b.option(bool, "gpa-safe-stats", "Enable GPA safety checks for trustworthy allocator stats") orelse false;
    const macos_sdk_path = resolveMacOSSDKPath(b);
    const build_options = b.addOptions();
    build_options.addOption(bool, "gpa_safe_stats", gpa_safe_stats);

    const module_target = b.standardTargetOptions(.{});
    const opentui_module = b.addModule("opentui", .{
        .root_source_file = b.path("src/opentui.zig"),
        .target = module_target,
        .optimize = optimize,
    });
    applyDependencies(b, opentui_module, optimize, module_target, build_options);
    addNativeAudioDependencies(b, opentui_module, module_target, macos_sdk_path);
    addYogaDependencies(b, opentui_module);

    if (target_option) |target_str| {
        // Build single target
        buildSingleTarget(b, target_str, optimize, build_options, macos_sdk_path) catch |err| {
            std.debug.print("Error building target '{s}': {}\n", .{ target_str, err });
            std.process.exit(1);
        };
    } else if (build_all) {
        // Build all supported targets
        buildAllTargets(b, optimize, build_options, macos_sdk_path) catch |err| {
            std.debug.print("Error building all targets: {}\n", .{err});
            std.process.exit(1);
        };
    } else {
        // Build for native target only (default)
        buildNativeTarget(b, optimize, build_options, macos_sdk_path) catch |err| {
            std.debug.print("Error building native target: {}\n", .{err});
            std.process.exit(1);
        };
    }

    // Test step (native only)
    const test_step = b.step("test", "Run unit tests");
    const native_target = nativeExecutableTarget(b);
    const test_mod = b.createModule(.{
        .root_source_file = b.path("src/test.zig"),
        .target = native_target,
        .optimize = .Debug,
    });
    applyDependencies(b, test_mod, .Debug, native_target, build_options);
    const test_artifact = b.addTest(.{
        .root_module = test_mod,
        .filters = if (b.option([]const u8, "test-filter", "Skip tests that do not match filter")) |f| &.{f} else &.{},
        .use_llvm = debug_use_llvm,
    });

    if (native_target.result.os.tag == .macos and macos_sdk_path == null) {
        printMissingMacOSSDK("native macOS tests");
        std.process.exit(1);
    }
    addNativeAudioDependencies(b, test_mod, native_target, macos_sdk_path);
    addYogaDependencies(b, test_mod);

    const run_test = b.addRunArtifact(test_artifact);
    test_step.dependOn(&run_test.step);

    // Bench step (native only)
    const bench_step = b.step("bench", "Run benchmarks");
    const bench_mod = b.createModule(.{
        .root_source_file = b.path("src/bench.zig"),
        .target = native_target,
        .optimize = bench_optimize,
    });
    applyDependencies(b, bench_mod, bench_optimize, native_target, build_options);
    const bench_exe = b.addExecutable(.{
        .name = "opentui-bench",
        .root_module = bench_mod,
    });
    bench_mod.link_libc = true;
    addImageShim(b, bench_mod, native_target, macos_sdk_path);
    if (native_target.result.os.tag == .macos) addMacOSSDKSearchPaths(b, bench_mod, macos_sdk_path.?);
    const run_bench = b.addRunArtifact(bench_exe);
    if (b.args) |args| {
        run_bench.addArgs(args);
    }
    bench_step.dependOn(&run_bench.step);

    const bench_ffi_step = b.step("bench-ffi", "Build NativeSpanFeed benchmark library");
    const bench_ffi_target = b.resolveTargetQuery(.{});
    const bench_ffi_mod = b.createModule(.{
        .root_source_file = b.path("src/native-span-feed-bench-lib.zig"),
        .target = bench_ffi_target,
        .optimize = bench_optimize,
    });
    applyDependencies(b, bench_ffi_mod, bench_optimize, bench_ffi_target, build_options);
    const bench_ffi_lib = b.addLibrary(.{
        .name = "native_span_feed_bench",
        .root_module = bench_ffi_mod,
        .linkage = .dynamic,
    });
    if (bench_ffi_target.result.os.tag == .macos and macos_sdk_path == null) {
        printMissingMacOSSDK("native macOS benchmark FFI library");
        std.process.exit(1);
    }
    addNativeAudioDependencies(b, bench_ffi_mod, bench_ffi_target, macos_sdk_path);
    addYogaDependencies(b, bench_ffi_mod);
    const install_bench_ffi = b.addInstallArtifact(bench_ffi_lib, .{});
    bench_ffi_step.dependOn(&install_bench_ffi.step);
    bench_step.dependOn(bench_ffi_step);

    // Debug step (native only)
    const debug_step = b.step("debug", "Run debug executable");
    const debug_mod = b.createModule(.{
        .root_source_file = b.path("src/debug-view.zig"),
        .target = native_target,
        .optimize = .Debug,
    });
    applyDependencies(b, debug_mod, .Debug, native_target, build_options);
    const debug_exe = b.addExecutable(.{
        .name = "opentui-debug",
        .root_module = debug_mod,
        .use_llvm = debug_use_llvm,
    });
    const run_debug = b.addRunArtifact(debug_exe);
    debug_step.dependOn(&run_debug.step);
}

fn buildAllTargets(
    b: *std.Build,
    optimize: std.builtin.OptimizeMode,
    build_options: *std.Build.Step.Options,
    macos_sdk_path: ?[]const u8,
) !void {
    for (SUPPORTED_TARGETS) |supported_target| {
        try buildTarget(
            b,
            supported_target.zig_target,
            supported_target.output_name,
            supported_target.description,
            optimize,
            build_options,
            macos_sdk_path,
        );
    }
}

fn buildNativeTarget(
    b: *std.Build,
    optimize: std.builtin.OptimizeMode,
    build_options: *std.Build.Step.Options,
    macos_sdk_path: ?[]const u8,
) !void {
    // Find the matching supported target for the native platform
    const native_arch = @tagName(builtin.cpu.arch);
    const native_os = @tagName(builtin.os.tag);

    for (SUPPORTED_TARGETS) |supported_target| {
        // Check if this target matches the native platform
        if (std.mem.find(u8, supported_target.zig_target, native_arch) != null and
            std.mem.find(u8, supported_target.zig_target, native_os) != null)
        {
            try buildTarget(
                b,
                supported_target.zig_target,
                supported_target.output_name,
                supported_target.description,
                optimize,
                build_options,
                macos_sdk_path,
            );
            return;
        }
    }

    std.debug.print("No matching supported target for native platform ({s}-{s})\n", .{ native_arch, native_os });
    return error.UnsupportedNativeTarget;
}

fn buildSingleTarget(
    b: *std.Build,
    target_str: []const u8,
    optimize: std.builtin.OptimizeMode,
    build_options: *std.Build.Step.Options,
    macos_sdk_path: ?[]const u8,
) !void {
    // Check if it matches a known target, use its output_name
    for (SUPPORTED_TARGETS) |supported_target| {
        if (std.mem.eql(u8, target_str, supported_target.zig_target)) {
            try buildTarget(
                b,
                supported_target.zig_target,
                supported_target.output_name,
                supported_target.description,
                optimize,
                build_options,
                macos_sdk_path,
            );
            return;
        }
    }
    // Custom target - use target string as output name
    const description = try std.fmt.allocPrint(b.allocator, "Custom target: {s}", .{target_str});
    try buildTarget(b, target_str, target_str, description, optimize, build_options, macos_sdk_path);
}

fn buildTarget(
    b: *std.Build,
    zig_target: []const u8,
    output_name: []const u8,
    description: []const u8,
    optimize: std.builtin.OptimizeMode,
    build_options: *std.Build.Step.Options,
    macos_sdk_path: ?[]const u8,
) !void {
    const target_query = try std.Target.Query.parse(.{ .arch_os_abi = zig_target });
    const target = b.resolveTargetQuery(target_query);

    if (target.result.os.tag == .macos and macos_sdk_path == null) {
        printMissingMacOSSDK(description);
        return error.MissingMacOSSDK;
    }

    const module = b.createModule(.{
        .root_source_file = b.path(ROOT_SOURCE_FILE),
        .target = target,
        .optimize = optimize,
        // Release symbols must describe this exact optimized code. The package
        // build detaches them before stripping only the distribution copy.
        .strip = false,
    });

    applyDependencies(b, module, optimize, target, build_options);

    const lib = b.addLibrary(.{
        .name = LIB_NAME,
        .root_module = module,
        .linkage = .dynamic,
    });

    if (target.result.os.tag == .linux and optimize != .Debug) lib.build_id = .sha1;

    addNativeAudioDependencies(b, module, target, macos_sdk_path);
    addYogaDependencies(b, module);

    const install_dir = b.addInstallArtifact(lib, .{
        .dest_dir = .{
            .override = .{
                .custom = try std.fmt.allocPrint(b.allocator, "../lib/{s}", .{output_name}),
            },
        },
        .pdb_dir = if (optimize == .Debug) .default else if (target.result.os.tag == .windows) .{ .override = .{
            .custom = try std.fmt.allocPrint(b.allocator, "../lib/{s}", .{output_name}),
        } } else .disabled,
    });

    const build_step_name = try std.fmt.allocPrint(b.allocator, "build-{s}", .{output_name});
    const build_step = b.step(build_step_name, try std.fmt.allocPrint(b.allocator, "Build for {s}", .{description}));
    build_step.dependOn(&install_dir.step);

    b.getInstallStep().dependOn(&install_dir.step);
}
