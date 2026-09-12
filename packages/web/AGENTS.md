# OpenTUI Web Design Constraints

Use these rules when you add, change, or refactor a page. Show the smallest complete version of the information.

Remove an element when spacing, order, plain text, or standard HTML can do the same work.

## Content

- State what OpenTUI is in one sentence.
- Use short, factual statements. Put one idea in each paragraph or list item.
- Prefer a list to a group of feature sections.
- Use direct verbs such as "is," "uses," "writes," and "builds."
- Keep evidence close to its claim. Do not repeat a claim in the introduction, list, and footer.
- Keep navigation small and explicit.
- Do not use promotional text or unnecessary subtitles, captions, labels, and section names.

## Visual Language

- Use black text on a white background, or the dark-mode equivalent.
- Use the standard browser link color, but do not use the visited color.
- Use OpenTUI Mono as the primary typeface. Use the OpenTUI wordmark as the main brand element.
- Use whitespace and standard HTML elements to separate ideas.
- Do not add cards, panels, badges, decorative rules, gradients, shadows, rounded containers, or ornamental backgrounds.
- Do not add an element only to fill empty space.
- Use `GrayText` for structural hairlines, such as code borders and table rows.
- Use the text color for rules that carry content weight, such as table headers and callout edges.
- Use monochrome syntax highlighting. Use plain identifiers, bold keywords, gray literals, and faint gray italic comments.
- Set code blocks in the primary typeface, one step smaller than prose.
- Mark inline code with a faint translucent fill of the text color. Do not add hue or rounded corners.
- Keep article heading sizes distinct from bold body text.
- Use a translucent page background and backdrop blur for a sticky navigation header.
- If the browser does not support `backdrop-filter`, use an opaque header.

## Layout

- Use one primary left edge for the wordmark, content, navigation, and footer.
- Keep normal content in a centered column with a default maximum width of `36rem`.
- On pages with site chrome, align the content with the frame's left edge under the wordmark.
- Do not float a narrow content column in the center of that frame.
- Use a bounded `64rem` frame for site chrome and documentation navigation.
- Keep the site-chrome frame the same on every route so that navigation does not move.
- Reserve the scrollbar gutter so that centered layouts do not move.
- Center a closed interactive composition in the viewport.
- Expand a composition only when its content needs more space. Keep space on both sides.
- Do not let an expanded element move the primary left edge.
- Do not use absolute viewport coordinates for page structure.
- Do not add a horizontal offset to an element that uses the full available width.

## Responsive Behavior

- Use the narrow column for the closed state at every viewport width.
- Use a side-by-side layout only if both panes have a useful width and the layout keeps outer gutters.
- Otherwise, put media above its related text and make its width equal to the content width.
- Do not reduce the text width when stacked media opens.
- Do not let media touch a viewport edge in a desktop layout.
- Do not use a compressed desktop layout for tablet widths.
- Show side-by-side navigation only if the content keeps its reading measure.
- Otherwise, put the header links and page navigation in one `Menu` disclosure in the site header.
- Do not stack menus or allow horizontal page overflow.
- Test closed and open states at `390px`, `768px`, `1025px`, and `1440px`.
- Also test immediately below and above each layout breakpoint.

## Motion And Interaction

- Use motion only to explain a layout or state change. Keep it fast, linear, and mechanical.
- Use movement and hard clipping. Do not use fades, scaling, bounce, blur, or decorative easing.
- Give each transition one direction. Reveal right-side content from left to right, not from its center.
- Keep media and text separate during each transition. Reverse the same geometry when the interaction closes.
- Remove nonessential transitions for `prefers-reduced-motion`.
- Hide optional media until the user requests it. Use the related text as the control when the relationship is clear.
- Support pointer and keyboard input. Keep keyboard focus visible.
- Let `Escape` close temporary media.
- Keep native browser behavior unless custom behavior gives clear value.
- Do not add unnecessary controls, icons, or instructions.

## Implementation

- Build shared page primitives from these rules. Do not copy landing-page CSS into each route.
- Keep shared article styles in one stylesheet for documentation and scrollback.
- The shared styles include headings, code, tables, and callouts.
- Wrap markdown code fences and tables with shared components at build time.
- Do not use scripts to rewrite the rendered DOM.
- Use design tokens only for repeated width, spacing, type, color, and motion values.
- Keep the token set small. Each token must represent a design decision, not an isolated value.
- Use semantic HTML before a custom component.
- Keep layout rules in CSS. Do not duplicate breakpoint rules in scripts.
- Use content data only when pages share a real structure.
- Remove old styles when a shared rule replaces them.
- Do not keep compatibility styles without a current consumer.
- Preserve accessible names, focus order, contrast, and reduced-motion behavior during visual changes.

## Documentation Pages

Documentation can be dense, but it must use the same restrained design language.

- Keep navigation, search, code, tables, callouts, and hierarchy when they help the user complete a task.
- Prefer one content flow to a dashboard layout. Use borders only to show structure or state.
- Use callouts only for information that needs special attention.
- Do not force reference material into the landing page's short-list format.
- Keep prose at `36rem` inside the wider documentation column.
- Let code blocks and tables use more width only when their content needs it.
- Put overflow for wide code and tables in their containers, not on the page.
- Use the text color to mark the current navigation item. Do not use the link color.
- Show the `On this page` outline beside the frame when space is available.
- Otherwise, put the outline in a sticky disclosure bar below the site header. Name the current section in the bar.
- Use the text color for outline links and bold text for the current section.
- Reserve the link color for prose links and navigation.
- Open disclosure panels as full-height opaque layers below the site header.
- Lock page scrolling while a panel is open.
- Close a panel with `Escape`, an outside click, or a followed link.
- Use plain text for disclosure controls and remove the native summary marker.
- End each page with previous and next links.
- Use text only for the code copy control. Show it on hover or focus, and keep it visible on touch devices.
- Prefer monospace box-drawing diagrams to images. Set them in a `text` fence that starts with a box-drawing corner.
- Those fences use the article typeface at body size. They have no code frame and no copy control.

## Exceptions

Accessibility, comprehension, and task completion take priority over visual minimalism.

Add an element if its removal makes content unclear, hides state, harms navigation, or blocks access. Use the least visual treatment that solves the problem.
