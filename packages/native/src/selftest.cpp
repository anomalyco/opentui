#include <cstdint>
#include <cstring>
#include <stdexcept>

namespace {
struct Counted {
  int* destroyed;
  ~Counted() { ++*destroyed; }
};

[[gnu::noinline]] void throwFrom(int depth, int* destroyed) {
  Counted guard{destroyed};
  if (depth == 0) throw std::runtime_error("opentui selftest");
  throwFrom(depth - 1, destroyed);
}
}  // namespace

// 0 when an exception thrown three frames down runs each frame's destructor and
// is caught by its base class; nonzero otherwise.
extern "C" uint32_t otSelftestCxxException() noexcept {
  int destroyed = 0;
  try {
    throwFrom(2, &destroyed);
  } catch (const std::exception& error) {
    return destroyed != 3 || std::strcmp(error.what(), "opentui selftest") != 0;
  }
  return 1;
}
