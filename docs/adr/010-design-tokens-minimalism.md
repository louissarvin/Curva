# ADR 010: Design Tokens Enforce Minimalism and XSS Discipline

## Context

Curva's renderer is vanilla ES modules with no framework. Its visual grammar
must feel closer to Linear or Vercel than a hackathon prototype: quiet, dense,
uniform, animate-when-necessary. Without a design system, drift is inevitable:
one component ships 6 px padding, another 10, focus rings look different per
component, motion timing is inconsistent, and accessible focus fails on
keyboard traversal.

The renderer also runs Autobase-emitted chat rows straight into the DOM. Any
component that reaches for `innerHTML` instead of `textContent` opens an XSS
vector because chat text is untrusted (a peer can append arbitrary strings).

Docs consulted:
- https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion (fetched 2026-07-10)
- https://www.w3.org/WAI/WCAG21/Understanding/focus-visible.html (fetched 2026-07-10)
- https://developer.mozilla.org/en-US/docs/Web/API/Element/textContent (fetched 2026-07-10)

## Decision

1. **Spacing scale on a 4 px grid.** Named tokens: `--space-1: 4px`,
   `--space-2: 8px`, `--space-3: 12px`, `--space-4: 16px`, `--space-6: 24px`,
   `--space-8: 32px`. Any custom padding not on this grid requires justification
   in the component's inline comment.
2. **Motion budget.** Two durations only: `150ms` for state (hover, focus,
   selection) and `300ms` for entry/exit. Easing is `ease-out` for everything.
   No bouncy `cubic-bezier` curves, no spring physics.
3. **Type scale.** Five sizes: `11px` (metadata), `13px` (body dense),
   `15px` (body default), `18px` (subheading), `24px` (heading). Font weights
   pinned to 400 (body) and 600 (emphasis). No 500, no italic body copy.
4. **Universal focus.** A single `:focus-visible` rule paints a `2px` outline
   in accent color with a `2px` offset. Applied at the document root; per-
   component overrides forbidden without accessibility review.
5. **Reduced motion.** `@media (prefers-reduced-motion: reduce)` collapses all
   transition durations to `0ms` and disables the entrance animations. This
   is a system-level user preference; the renderer honors it globally.
6. **XSS discipline as design constraint.** Chat rows, tip strings, prediction
   picks, and MCP tool output all render via `textContent` only. No component
   under `renderer/components/` may call `.innerHTML =` on untrusted content.
   Where rich formatting is required (a hyperlink from a trusted MCP result),
   the component builds DOM nodes explicitly via `document.createElement` +
   `textContent` for the label, never a template string parse.

Aesthetic target: Linear/Vercel. Dark background, neutral text, single accent
color for interactive affordances, no gradients on primary UI, no drop shadows
above `0 1px 2px`.

## Consequences

Positive:
- Components look uniform without a component library. Any new panel inherits
  the tokens by picking from the enumerated scale.
- Focus is predictable across keyboard traversal without per-component
  patches. WCAG 2.1 SC 2.4.7 passes.
- Reduced-motion is respected globally so users with vestibular sensitivity
  are not surprised by an entry animation.
- XSS surface is closed by construction: no untrusted string reaches an HTML
  parser, so a hostile peer cannot inject a `<script>` or `<img onerror>` via
  chat.

Negative:
- The type scale forbids fine-grained sizing (e.g. no 14 px). Some tabular
  data reads slightly denser than a designer would tune per-view. Acceptable
  cost for uniformity.
- No motion budget means "delightful" microinteractions (elastic drag,
  parallax on scroll) are ruled out. This is the intent.
- Contributors used to a component library (HeroUI, shadcn) must hand-write
  the DOM. Higher friction per new component; lower drift across components.

Alternatives rejected:
- **Adopt a component library.** Rejected because every ADR-adjacent
  interaction (Autobase append -> chat row) would need library-specific
  escape hatches. A vanilla DOM keeps the coupling to Autobase minimal.
- **Per-component tokens.** Rejected because that IS the drift we are
  eliminating.
- **Motion library (Framer, GSAP).** Rejected because the budget is small
  enough that native CSS transitions cover it.

## References

- https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion (fetched 2026-07-10)
- https://www.w3.org/WAI/WCAG21/Understanding/focus-visible.html (fetched 2026-07-10)
- https://developer.mozilla.org/en-US/docs/Web/API/Element/textContent (fetched 2026-07-10)
- `pear-app/renderer/styles.css` (token declarations, motion budget)
- `pear-app/renderer/components/Chat.js` (textContent-only render path)
- `pear-app/renderer/components/RoomHeader.js` (focus + type scale example)
