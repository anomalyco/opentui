import { test } from "bun:test"
import {
  inlineScene,
  keyedScene,
  optionalAttributesScene,
  optionalZIndexScene,
  refSpreadScene,
  runtimeScene,
} from "../scripts/native-scene.fixture.js"

test(`native Text assigns refs before arbitrary reactive spreads`, () => refSpreadScene())
test(`native Text resets optional JSX attributes to the default`, () => optionalAttributesScene())
test(`native JSX zIndex resets paint and hit order when a panel closes`, () => optionalZIndexScene())
test(`native Text composes styled/link children from a ref-reading literal spread`, () => inlineScene())
test(`native Text updates through JSX-runtime and Dynamic with default selection`, () => runtimeScene())
test(`native Text preserves keyed identity and defers duplicate-id destruction across reparenting`, () => keyedScene())
