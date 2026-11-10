import {
  InputRenderable,
  InputRenderableEvents,
  isRenderable,
  SelectRenderable,
  SelectRenderableEvents,
  TabSelectRenderable,
  TabSelectRenderableEvents,
  TextareaRenderable,
} from "@opentui/core"
import type { Instance, Props, Type } from "../types/host.js"

function initEventListeners(instance: Instance, eventName: string, listener: any, previousListener?: any) {
  if (previousListener) {
    instance.off(eventName, previousListener)
  }

  if (listener) {
    instance.on(eventName, listener)
  }
}

function setStyle(instance: Instance, styles: any, oldStyles: any) {
  if (oldStyles != null && typeof oldStyles === "object") {
    for (const styleName in oldStyles) {
      if (oldStyles.hasOwnProperty(styleName)) {
        if (styles == null || !styles.hasOwnProperty(styleName)) {
          // @ts-expect-error props are not strongly typed in the reconciler
          instance[styleName] = null
        }
      }
    }
  }

  if (styles != null && typeof styles === "object") {
    for (const styleName in styles) {
      if (styles.hasOwnProperty(styleName)) {
        const value = styles[styleName]
        const oldValue = oldStyles?.[styleName]
        if (value !== oldValue) {
          // @ts-expect-error props are not strongly typed in the reconciler
          instance[styleName] = value
        }
      }
    }
  }
}

function setProperty(instance: Instance, type: Type, propKey: string, propValue: any, oldPropValue?: any) {
  switch (propKey) {
    case "onChange":
      if (instance instanceof InputRenderable) {
        initEventListeners(instance, InputRenderableEvents.CHANGE, propValue, oldPropValue)
      } else if (instance instanceof SelectRenderable) {
        initEventListeners(instance, SelectRenderableEvents.SELECTION_CHANGED, propValue, oldPropValue)
      } else if (instance instanceof TabSelectRenderable) {
        initEventListeners(instance, TabSelectRenderableEvents.SELECTION_CHANGED, propValue, oldPropValue)
      }
      break
    case "onInput":
      if (instance instanceof InputRenderable) {
        initEventListeners(instance, InputRenderableEvents.INPUT, propValue, oldPropValue)
      }
      break
    case "onSubmit":
      if (instance instanceof InputRenderable) {
        initEventListeners(instance, InputRenderableEvents.ENTER, propValue, oldPropValue)
      } else if (instance instanceof TextareaRenderable) {
        instance.onSubmit = propValue
      }
      break
    case "onSelect":
      if (instance instanceof SelectRenderable) {
        initEventListeners(instance, SelectRenderableEvents.ITEM_SELECTED, propValue, oldPropValue)
      } else if (instance instanceof TabSelectRenderable) {
        initEventListeners(instance, TabSelectRenderableEvents.ITEM_SELECTED, propValue, oldPropValue)
      }
      break
    case "focused":
      if (isRenderable(instance)) {
        if (!!propValue) {
          instance.focus()
        } else {
          instance.blur()
        }
      }
      break
    case "style":
      setStyle(instance, propValue, oldPropValue)
      break
    case "children":
      // Skip children handling - React reconciler handles this automatically
      break
    default:
      // @ts-expect-error props are not strongly typed in the reconciler, so we need to allow dynamic property access
      instance[propKey] = propValue
  }
}

export function setInitialProperties(instance: Instance, type: Type, props: Props) {
  for (const propKey in props) {
    if (!props.hasOwnProperty(propKey)) {
      continue
    }

    const propValue = props[propKey]
    if (propValue == null) {
      continue
    }

    setProperty(instance, type, propKey, propValue)
  }
}

export function updateProperties(instance: Instance, type: Type, oldProps: Props, newProps: Props) {
  for (const propKey in oldProps) {
    const oldProp = oldProps[propKey]
    if (oldProps.hasOwnProperty(propKey) && oldProp != null && !newProps.hasOwnProperty(propKey)) {
      setProperty(instance, type, propKey, null, oldProp)
    }
  }

  for (const propKey in newProps) {
    const newProp = newProps[propKey]
    const oldProp = oldProps[propKey]

    if (newProps.hasOwnProperty(propKey) && newProp !== oldProp && (newProp != null || oldProp != null)) {
      setProperty(instance, type, propKey, newProp, oldProp)
    }
  }
}
