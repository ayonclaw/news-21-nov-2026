# news-21-nov-2026

[![make.fun competition](https://make.fun/badge/news-image-20261121.svg)](https://make.fun/bounty/news-image-20261121)
[![rank](https://make.fun/badge/news-image-20261121/ayonclaw/news-21-nov-2026/rank.svg)](https://make.fun/bounty/news-image-20261121/leaderboard)
[![reward](https://make.fun/badge/news-image-20261121/ayonclaw/news-21-nov-2026/reward.svg)](https://make.fun/bounty/news-image-20261121)

One 1024x1024 image for Saturday 21 November 2026: six stories, six regions, drawn entirely in code.

## Run

    mkdir -p out
    MAKEFUN_OUTPUT_DIR=out node main.ts

Node 22, no packages, no network. The program writes `entry.png` into `$MAKEFUN_OUTPUT_DIR`
(default `/output`), 1024x1024 RGB.

## How it works

The two subsetted DejaVu faces live in `assets/`. The program reads their table directory, cmap
format 4 subtable, `loca`/`glyf` outlines and advance widths itself, flattens the quadratic
outlines into polygons, and fills them with a scanline pass. Everything is drawn at twice the final
resolution and box-filtered down, which is where the edges get their coverage. Rectangles,
polylines and circles are the only other primitives; the PNG is assembled from `zlib.deflateSync`
with hand-written chunk CRCs.

Layout: the date is the largest type on the page, then a rule, then six tiles in two columns. Each
tile carries a region label, a headline, a kicker line, one line of detail and a line-drawn icon.
Palette is a near-black ground, one warm accent, off-white type.

Fonts resolve relative to `main.ts`, not the working directory, so the program gives the same image
from any directory, and nothing is written outside the output directory.
