# Phase Plane Explorer

Lightweight, canvas-based phase portrait explorer for 2D systems. Enter `ẋ = f(x,y)` and `ẏ = g(x,y)`, see vector fields, nullclines, trajectories, and fixed-point/Jacobian info rendered in a KaTeX console.

## Quick Start

- Install deps: `npm install`
- Run dev server: `npm start`
- Open: http://localhost:3000

## Usage

- Equations: edit the `ẋ=` and `ẏ=` inputs. Symbols other than `x`, `y`, `t`, `e`, `pi` are treated as parameters.
- Parameters: sliders appear automatically for detected params (supports `mu` and Greek `μ`).
- Bounds/Grid: adjust domain and field resolution in the toolbar overlay.
- Seeds: click the canvas to drop a seed. Use the `Seed` button for a random seed and `Clear` to remove all.
- Animate: check “Animate”, choose a parameter, and set speed to sweep the parameter value.
- Console: shows KaTeX-rendered summaries. Commands:
  - `set <param> <value>`
  - `grid <N>` (8..200)
  - `bounds xMin xMax yMin yMax`
  - `clear` (reloads to clear console)

## Notes

- Complex eigenvalues are displayed as `a ± bi` when applicable.
- The console auto-scrolls only when you’re at the bottom, so manual scrolling is preserved.
- Built with React, mathjs, and KaTeX. Tailwind CDN is used for styling.

## Scripts

- `npm start` — run the app in development.
- `npm run build` — build a production bundle to `build/`.
