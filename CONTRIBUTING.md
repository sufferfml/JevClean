# Contributing to JevClean

Start with [the project map](AGENTS.md), [architecture](docs/architecture.md), and [rewrite plan](docs/renovation-plan.zh-CN.md). Keep the product small: generic IMAP, editable natural-language rules, direct Jev judgments, a single UI, and necessary local reliability/privacy.

## Setup

Use Node.js 22+ (24 LTS recommended), then `npm ci`, `npm run check`. Install Chromium with `npx playwright install chromium`, then run `npm run test:ui`. The development command rebuilds and starts the production local server: `npm run dev`.

Core/HTTP tests inject fictional providers, and the TLS IMAP test uses a temporary local certificate. Never test automatic cleanup on personal or third-party mailboxes. `npm run test:native` creates and deletes a dedicated temporary credential-store entry. Optional live semantic tests require an explicitly supplied `JEVCLEAN_JEV_KEY`; do not include them in CI or publish API keys.

## Scope and evidence

Preset and custom rules must share the same model path. Do not add a category-specific parser, sender grouping, a rule DSL, hidden business protections, cloud accounts, or an Electron shell. Typed validation, date arithmetic, identity checks, recovery receipts, and safe failure behavior belong in code.

Document changed interfaces and actual limitations. Mock correctness is not model accuracy, and server presets are not verified provider compatibility. Use synthetic examples in screenshots and label them. Do not store raw email bodies or vendor error bodies in logs, fixtures, or commits.

macOS packages use a pinned official Node archive, HTTPS checksum verification, bundled license notices, and local ad-hoc signing. Packaging requires Xcode Command Line Tools: `xcrun swiftc` builds the small AppKit launcher for macOS 13.5+, including system reopen handling. Public releases still require signing/notarization and installation testing on another device. No Windows/Linux binary release is claimed until verified.

## Pull requests

Explain the concrete user problem, resulting behavior, and relevant checks. Preserve unrelated work. Never commit local encrypted profiles, session URLs, keys, real messages, build output, or private logs.
