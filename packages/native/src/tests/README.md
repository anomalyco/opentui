# Test Suite

This directory contains the test suite for the OpenTUI Zig components.

### Run All Tests

Run this command from `packages/core`:

```bash
bun run test:native
```

## Adding New Test Files

1. Create a new `*_test.zig` file in this directory
2. Import it in `../index.zig`:
   ```zig
   const new_tests = @import("new_test.zig");
   ```
3. Update the build system if needed to include any new dependencies
