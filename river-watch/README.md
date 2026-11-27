# River Watch - Campaspe, Goulburn & Murray Rivers

> In this repo it lives in `river-watch/` and is served at https://joshmakesgames.app/river-watch/ . Workflows are `.github/workflows/river-watch-collect.yml` and `river-watch-backfill.yml`; they run `river-watch/collector/*.mjs` and save data to `main` with `collector/save.sh`, which GitHub Pages serves directly (no Pages deploy step). The setup steps further down are for running it as a standalone repository.

Created by Josh Avard

A public flood-awareness site for Rochester. Every hour it records river heights and flows across the Campaspe, its creeks, the Goulburn and the Murray; dam levels; catchment rain and heavy bursts; ground wetness; climate drivers; and Bureau of Meteorology warnings. It keeps everything as open data and compares today with past floods.

**This is an awareness and learning tool. Warnings and evacuation advice come from VicEmergency (1800 226 226, emergency.vic.gov.au) and the Bureau of Meteorology.**

## What it tracks

| Factor | Where it comes from | Updated |
|---|---|---|
| 37 river and creek gauges: Campaspe (Redesdale to Echuca), Coliban, McIvor, Axe and Mount Pleasant creeks, Goulburn (Eildon to McCoys Bridge), Broken River, Seven Creeks, Mitta Mitta, Kiewa, Ovens, Murray (Doctors Point to Swan Hill), Edward River, Loddon | Victorian Water Measurement Information System and WaterNSW (Hydstra web services) | Hourly |
| Lake Eppalock dam level against the 193.91 m AHD spillway | Gauge 406219 (head gauge) | Hourly |
| 16 dams and weirs, % full (Eppalock, Eildon, Hume, Dartmouth, Waranga, Goulburn Weir, Yarrawonga, Torrumbarry and more) | Goulburn-Murray Water storage feed | Hourly |
| Coliban Water storages (Upper Coliban, Lauriston, Malmsbury) and dam history | BoM Water Data Online | Daily |
| Rain fallen and forecast at 20 places in 6 catchments | Open-Meteo forecast models | Hourly |
| Heaviest hour and heaviest 24 hours, past 7 days and next 3 days | Open-Meteo hourly rain | Hourly |
| Ground wetness (water in the top metre of soil) and its percentile for the month | Open-Meteo ERA5 reanalysis | Daily |
| El Niño / La Niña (ONI), Indian Ocean Dipole (DMI), Southern Annular Mode | NOAA | Daily |
| Where Rochester's water comes from (Eppalock outflow, Axe and Mount Pleasant creeks, ungauged remainder) | Calculated from the gauges and measured travel times | Hourly |
| The Campaspe against the Murray at Echuca (backwater) | Gauges 406265 and 409200 | Hourly |
| Peaks heading for Rochester and Echuca, with travel times | Upstream gauges; travel times measured from past floods | Hourly |
| What each river height means on the ground, Rochester and Echuca | Shire of Campaspe Flood Emergency Plan (2019) | Edit `config/knowledge.json` |
| Minimum BoM warning times | BoM Service Level Specification, Victoria v4.3 | Edit `config/knowledge.json` |
| BoM warnings for these rivers | BoM Victorian warnings feed | Hourly |
| BoM predicted heights, read from the text of current flood warnings | BoM warning products | Hourly |
| Rate of rise and time to each flood level at that rate | Calculated from the hourly gauge readings | Hourly |
| How unusual today is (yearly highest values, "1 in X years") | Calculated from the daily history | Hourly |
| Rain forecast report card (saved forecasts checked against the rain that fell) | Calculated from the saved forecasts | Hourly |
| 30-day river model outlook at 5 places, compared with the model's own record since 1984 | GloFAS v4 (Copernicus) via the Open-Meteo Flood API, CC BY 4.0 | Hourly |
| Flood map (1% AEP extents, mapped past floods, planning overlays) and address check | Victorian Government map services, OpenStreetMap Nominatim, OpenFreeMap | Live in the page |

Nothing needs an API key. The flood factors board uses this site's own markers, not official warning levels.

## How it runs

| Part | What it does | Where |
|---|---|---|
| Hourly collection | GitHub Actions runs `collector/collect.mjs` at 35 past every hour, saves new data and redeploys the site | `.github/workflows/collect.yml` |
| History back-fill | Daily levels and flows, dam volumes, rain, ground wetness and climate indices since 1970, then every past flood rebuilt hour by hour | `.github/workflows/backfill.yml` |
| Website | One page that reads the data files | `site/index.html` |
| Hosting | GitHub Pages, on your own domain through Cloudflare DNS | |
| Settings | Gauges and flood levels, dams, catchments, known floods, impacts, travel times, links | `config/*.json` |

## Set-up (about 20 minutes)

1. **Create the repository.** On GitHub, make a new **public** repository (for example `river-watch`) and upload everything in this folder, keeping the folder structure, including the hidden `.github` folder.
2. **Allow the workflows to save data.** Settings > Actions > General > Workflow permissions > **Read and write permissions** > Save.
3. **Turn on Pages.** Settings > Pages > Build and deployment > Source: **GitHub Actions**.
4. **First run.** Actions tab > **Collect river data** > Run workflow. When it finishes (a few minutes) the site is live at `https://<your-username>.github.io/river-watch/`. Open the run's log to see any gauge that did not report.
5. **Load the history.** Actions tab > **Back-fill history** > Run workflow (defaults: all, from 1970). Expect 1 to 3 hours. If it hits the time limit, run it again in parts, in this order: `daily`, `storages`, `rain`, `soil`, `climate`, `stats`, `events`. Afterwards the percentiles, travel times and past floods fill in.

### Put it on your domain (Cloudflare)

1. GitHub: Settings > Pages > Custom domain: enter e.g. `river.yourdomain.com.au` > Save.
2. Cloudflare dashboard > your domain > DNS > Add record: Type `CNAME`, Name `river`, Target `<your-username>.github.io`, Proxy status **DNS only** (grey cloud) so GitHub can issue the HTTPS certificate.
3. Back in GitHub Pages, wait for the DNS check to pass, then tick **Enforce HTTPS**.
4. Optional: once HTTPS works you can switch the record to Proxied (orange cloud). If you do, set Cloudflare SSL/TLS to **Full**.

## The dataset

| File | Contents |
|---|---|
| `data/latest.json` | Everything the page shows: latest readings, factors, dams, rain, wetness, climate, budget, backwater, signals |
| `data/hourly/YYYY-MM/DD.csv` | Every hourly level and flow (UTC day files) |
| `data/daily/<site>.csv` | Daily highest level and mean flow for every gauge since 1970 |
| `data/storages/daily.csv` | Daily dam % full, volume and level |
| `data/rain/daily.csv` | Daily rain for 20 places (ERA5 history, recent model estimates) |
| `data/rain/forecasts/YYYY-MM.csv` | One forecast snapshot a day, with the heaviest hour, to check forecasts against what fell |
| `data/soil/daily.csv` | Daily water in the top metre of soil for 6 catchments |
| `data/climate/indices.csv` | Monthly ONI, DMI and SAM |
| `data/events/index.json` and `data/events/<date>.json` | Every past flood: peaks, flows, travel times, where the water came from, Eppalock level, ground wetness, heaviest rain, climate drivers, hourly records |
| `data/warnings.csv` | Each river-related BoM warning as it appeared |
| `data/sites.csv`, `data/storages.csv`, `data/rain-points.csv` | Reference lists |
| `data/frequency.json` | Highest level or flow in each year (July to June) with how often each was reached |
| `data/predictions.csv` | Predicted heights read from BoM flood warnings, kept to check against what happened |
| `data/model/glofas-YYYY-MM.csv` | One GloFAS river model snapshot a day (median and spread, ML/day), to check the model against the gauges |

Past floods are found automatically: any time Rochester Town, Rochester Syphon, Echuca (Campaspe) or Echuca Wharf went over the minor flood level. Known floods in `config/knowledge.json` (November 2010, January 2011, October 2022, January 2024) add names, facts and the peaks reported at the time.

## Notes and checks

- **Coliban River and McIvor Creek gauges** are found by name through BoM Water Data Online on the first run (`data/state/discovered.json`). Check the result with `node collector/discover.mjs`. If one is wrong or missing, put the right site number in `config/sites.json` instead of `null`.
- **Gauge 406214** came from the GMW Water Status link. Its name fills in from the gauge record. If it is Axe Creek, it is used in the "where Rochester's water comes from" calculation; otherwise Axe Creek at Strathfieldsaye (406262) is used.
- **Echuca gauges (406265, 409200)** have flood levels in m AHD. If either service returns gauge height instead, the page marks the reading and leaves it unclassified. Add the gauge zero to `config/sites.json` to fix it.
- **Flood class levels** change from time to time. Check https://www.bom.gov.au/vic/flood/floodclass_north.shtml each season.
- **Impact descriptions** come from the 2019 Flood Emergency Plan, which predates October 2022 and the Rochester Flood Study 2025 update. Update `config/knowledge.json` when the council publishes new flood intelligence.
- **Travel times** start from the plan's approximate figures and switch to medians measured from past floods once at least two floods include both gauges.
- VicEmergency has no public data feed, so road closures and incidents are linked, not shown.
- The BoM sometimes blocks automated requests; if so the warnings panel says so and links to BoM and VicEmergency.
- Gauge readings are provisional and can be revised by the data owner.
- The GloFAS river model is a global 5 km model that is not tuned to these gauges. Its flows are only compared with its own record (kept in `data/state/model-stats.json`, rebuilt every 6 months), never with gauge flows. Model points are set in `riverModel` in `config/catchments.json`.
- BoM predicted heights are matched to gauges by river and place name. Add extra place names to `bomNames` in `config/sites.json` if a warning uses a name the site does not know.

## Try it without the internet

```
npm run example        # builds made-up example data in ./example-data (about 3 minutes)
```

Copy `example-data` to `site/data`, then serve the `site` folder (for example `npx serve site`). Example data is labelled as such on the page.
