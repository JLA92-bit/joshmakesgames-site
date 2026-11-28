# joshmakesgames.app

Studio homepage for Josh Makes Games (maker of Cozy Acres), served by GitHub Pages from the `main` branch.

- Source design lives in the Cozy-Farm repo under `design/studio/` (made in Claude Design).
- `CNAME` sets the custom domain `joshmakesgames.app`.
- Contact: joshmakesgames92@gmail.com

## Vic Election 2026: One Nation tracker (`/vic-election/`)

Live tracker of One Nation at the 2026 Victorian state election, served at joshmakesgames.app/vic-election/.
The `Collect Vic election results` workflow scrapes the VEC's results pages every 5 minutes
(`vic-election/collector/vec.py`), analyses them (`collector/analyse.py`) and commits `vic-election/data/`,
which GitHub Pages republishes. If the VEC changes its URL layout, set the `VEC_BASE` repository variable to
the part of a district results URL before `/results-by-district/`.
