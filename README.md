# Customer Time Tracker

Standalone local app for tracking time spent on customer projects.

## Run

```bash
cd ~/Sites/customer-time-tracker
npm start
```

Open: <http://localhost:8787>

To use another port:

```bash
PORT=8790 npm start
```

## Data

All data is stored locally in:

```text
data/time-tracker.json
```

Back up that file to preserve customers, projects, timers, and entries.

## Features

- Add customers and projects
- Start/stop one active timer
- Add manual time entries
- Notes per timer/entry
- Today/week/month/all-time summaries
- CSV export at `/api/export.csv`
