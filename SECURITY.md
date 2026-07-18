# Security Policy

SVG Stripper runs entirely in your browser. It makes no network requests: the
SVG you paste is never uploaded, logged, or stored. Pasted SVG is rendered for
the before and after preview inside an `<img>` element, which browsers load in
a restricted mode that does not run scripts or fetch external resources, so a
hostile SVG cannot execute code or phone home through the preview. The
optimizer also removes `<script>` elements, inline event handlers, and
`javascript:` links from the output.

## Reporting a vulnerability

Please report suspected vulnerabilities privately through GitHub's
[security advisories](https://github.com/JaydenYoonZK/svg-stripper/security/advisories/new)
for this repository, or open a normal issue for anything that is not sensitive.

I aim to acknowledge reports within a few days. Thank you for helping keep the
tool safe.
