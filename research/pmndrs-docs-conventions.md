# pmndrs docs conventions (research memo, 2026-07-12)

_Agent-researched; feeds ROADMAP Track 2.2. Sources: pmndrs/docs, react-three-fiber/docs, zustand/docs._

## How it works

pmndrs/docs is a reusable GitHub-Actions MDX site generator. Each library repo
keeps a `docs/` folder at the root; a small workflow calls the shared builder
and deploys to that repo's GitHub Pages; the site appears at
`<libname_short>.docs.pmnd.rs`. **No registration PR needed** — DNS delegation
is already wildcarded; the workflow publishing to Pages is the whole hookup.

## File conventions

- Format: `.mdx` (r3f) or `.md` (zustand) — both supported.
- Required frontmatter: `title`, `description`. Optional: `nav` (number,
  ordering within a section), `image`, `sourcecode`.
- Assets (logo, favicon, images) live inside `docs/`, referenced relatively.
- Custom components available in MDX (verified against pmndrs/docs v3 source,
  2026-08-10 — the first docs build failed on this): `<Code>`, `<Codesandbox>`,
  `<Details>`, `<Entries>`, `<Gha>`, `<Img>`, `<Intro>`, `<Keypoints>`,
  `<Link>`, `<Mermaid>`, `<People>`, `<Sandpack>`, `<Summary>`, `<Toc>`.
  There is **no** `<Note>` or `<Warning>` — use markdown blockquotes.
- Code blocks: GFM triple-backtick; Sandpack live examples supported (see r3f).

Verbatim example (r3f `docs/getting-started/introduction.mdx`):

```mdx
---
title: Introduction
description: React-three-fiber is a React renderer for three.js.
nav: 0
---
```

## Workflow (the "registration")

`.github/workflows/docs.yml`, calling the shared builder:

```yaml
name: docs
on:
  push:
    branches: [main]
  workflow_dispatch:

jobs:
  build:
    uses: pmndrs/docs/.github/workflows/build.yml@v3 # check for newer tag
    with:
      mdx: docs
      libname: Sky
      libname_short: sky
      home_redirect: /getting-started/introduction
      icon: 🌅
      github: pmndrs/sky
      discord: https://discord.gg/poimandres

  deploy:
    runs-on: ubuntu-latest
    needs: build
    permissions:
      pages: write
      id-token: write
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - id: deployment
        uses: actions/deploy-pages@v4
```

⚠️ Conflict to resolve: we already deploy the examples gallery to this repo's
GitHub Pages (`deploy-pages.yml`). One repo has ONE Pages site — the docs
workflow above and the examples deploy would fight. Options: (a) docs site owns
Pages, examples gallery becomes a subfolder of the docs artifact; (b) examples
own Pages, docs live elsewhere; (c) merge: build docs AND copy examples build
into `<docs-dist>/examples/` in one artifact. **Recommend (c).**

## Proposed docs/ tree for @pmndrs/sky

```
docs/
├── getting-started/
│   ├── introduction.mdx      nav: 0 — what/why, hero image
│   ├── installation.mdx      nav: 1 — npm i, WebGPU requirements, peer deps
│   └── your-first-sky.mdx    nav: 2 — minimal Sky + attach + update loop
├── api/
│   ├── sky.mdx               the Sky facade (constructor options + setters)
│   ├── baker.mdx             SkyAtmosphereBaker power-user surface
│   └── luts.mdx              LUT classes + resolutions
├── guides/
│   ├── haze.mdx              applyHaze / aerial perspective / policies
│   ├── planet-scale.mdx      planetCenter, radial frames, orbit views
│   ├── night-and-stars.mdx   SkyNight, moon, HDRI stars
│   └── tuning-atmosphere.mdx AtmosphereParams / presets
└── logo + favicon
```

## Uncertainties flagged

- Builder version: examples reference `build.yml@v3`; verify latest before wiring.
- Local preview: none built-in; iterate by pushing or run pmndrs/docs locally.
- Subdomain activation timing after first deploy is undocumented (~minutes).
