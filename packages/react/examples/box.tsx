import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"

export const App = () => {
  return (
    <>
      <box flexDirection="column">
        <text attributes={1} content="Box Examples" />
        <box border>
          <text content="1. Standard Box" />
        </box>
        <box border title="Title">
          <text content="2. Box with Title" />
        </box>
        <box border title="Colorful title" titleColor={"#ff0000"}>
          <text content="3 Box with Title" />
        </box>
        <box border borderColor="transparent" title="Colorful title" titleColor={"#ff0000"}>
          <text content="4 Box with NO borders but visible colorful title" />
        </box>
        <box border backgroundColor="blue">
          <text content="5. Box with Background Color" />
        </box>
        <box border padding={1}>
          <text content="6. Box with Padding" />
        </box>
        <box border margin={1}>
          <text content="7. Box with Margin" />
        </box>
        <box border alignItems="center">
          <text content="8. Centered Text" />
        </box>
        <box border justifyContent="center" height={5}>
          <text content="9. Justified Center" />
        </box>
        <box border title="Nested Boxes" backgroundColor="red">
          <box border backgroundColor="blue">
            <text content="10. Nested Box" />
          </box>
        </box>
      </box>
    </>
  )
}

if (import.meta.main) {
  const renderer = await createCliRenderer()
  createRoot(renderer).render(<App />)
}
