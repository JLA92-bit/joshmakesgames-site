# River Watch - Campaspe & Murray Rivers

> In this repo it lives in `river-watch/` and is served at https://joshmakesgames.app/river-watch/ . Workflows are in `.github/workflows/river-watch-*.yml` and commit data to `main`, which GitHub Pages serves directly (no Pages deploy step, no extra DNS needed).

Created by Josh Avard

A public flood-awareness site for Rochester. Every hour it records river heights and flows along the Campaspe and Murray, catchment rain and Bureau of Meteorology warnings, keeps them as open data, and compares today with past floods.

**This is an awareness and learning tool. Warnings and evacuation advice come from VicEmergency (1800 226 226, emergency.vic.gov.au) and the Bureau of Meteorology.**

## How it works

| Part | What it does | Where |
|---|---|---|
| Hourly collection | GitHub Actions runs `collector/collect.mjs` at 35 past every hour, saves new data and redeploys the site | `.github/workflows/collect.yml` |
| History back-fill | Daily levels and flows since 1970, catchment rain since 1970, and every past flood rebuilt hour by hour | `.github/workflows/backfill.yml` |
| Website | One page that reads the data files | `site/index.html` |
| Hosting | GitHub Pages, on your own domain through Cloudflare DNS | |
| Settings | Gauges, flood class levels, rain points, known floods | `config/sites.json` |

Data sources: Victorian Water Measurement Information System (DEECA) and WaterNSW (Hydstra web services), Open-Meteo forecasts and ERA5 rain history (CC BY 4.0), BoM Victorian warnings feed. Nothing needs an API key.

## Set-up (about 20 minutes)

1. **Create the repository.** On GitHub, make a new **public** repository (for example `river-watch`) and upload everything in this folder, keeping the folder structure (including the hidden `.github` folder).
2. **Allow the workflows to save data.** Settings > Actions > General > Workflow permissions > **Read and write permissions** > Save.
3. **Turn on Pages.** Settings > Pages > Build and deployment > Source: **GitHub Actions**.
4. **First run.** Actions tab > **Collect river data** > Run workflow. When it finishes (about a minute) the site is live at `https://<your-username>.github.io/river-watch/`. Open the run's log if a gauge shows a warning.
5. **Load the history.** Actions tab > **Back-fill history** > Run workflow (defaults: all, from 1970). This takes roughly 30 to 90 minutes. Afterwards the Past floods section is filled from the gauge records.

### Put it on your domain (Cloudflare)

1. GitHub: Settings > Pages > Custom domain: enter e.g. `river.yourdomain.com.au` > Save.
2. Cloudflare dashboard > your domain > DNS > Add record:
   - Type `CNAME`, Name `river`, Target `<your-username>.github.io`
   - Proxy status: **DNS only** (grey cloud) so GitHub can issue the HTTPS certificate.
3. Back in GitHub Pages, wait for the DNS check to pass, then tick **Enforce HTTPS**.
4. Optional: once HTTPS works you can switch the record to Proxied (orange cloud). If you do, set Cloudflare SSL/TLS to **Full**.

## The dataset

| File | Contents |
|---|---|
| `data/latest.json` | Latest reading, status and 7-day line for every gauge, rain outlook, warnings |
| `data/hourly/YYYY-MM/DD.csv` | Every hourly level and flow (UTC day files) |
| `data/daily/<site>.csv` | Daily highest level and mean flow since 1970 |
| `data/rain/daily.csv` | Daily rain for 13 catchment places (ERA5 history, recent model estimates) |
| `data/rain/forecasts/YYYY-MM.csv` | One forecast snapshot a day, to check forecasts against what fell |
| `data/events/index.json` and `data/events/<date>.json` | Every past flood: peaks, flows, travel times, rain before, hourly records |
| `data/warnings.csv` | Each river-related BoM warning as it appeared |
| `data/sites.csv` | Gauge list with BoM flood class levels |
| `data/storage/406219.csv` | Lake Eppalock daily level, volume and % full (volume recorded from 2018, earlier fullness estimated from level) |
| `data/soil/daily.csv` | Daily root-zone soil moisture (0 to 100 cm, ERA5) averaged for each catchment |
| `data/frequency.json` | Highest level or flow in each year (July to June) with how often each was reached |
| `data/predictions.csv` | Predicted heights read from BoM flood warnings, kept to check against what happened |

Past floods are found automatically: any time Rochester Town, Rochester Syphon, Echuca (Campaspe) or Echuca Wharf went over the minor flood level. Known floods in `curatedEvents` (January 2011, October 2022, January 2024) add names, notes and the peaks reported at the time.

## What the analysis adds (not official forecasts)

`collector/insights.mjs` works out, every hour:

- **Rate of rise** over the last 6 hours and the time to each flood level at that rate.
- **Travel times** between gauges from the site's own past floods, and when an upstream gauge is high, what followed downstream in the three most similar floods.
- **BoM predicted heights**, read from the text of current flood warnings and drawn on the hero chart.
- **Catchment state**: Lake Eppalock fullness, soil wetness as a percentile of the same month since 1970, and the Murray and Campaspe side by side at Echuca.
- **Conditions now vs the week before each past flood** (rain, lake, soil).
- **How unusual** today's level or flow is, from the yearly highest values on record.
- **Forecast report card**: saved rain forecasts checked against the rain that fell.

The page also has a live flood map (MapLibre, loaded only when scrolled to) with the 1% AEP flood extents, mapped past floods and planning overlays, and an address check that asks the same Victorian Government map services. What each level means for Rochester is set in `impacts` in `config/sites.json`, with sources.

Note: the Victorian water data service limits each user to about 150 MB an hour. The hourly run uses a tiny fraction of that; the back-fill is paced to stay under it.

## Changing things

- **Flood class levels:** check the BoM table each season, https://www.bom.gov.au/vic/flood/floodclass_north.shtml, and edit `config/sites.json`.
- **Add a gauge:** add an entry to `sites` in `config/sites.json` (and a position in `LAYOUT` in `site/index.html` if it should appear on the river diagram).
- **Find extra series** (Lake Eppalock storage, rainfall gauges): run `node collector/discover.mjs 406207` on your computer to list what a site records.
- **Add a known flood:** add it to `curatedEvents` with its source.

## Try it without the internet

```
npm run example        # builds made-up example data in ./example-data
```

Copy `example-data` to `site/data`, then serve the `site` folder (for example `npx serve site`). Example data is labelled as such on the page.

## Notes

- Gauge readings are provisional and can be revised by the data owner.
- The BoM sometimes blocks automated requests; if so the warnings panel says so and links to BoM and VicEmergency.
- GitHub may delay scheduled runs at busy times by a few minutes.
