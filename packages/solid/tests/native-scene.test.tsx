import { test } from "bun:test"
import {
  keyedScene,
  optionalAttributesScene,
  optionalZIndexScene,
  refSpreadScene,
} from "../scripts/native-scene.fixture.js"

test(`native Text assigns refs before arbitrary reactive spreads`, () => refSpreadScene())
test(`native Text resets optional JSX attributes to the default`, () => optionalAttributesScene())
test(`native JSX zIndex resets paint and hit order when a panel closes`, () => optionalZIndexScene())
test(`native Text preserves keyed identity and defers duplicate-id destruction across reparenting`, () => keyedScene())
