# Gem exports drop folder

Drop your Gem CSV exports here before committing. The deploy action will
auto-run the import and update `data.json`.

## How to export from Gem

### Pipeline report → `pipeline.csv`
1. Gem → **Reports** → **Pipeline Report**
2. Set date range to the current quarter
3. Click **Export CSV**
4. Save as `gem-exports/pipeline.csv`

Expected columns (Gem's default):
```
Job Title, Stage, Candidate Count, Avg Days in Stage
```

### Outreach report → `outreach.csv`
1. Gem → **Outreach** → **Sequences** (or Analytics)
2. Group by **Month**
3. Click **Export CSV**
4. Save as `gem-exports/outreach.csv`

Expected columns (Gem's default):
```
Month, Sent, Open Rate, Reply Rate, Interested
```
(Rates can be 0–100 or 0–1 decimals — the script handles both.)

## After dropping the files

```bash
git add gem-exports/pipeline.csv gem-exports/outreach.csv
git commit -m "chore: add Gem exports for week of Jun 15"
git push
```

GitHub Actions will:
1. Run `gem-import.js` to patch `data.json`
2. Commit the updated `data.json` back
3. Deploy to GitHub Pages

## Manual fields that stay in `data.json`

These are **not** overwritten by the import — edit them directly in `data.json`:

- `roles[].note` — "This week" column
- `roles[].status` / `roles[].status_label` — status badge
- `flags[]` — key topics for discussion
- `_meta.quarter`, `_meta.period` — quarter label
- `kpis.hires_target`, `kpis.bench_time_to_hire` — targets
