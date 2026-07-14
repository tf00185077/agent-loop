# Dashboard

React/Vite dashboard code lives here.

The dashboard talks to the backend through REST APIs and does not read provider credentials or execute runtime logic.

## Agent Live Status

The existing `/api/goals/:id/agent-session` snapshot includes `liveStatus`.
Goal detail renders this compact state/phase card above the managed-session
controls while retaining the existing delegation/task tables and timeline.
The browser does not reduce events into authority: current event notifications
only trigger a fresh snapshot request, so refresh and backend restart produce
the same display from durable records.

Missing provider, model, session, task, delegation, or integration identities
remain nullable and render safely. Known state and phase values receive readable
labels; future values are humanized as a safe fallback.
