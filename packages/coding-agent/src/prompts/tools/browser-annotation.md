Browser annotation{{#if multiple}} {{index}}/{{count}}{{/if}} from tab "{{annotation.tab}}":
{{annotation.text}}
{{#if annotation.screenshotPath}}
Screenshot: {{annotation.screenshotPath}}
The viewport screenshot is attached as an image; numbered red boxes match the [n] regions above. Look at it for visual feedback (layout, colors, borders). If the inline image is no longer in context, `read` the screenshot path.
{{else}}
The viewport screenshot is attached as an image; numbered red boxes match the [n] regions above. Look at it for visual feedback (layout, colors, borders).
{{/if}}
