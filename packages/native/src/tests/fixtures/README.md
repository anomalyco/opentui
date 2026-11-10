# ICC PNG fixtures

These base64 fixtures are generated locally and contain no third-party image content.

- `display-p3.png.base64`, `display-p3-palette.png.base64`, `display-p3-palette-alpha.png.base64`, and `display-p3-rgba.png.base64` use a synthetic Display-P3 matrix with a 2.2 gamma curve.
- `srgb-profile.png.base64` uses Little CMS's generated sRGB profile.
- `gray-profile.png.base64` and `gray-alpha-profile.png.base64` use a generated D50 grayscale monitor profile with a 1.8 gamma curve.

The profiles were created with Little CMS. Expected sRGB pixels were generated independently with ImageMagick 7.1.2 and its Little CMS 2.17 delegate using relative colorimetric intent. The test vectors convert exactly to their stored RGBA8 golden values; no rounding tolerance is required for the supported native targets.

`wide-opaque.png.base64` is a generated 16,385 x 1 opaque PNG used to verify that lazy materialization preserves caller-provided decode limits.
