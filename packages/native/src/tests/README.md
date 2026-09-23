# Test Suite

This directory contains the test suite for the OpenTUI Zig components.

### Run All Tests

Run this command from `packages/core`:

```bash
bun run test:native
```

### Measure-target lifetime

The default suite already checks that destroying a view or buffer clears
matching Yoga measure targets, then layouts again. For allocator accounting on
that same C export path, run:

```bash
bun run test:native:lifetime
```

That Debug probe turns on GPA leak checks and fails if requested bytes grow
across teardown cycles. Use it after Yoga ownership or measure-target lifetime
changes.

## Adding New Test Files

1. Create a new `*_test.zig` file in this directory
2. Import it in `../index.zig`:
   ```zig
   const new_tests = @import("new_test.zig");
   ```
3. Update the build system if needed to include any new dependencies
