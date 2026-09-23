#pragma once

#include <stdint.h>
#include <yoga/Yoga.h>

#define OT_YOGA_LOG_BUFFER_SIZE 4096
#define OT_YOGA_DEPTH_MAX 256

#ifdef __cplusplus
#define OT_YOGA_NOEXCEPT noexcept
extern "C" {
#else
#define OT_YOGA_NOEXCEPT
#endif

enum {
  OT_YOGA_OK = 0,
  OT_YOGA_INVALID_ARGUMENT = 1,
  OT_YOGA_OUT_OF_MEMORY = 2,
  OT_YOGA_EXCEPTION = 3,
  OT_YOGA_POISONED = 4,
  OT_YOGA_BUSY = 5,
  OT_YOGA_DEPTH_LIMIT = 6,
};

typedef struct {
  float left, top, right, bottom, width, height;
} OTYogaLayout;

uint32_t otYogaConfigCreate(YGConfigRef* out) OT_YOGA_NOEXCEPT;
int otYogaFormatLog(uint8_t* out, uint32_t capacity, const char* format,
                    va_list args) OT_YOGA_NOEXCEPT;
uint32_t otYogaNodeCreate(YGConfigConstRef config, YGNodeRef* out) OT_YOGA_NOEXCEPT;
uint32_t otYogaNodeFree(YGNodeRef node) OT_YOGA_NOEXCEPT;
uint32_t otYogaNodeReset(YGNodeRef node) OT_YOGA_NOEXCEPT;
uint64_t otYogaNodeStorageBytes(YGNodeConstRef node) OT_YOGA_NOEXCEPT;
uint32_t otYogaNodeCopyStyle(YGNodeRef node, YGNodeConstRef source) OT_YOGA_NOEXCEPT;
uint32_t otYogaNodeInsertChild(YGNodeRef node, YGNodeRef child, uint32_t index) OT_YOGA_NOEXCEPT;
uint32_t otYogaNodeMoveChild(YGNodeRef parent, YGNodeRef child,
                             uint32_t final_index) OT_YOGA_NOEXCEPT;
uint32_t otYogaNodeRemoveChild(YGNodeRef node, YGNodeRef child) OT_YOGA_NOEXCEPT;
uint32_t otYogaNodeRemoveAllChildren(YGNodeRef node) OT_YOGA_NOEXCEPT;
uint32_t otYogaNodeCalculateLayout(YGNodeRef node, float width, float height,
                                   uint32_t direction) OT_YOGA_NOEXCEPT;
uint32_t otYogaNodeMarkDirty(YGNodeRef node) OT_YOGA_NOEXCEPT;
uint32_t otYogaNodeSetMeasureFunc(YGNodeRef node, YGMeasureFunc callback) OT_YOGA_NOEXCEPT;
void otYogaNodeInvalidateMeasure(YGNodeRef node) OT_YOGA_NOEXCEPT;
uint32_t otYogaNodeGetComputedLayout(YGNodeConstRef node, OTYogaLayout* out) OT_YOGA_NOEXCEPT;
uint32_t otYogaNodeLayoutGetEdge(YGNodeConstRef node, uint32_t kind, uint32_t edge,
                                 float* out) OT_YOGA_NOEXCEPT;
uint32_t otYogaNodeStyleSetEnum(YGNodeRef node, uint32_t kind, uint32_t value) OT_YOGA_NOEXCEPT;
uint32_t otYogaNodeStyleGetEnum(YGNodeConstRef node, uint32_t kind, uint32_t* out) OT_YOGA_NOEXCEPT;
uint32_t otYogaNodeStyleSetFloat(YGNodeRef node, uint32_t kind, float value) OT_YOGA_NOEXCEPT;
uint32_t otYogaNodeStyleGetFloat(YGNodeConstRef node, uint32_t kind, float* out) OT_YOGA_NOEXCEPT;
uint32_t otYogaNodeStyleSetBorder(YGNodeRef node, uint32_t edge, float value) OT_YOGA_NOEXCEPT;
uint32_t otYogaNodeStyleGetBorder(YGNodeConstRef node, uint32_t edge, float* out) OT_YOGA_NOEXCEPT;
uint32_t otYogaNodeStyleSetValue(YGNodeRef node, uint32_t kind, uint32_t edge, uint32_t unit,
                                 float value) OT_YOGA_NOEXCEPT;
uint32_t otYogaNodeStyleSetDimension(YGNodeRef node, uint32_t kind, uint32_t unit, float value,
                                     uint32_t disable_flex_shrink) OT_YOGA_NOEXCEPT;
uint32_t otYogaNodeStyleSetPositions(YGNodeRef node, uint32_t edge_mask, const uint32_t units[4],
                                     const float values[4]) OT_YOGA_NOEXCEPT;
uint32_t otYogaNodeStyleGetValue(YGNodeConstRef node, uint32_t kind, uint32_t edge,
                                 uint64_t* out) OT_YOGA_NOEXCEPT;
uint32_t otYogaNodeSetFlag(YGNodeRef node, uint32_t kind, uint32_t value) OT_YOGA_NOEXCEPT;

// Defined only in test artifacts. No process-wide operator new replacement.
void otYogaTestFailAfter(int64_t allocations) OT_YOGA_NOEXCEPT;
uint64_t otYogaTestAllocationCount(void) OT_YOGA_NOEXCEPT;
uint32_t otYogaTestContentsChildCount(YGNodeConstRef node) OT_YOGA_NOEXCEPT;
void otYogaTestLogMessage(YGConfigConstRef config, const char* message) OT_YOGA_NOEXCEPT;
typedef struct {
  uint32_t mode, last_mode;
  float available, last_available, computed, margin;
} OTYogaCacheAxis;
uint32_t otYogaTestCacheMeasurement(const OTYogaCacheAxis* width, const OTYogaCacheAxis* height,
                                    float point_scale, uint32_t* reference,
                                    uint32_t* rounding_count) OT_YOGA_NOEXCEPT;

#ifdef __cplusplus
}
#endif
