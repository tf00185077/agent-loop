# dashboard-goal-lifecycle Delta

## ADDED Requirements

### Requirement: Dashboard handles goal input requests
The dashboard SHALL display a `waiting_user` goal with a distinct non-terminal status treatment and SHALL show its pending input request — reason, summary, evidence/gaps, and the allowed decisions — on the goal detail page with a respond affordance for each allowed decision (extension amount input for `extend_budget`, guidance text input for `provide_guidance`, confirmation for `abandon`). Responses SHALL be submitted only through the backend respond endpoint, and a response rejected because another client already resolved the request SHALL surface the standing resolution instead of an error.

#### Scenario: Pending request is visible and answerable
- **WHEN** a goal is `waiting_user` with a pending input request
- **THEN** the goal detail page shows the request's reason, summary, and gaps, and offers exactly the request's allowed decisions

#### Scenario: Successful response resumes the view
- **WHEN** the user submits a valid response and the backend accepts it
- **THEN** the pending panel clears and the goal view reflects the resulting status (`running` after resume, `blocked` after abandon) without a manual reload

#### Scenario: Concurrent resolution is surfaced
- **WHEN** the user submits a response but another client already resolved the request
- **THEN** the dashboard shows the standing resolution instead of a raw error
