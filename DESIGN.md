# Chat4NewAPI Design

## Color and type

Use porcelain (`#faf9fc`) for the light reading surface, lavender gray (`#f0edf5`) for navigation, and iris (`#5d46a3`) for primary actions and focus. The dark theme uses graphite (`#19181e`), near-black violet navigation (`#15141a`), and a lighter iris (`#c0abff`) for labels. Theme aliases keep controls, markdown, and overlays coherent.

Use native sans-serif text for the interface and a restrained serif stack for the welcome and sign-in headings. Chinese text falls back to local CJK fonts. Keep the composer and transcript on the same 748 px reading axis. Messages from the user use a soft iris tint, while assistant content is set directly on the reading surface.

## Navigation and controls

Keep recent conversations in a fixed desktop sidebar and a mobile drawer. Account actions use compact transparent controls with the same hover and focus styles. The composer anchors the conversation view. Compact model and capability controls keep space for message text. Administrators can set the shared site name, accent colour, and tab icon; visitors' theme and locale preferences remain browser-local.

## Motion

The welcome mark draws its three strokes in a single short entrance. The sign-in identity panel animates its three strokes once on arrival. New messages acknowledge arrival with a small offset and a fade. The mobile drawer travels from the edge with a short exit. Control states respond within 150–200 ms. Reduced motion removes travel and recurring decorative effects while keeping state and focus visible.
