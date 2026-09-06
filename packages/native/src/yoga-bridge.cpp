#include "yoga-bridge.h"

#include <yoga/OTAllocator.h>
#include <yoga/node/Node.h>

#include <algorithm>
#include <bit>
#include <cassert>
#include <cmath>
#include <cstdio>
#include <limits>
#include <new>
#ifdef OT_YOGA_TEST_ALLOCATOR
#include <yoga/algorithm/Cache.h>
#include <yoga/algorithm/PixelGrid.h>
#include <yoga/debug/Log.h>
#include <yoga/numeric/Comparison.h>
#endif

namespace {
// Only C++ work belongs inside this guard. A Zig thunk would let an exception
// unwind through a Zig frame before arriving here.
template <typename F>
uint32_t checked(F&& operation) noexcept {
  try {
    operation();
    return OT_YOGA_OK;
  } catch (const std::bad_alloc&) {
    return OT_YOGA_OUT_OF_MEMORY;
  } catch (...) {
    return OT_YOGA_EXCEPTION;
  }
}

constexpr float undefined = std::numeric_limits<float>::quiet_NaN();

bool validValue(uint32_t kind, uint32_t edge) {
  return kind <= 10 && (kind < 7 || edge <= (kind == 10 ? YGGutterAll : YGEdgeAll));
}

facebook::yoga::StyleLength styleLength(uint32_t unit, float value) {
  using facebook::yoga::StyleLength;
  switch (unit) {
    case YGUnitPoint: return StyleLength::points(value);
    case YGUnitPercent: return StyleLength::percent(value);
    case YGUnitAuto: return StyleLength::ofAuto();
    default: return StyleLength::undefined();
  }
}

}  // namespace

uint32_t otYogaConfigCreate(YGConfigRef* out) noexcept {
  if (!out) return OT_YOGA_INVALID_ARGUMENT;
  return checked([&] { *out = YGConfigNew(); });
}

int otYogaFormatLog(uint8_t* out, uint32_t capacity, const char* format, va_list args) noexcept {
  try {
    return std::vsnprintf(reinterpret_cast<char*>(out), capacity, format, args);
  } catch (...) {
    return -1;
  }
}

uint32_t otYogaNodeCreate(YGConfigConstRef config, YGNodeRef* out) noexcept {
  if (!config || !out) return OT_YOGA_INVALID_ARGUMENT;
  return checked([&] { *out = YGNodeNewWithConfig(config); });
}

uint32_t otYogaNodeFree(YGNodeRef node) noexcept {
  if (!node) return OT_YOGA_INVALID_ARGUMENT;
  return checked([&] { YGNodeFree(node); });
}

uint32_t otYogaNodeReset(YGNodeRef node) noexcept {
  if (!node || YGNodeGetOwner(node) || YGNodeGetChildCount(node)) return OT_YOGA_INVALID_ARGUMENT;
  return checked([&] { YGNodeReset(node); });
}

uint64_t otYogaNodeStorageBytes(YGNodeConstRef node) noexcept {
  using namespace facebook::yoga;
  return sizeof(Node) + resolveRef(node)->getChildren().capacity() * sizeof(Node*);
}

uint32_t otYogaNodeCopyStyle(YGNodeRef node, YGNodeConstRef source) noexcept {
  if (!node || !source) return OT_YOGA_INVALID_ARGUMENT;
  return checked([&] { YGNodeCopyStyle(node, source); });
}

uint32_t otYogaNodeInsertChild(YGNodeRef node, YGNodeRef child, uint32_t index) noexcept {
  if (!node || !child || node == child || YGNodeGetOwner(child) || YGNodeHasMeasureFunc(node) ||
      index > YGNodeGetChildCount(node))
    return OT_YOGA_INVALID_ARGUMENT;
  return checked([&] { YGNodeInsertChild(node, child, index); });
}

uint32_t otYogaNodeMoveChild(YGNodeRef parent_ref, YGNodeRef child_ref,
                             uint32_t final_index) noexcept {
  using namespace facebook::yoga;
  if (!parent_ref || !child_ref || parent_ref == child_ref) return OT_YOGA_INVALID_ARGUMENT;
  auto parent = resolveRef(parent_ref);
  auto child = resolveRef(child_ref);
  auto previous = child->getOwner();
  if (parent->hasMeasureFunc() || (previous == parent && parent->getChildCount() == 0) ||
      final_index > parent->getChildCount() - (previous == parent))
    return OT_YOGA_INVALID_ARGUMENT;
  size_t previous_index = 0;
  if (previous) {
    const auto& children = previous->getChildren();
    const auto found = std::find(children.begin(), children.end(), child);
    if (found == children.end()) return OT_YOGA_INVALID_ARGUMENT;
    previous_index = static_cast<size_t>(found - children.begin());
    if (previous == parent && previous_index == final_index) return OT_YOGA_OK;
  }
  return checked([&] {
    // Pointer insertion cannot allocate or throw after this preparation. No
    // ownership, geometry, or dirty state changes during preparation.
    if (previous != parent) parent->prepareChildInsertion();
    if (previous) previous->removeChild(previous_index);
    parent->insertChild(child, final_index);
    child->setOwner(parent);
    static_assert(std::is_nothrow_copy_assignable_v<LayoutResults>);
    if (previous) child->setLayout({});

    // Both ancestor paths are bounded by managed placement validation. Mark
    // their complete accepted state before any managed callback can inspect it.
    Node* dirtied[2 * OT_YOGA_DEPTH_MAX];
    size_t count = 0;
    for (auto start : {previous, parent}) {
      for (auto node = start; node && !node->isDirty(); node = node->getOwner()) {
        assert(count < 2 * OT_YOGA_DEPTH_MAX);
        node->markDirtyWithoutCallback();
        dirtied[count++] = node;
      }
    }
    for (size_t index = 0; index < count; ++index) {
      if (auto callback = dirtied[index]->getDirtiedFunc()) callback(dirtied[index]);
    }
  });
}

uint32_t otYogaNodeRemoveChild(YGNodeRef node, YGNodeRef child) noexcept {
  if (!node || !child) return OT_YOGA_INVALID_ARGUMENT;
  return checked([&] { YGNodeRemoveChild(node, child); });
}

uint32_t otYogaNodeRemoveAllChildren(YGNodeRef node) noexcept {
  if (!node) return OT_YOGA_INVALID_ARGUMENT;
  return checked([&] { YGNodeRemoveAllChildren(node); });
}

uint32_t otYogaNodeCalculateLayout(YGNodeRef node, float width, float height,
                                   uint32_t direction) noexcept {
  if (!node || direction > YGDirectionRTL ||
      (!std::isnan(width) && (!std::isfinite(width) || width < 0)) ||
      (!std::isnan(height) && (!std::isfinite(height) || height < 0)))
    return OT_YOGA_INVALID_ARGUMENT;
  return checked(
      [&] { YGNodeCalculateLayout(node, width, height, static_cast<YGDirection>(direction)); });
}

uint32_t otYogaNodeMarkDirty(YGNodeRef node) noexcept {
  if (!node || !YGNodeHasMeasureFunc(node)) return OT_YOGA_INVALID_ARGUMENT;
  return checked([&] { YGNodeMarkDirty(node); });
}

uint32_t otYogaNodeSetMeasureFunc(YGNodeRef node, YGMeasureFunc callback) noexcept {
  if (!node || (callback && YGNodeGetChildCount(node))) return OT_YOGA_INVALID_ARGUMENT;
  return checked([&] { YGNodeSetMeasureFunc(node, callback); });
}

void otYogaNodeInvalidateMeasure(YGNodeRef node) noexcept {
  // No allocation or fallible Yoga operation remains after provider acceptance.
  // Managed dirtied callbacks contain host errors before returning here.
  facebook::yoga::resolveRef(node)->markDirtyAndPropagate();
}

uint32_t otYogaNodeGetComputedLayout(YGNodeConstRef node, OTYogaLayout* out) noexcept {
  if (!node || !out) return OT_YOGA_INVALID_ARGUMENT;
  return checked([&] {
    *out = {YGNodeLayoutGetLeft(node),   YGNodeLayoutGetTop(node),   YGNodeLayoutGetRight(node),
            YGNodeLayoutGetBottom(node), YGNodeLayoutGetWidth(node), YGNodeLayoutGetHeight(node)};
  });
}

uint32_t otYogaNodeLayoutGetEdge(YGNodeConstRef node, uint32_t kind, uint32_t edge,
                                 float* out) noexcept {
  if (!node || !out || kind > 2 || edge > YGEdgeEnd) return OT_YOGA_INVALID_ARGUMENT;
  return checked([&] {
    const auto e = static_cast<YGEdge>(edge);
    switch (kind) {
      case 0: *out = YGNodeLayoutGetMargin(node, e); break;
      case 1: *out = YGNodeLayoutGetPadding(node, e); break;
      case 2: *out = YGNodeLayoutGetBorder(node, e); break;
    }
  });
}

uint32_t otYogaNodeStyleSetEnum(YGNodeRef node, uint32_t kind, uint32_t value) noexcept {
  constexpr uint32_t maxima[] = {
      YGDirectionRTL,     YGFlexDirectionRowReverse, YGJustifySpaceEvenly,   YGAlignSpaceEvenly,
      YGAlignSpaceEvenly, YGAlignSpaceEvenly,        YGPositionTypeAbsolute, YGWrapWrapReverse,
      YGOverflowScroll,   YGDisplayContents,         YGBoxSizingContentBox};
  if (!node || kind >= sizeof(maxima) / sizeof(maxima[0]) || value > maxima[kind])
    return OT_YOGA_INVALID_ARGUMENT;
  return checked([&] {
    switch (kind) {
      case 0: YGNodeStyleSetDirection(node, static_cast<YGDirection>(value)); break;
      case 1: YGNodeStyleSetFlexDirection(node, static_cast<YGFlexDirection>(value)); break;
      case 2: YGNodeStyleSetJustifyContent(node, static_cast<YGJustify>(value)); break;
      case 3: YGNodeStyleSetAlignContent(node, static_cast<YGAlign>(value)); break;
      case 4: YGNodeStyleSetAlignItems(node, static_cast<YGAlign>(value)); break;
      case 5: YGNodeStyleSetAlignSelf(node, static_cast<YGAlign>(value)); break;
      case 6: YGNodeStyleSetPositionType(node, static_cast<YGPositionType>(value)); break;
      case 7: YGNodeStyleSetFlexWrap(node, static_cast<YGWrap>(value)); break;
      case 8: YGNodeStyleSetOverflow(node, static_cast<YGOverflow>(value)); break;
      case 9: YGNodeStyleSetDisplay(node, static_cast<YGDisplay>(value)); break;
      case 10: YGNodeStyleSetBoxSizing(node, static_cast<YGBoxSizing>(value)); break;
    }
  });
}

uint32_t otYogaNodeStyleGetEnum(YGNodeConstRef node, uint32_t kind, uint32_t* out) noexcept {
  if (!node || !out || kind > 10) return OT_YOGA_INVALID_ARGUMENT;
  return checked([&] {
    switch (kind) {
      case 0: *out = YGNodeStyleGetDirection(node); break;
      case 1: *out = YGNodeStyleGetFlexDirection(node); break;
      case 2: *out = YGNodeStyleGetJustifyContent(node); break;
      case 3: *out = YGNodeStyleGetAlignContent(node); break;
      case 4: *out = YGNodeStyleGetAlignItems(node); break;
      case 5: *out = YGNodeStyleGetAlignSelf(node); break;
      case 6: *out = YGNodeStyleGetPositionType(node); break;
      case 7: *out = YGNodeStyleGetFlexWrap(node); break;
      case 8: *out = YGNodeStyleGetOverflow(node); break;
      case 9: *out = YGNodeStyleGetDisplay(node); break;
      case 10: *out = YGNodeStyleGetBoxSizing(node); break;
    }
  });
}

uint32_t otYogaNodeStyleSetFloat(YGNodeRef node, uint32_t kind, float value) noexcept {
  if (!node || kind > 3 || std::isinf(value)) return OT_YOGA_INVALID_ARGUMENT;
  return checked([&] {
    switch (kind) {
      case 0: YGNodeStyleSetFlex(node, value); break;
      case 1: YGNodeStyleSetFlexGrow(node, value); break;
      case 2: YGNodeStyleSetFlexShrink(node, value); break;
      case 3: YGNodeStyleSetAspectRatio(node, value); break;
    }
  });
}

uint32_t otYogaNodeStyleGetFloat(YGNodeConstRef node, uint32_t kind, float* out) noexcept {
  if (!node || !out || kind > 3) return OT_YOGA_INVALID_ARGUMENT;
  return checked([&] {
    switch (kind) {
      case 0: *out = YGNodeStyleGetFlex(node); break;
      case 1: *out = YGNodeStyleGetFlexGrow(node); break;
      case 2: *out = YGNodeStyleGetFlexShrink(node); break;
      case 3: *out = YGNodeStyleGetAspectRatio(node); break;
    }
  });
}

uint32_t otYogaNodeStyleSetBorder(YGNodeRef node, uint32_t edge, float value) noexcept {
  if (!node || edge > YGEdgeAll || std::isinf(value)) return OT_YOGA_INVALID_ARGUMENT;
  return checked([&] { YGNodeStyleSetBorder(node, static_cast<YGEdge>(edge), value); });
}

uint32_t otYogaNodeStyleGetBorder(YGNodeConstRef node, uint32_t edge, float* out) noexcept {
  if (!node || !out || edge > YGEdgeAll) return OT_YOGA_INVALID_ARGUMENT;
  return checked([&] { *out = YGNodeStyleGetBorder(node, static_cast<YGEdge>(edge)); });
}

uint32_t otYogaNodeStyleSetDimension(YGNodeRef ref, uint32_t kind, uint32_t unit, float value,
                                     uint32_t disable_flex_shrink) noexcept {
  using namespace facebook::yoga;
  if (!ref || kind > 1 || unit > YGUnitAuto || std::isinf(value) || disable_flex_shrink > 1)
    return OT_YOGA_INVALID_ARGUMENT;
  return checked([&] {
    auto node = resolveRef(ref);
    const auto dimension = static_cast<Dimension>(kind);
    const auto length = styleLength(unit, value);
    if (node->style().dimension(dimension) == length &&
        (!disable_flex_shrink || node->style().flexShrink() == FloatOptional{0}))
      return;
    node->updateStyle([&](Style& next) {
      next.setDimension(dimension, length);
      if (disable_flex_shrink) next.setFlexShrink(FloatOptional{0});
    });
  });
}

uint32_t otYogaNodeStyleSetPositions(YGNodeRef ref, uint32_t edge_mask, const uint32_t units[4],
                                     const float values[4]) noexcept {
  using namespace facebook::yoga;
  if (!ref || !units || !values || (edge_mask & ~15u)) return OT_YOGA_INVALID_ARGUMENT;
  for (uint32_t edge = 0; edge < 4; ++edge) {
    if ((edge_mask & (1u << edge)) && (units[edge] > YGUnitAuto || std::isinf(values[edge])))
      return OT_YOGA_INVALID_ARGUMENT;
  }
  return checked([&] {
    auto node = resolveRef(ref);
    StyleLength lengths[4];
    bool changed = false;
    for (uint32_t edge = 0; edge < 4; ++edge) {
      if (!(edge_mask & (1u << edge))) continue;
      lengths[edge] = styleLength(units[edge], values[edge]);
      changed |= node->style().position(static_cast<Edge>(edge)) != lengths[edge];
    }
    if (!changed) return;
    node->updateStyle([&](Style& next) {
      for (uint32_t edge = 0; edge < 4; ++edge) {
        if (edge_mask & (1u << edge)) next.setPosition(static_cast<Edge>(edge), lengths[edge]);
      }
    });
  });
}

uint32_t otYogaNodeStyleSetValue(YGNodeRef node, uint32_t kind, uint32_t edge, uint32_t unit,
                                 float value) noexcept {
  if (!node || !validValue(kind, edge) || unit > YGUnitAuto || std::isinf(value) ||
      (unit == YGUnitAuto && ((kind >= 2 && kind <= 5) || kind == 8 || kind == 10)))
    return OT_YOGA_INVALID_ARGUMENT;
  return checked([&] {
    if (unit == YGUnitUndefined) value = undefined;
    const auto e = static_cast<YGEdge>(edge);
    const auto g = static_cast<YGGutter>(edge);
    switch (kind) {
      case 0:
        if (unit == YGUnitAuto)
          YGNodeStyleSetWidthAuto(node);
        else if (unit == YGUnitPercent)
          YGNodeStyleSetWidthPercent(node, value);
        else
          YGNodeStyleSetWidth(node, value);
        break;
      case 1:
        if (unit == YGUnitAuto)
          YGNodeStyleSetHeightAuto(node);
        else if (unit == YGUnitPercent)
          YGNodeStyleSetHeightPercent(node, value);
        else
          YGNodeStyleSetHeight(node, value);
        break;
      case 2:
        if (unit == YGUnitPercent)
          YGNodeStyleSetMinWidthPercent(node, value);
        else
          YGNodeStyleSetMinWidth(node, value);
        break;
      case 3:
        if (unit == YGUnitPercent)
          YGNodeStyleSetMinHeightPercent(node, value);
        else
          YGNodeStyleSetMinHeight(node, value);
        break;
      case 4:
        if (unit == YGUnitPercent)
          YGNodeStyleSetMaxWidthPercent(node, value);
        else
          YGNodeStyleSetMaxWidth(node, value);
        break;
      case 5:
        if (unit == YGUnitPercent)
          YGNodeStyleSetMaxHeightPercent(node, value);
        else
          YGNodeStyleSetMaxHeight(node, value);
        break;
      case 6:
        if (unit == YGUnitAuto)
          YGNodeStyleSetFlexBasisAuto(node);
        else if (unit == YGUnitPercent)
          YGNodeStyleSetFlexBasisPercent(node, value);
        else
          YGNodeStyleSetFlexBasis(node, value);
        break;
      case 7:
        if (unit == YGUnitAuto)
          YGNodeStyleSetMarginAuto(node, e);
        else if (unit == YGUnitPercent)
          YGNodeStyleSetMarginPercent(node, e, value);
        else
          YGNodeStyleSetMargin(node, e, value);
        break;
      case 8:
        if (unit == YGUnitPercent)
          YGNodeStyleSetPaddingPercent(node, e, value);
        else
          YGNodeStyleSetPadding(node, e, value);
        break;
      case 9:
        if (unit == YGUnitAuto)
          YGNodeStyleSetPositionAuto(node, e);
        else if (unit == YGUnitPercent)
          YGNodeStyleSetPositionPercent(node, e, value);
        else
          YGNodeStyleSetPosition(node, e, value);
        break;
      case 10:
        if (unit == YGUnitPercent)
          YGNodeStyleSetGapPercent(node, g, value);
        else
          YGNodeStyleSetGap(node, g, value);
        break;
    }
  });
}

uint32_t otYogaNodeStyleGetValue(YGNodeConstRef node, uint32_t kind, uint32_t edge,
                                 uint64_t* out) noexcept {
  if (!node || !out || !validValue(kind, edge)) return OT_YOGA_INVALID_ARGUMENT;
  return checked([&] {
    YGValue value{};
    const auto e = static_cast<YGEdge>(edge);
    switch (kind) {
      case 0: value = YGNodeStyleGetWidth(node); break;
      case 1: value = YGNodeStyleGetHeight(node); break;
      case 2: value = YGNodeStyleGetMinWidth(node); break;
      case 3: value = YGNodeStyleGetMinHeight(node); break;
      case 4: value = YGNodeStyleGetMaxWidth(node); break;
      case 5: value = YGNodeStyleGetMaxHeight(node); break;
      case 6: value = YGNodeStyleGetFlexBasis(node); break;
      case 7: value = YGNodeStyleGetMargin(node, e); break;
      case 8: value = YGNodeStyleGetPadding(node, e); break;
      case 9: value = YGNodeStyleGetPosition(node, e); break;
      case 10:
        value.value = YGNodeStyleGetGap(node, static_cast<YGGutter>(edge));
        value.unit = std::isnan(value.value) ? YGUnitUndefined : YGUnitPoint;
        break;
    }
    *out = (static_cast<uint64_t>(std::bit_cast<uint32_t>(value.value)) << 32) | value.unit;
  });
}

uint32_t otYogaNodeSetFlag(YGNodeRef node, uint32_t kind, uint32_t value) noexcept {
  if (!node || kind > 2 || value > 1) return OT_YOGA_INVALID_ARGUMENT;
  return checked([&] {
    switch (kind) {
      case 0: YGNodeSetHasNewLayout(node, value); break;
      case 1: YGNodeSetIsReferenceBaseline(node, value); break;
      case 2: YGNodeSetAlwaysFormsContainingBlock(node, value); break;
    }
  });
}

#ifdef OT_YOGA_TEST_ALLOCATOR
void otYogaTestFailAfter(int64_t allocations) noexcept {
  facebook::yoga::ot::failAfter = allocations;
  facebook::yoga::ot::allocationCount = 0;
}
uint64_t otYogaTestAllocationCount() noexcept { return facebook::yoga::ot::allocationCount; }
uint32_t otYogaTestContentsChildCount(YGNodeConstRef node) noexcept {
  return static_cast<uint32_t>(facebook::yoga::resolveRef(node)->contentsChildCountForTest());
}
void otYogaTestLogMessage(YGConfigConstRef config, const char* message) noexcept {
  facebook::yoga::log(facebook::yoga::resolveRef(config), facebook::yoga::LogLevel::Warn, "%s",
                      message);
}

// Independent eager reference for Yoga 3.2.1 Cache.cpp's per-axis predicate.
static bool cacheAxisReference(const OTYogaCacheAxis& axis, float point_scale) {
  using namespace facebook::yoga;
  const float effective = point_scale != 0
      ? roundValueToPixelGrid(axis.available, point_scale, false, false) : axis.available;
  const float last_effective = point_scale != 0
      ? roundValueToPixelGrid(axis.last_available, point_scale, false, false) : axis.last_available;
  const auto mode = static_cast<SizingMode>(axis.mode);
  const auto last_mode = static_cast<SizingMode>(axis.last_mode);
  const float size = axis.available - axis.margin;
  return (last_mode == mode && inexactEquals(last_effective, effective)) ||
      (mode == SizingMode::StretchFit && inexactEquals(size, axis.computed)) ||
      (mode == SizingMode::FitContent && last_mode == SizingMode::MaxContent &&
       (size >= axis.computed || inexactEquals(size, axis.computed))) ||
      (last_mode == SizingMode::FitContent && mode == SizingMode::FitContent &&
       isDefined(axis.last_available) && isDefined(size) && isDefined(axis.computed) &&
       axis.last_available > size &&
       (axis.computed <= size || inexactEquals(size, axis.computed)));
}

uint32_t otYogaTestCacheMeasurement(const OTYogaCacheAxis* width, const OTYogaCacheAxis* height,
                                    float point_scale, uint32_t* reference,
                                    uint32_t* rounding_count) noexcept {
  using namespace facebook::yoga;
  Config config(nullptr);
  config.setPointScaleFactor(point_scale);
  testPixelGridRoundCount = 0;
  const bool actual = canUseCachedMeasurement(
      static_cast<SizingMode>(width->mode), width->available,
      static_cast<SizingMode>(height->mode), height->available,
      static_cast<SizingMode>(width->last_mode), width->last_available,
      static_cast<SizingMode>(height->last_mode), height->last_available,
      width->computed, height->computed, width->margin, height->margin, &config);
  *rounding_count = testPixelGridRoundCount;
  const bool width_matches = cacheAxisReference(*width, point_scale);
  const bool height_matches = cacheAxisReference(*height, point_scale);
  *reference = !((isDefined(height->computed) && height->computed < 0) ||
                 (isDefined(width->computed) && width->computed < 0)) &&
      width_matches && height_matches;
  return actual;
}
#endif
