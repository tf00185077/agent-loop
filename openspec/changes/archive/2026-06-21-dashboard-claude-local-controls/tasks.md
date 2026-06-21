## 1. Dashboard types

- [x] 1.1 Add the `claude-local` variant to `ProviderSettings` and `SaveProviderSettingsInput` in `src/dashboard/api.ts`

## 2. Provider setup controls

- [x] 2.1 Add a Claude Local provider segment with a free-text model label input, command path input, and Detect control (no catalog picker, no connection test)
- [x] 2.2 Make the status box/line CLI-aware so Claude Local shows Claude wording and `claude login` guidance
- [x] 2.3 Reset the model label on provider switch (restore saved label for the saved provider; otherwise blank = CLI default)

## 3. Tests and live verification

- [x] 3.1 Add a dashboard test asserting Claude Local controls render without a catalog picker or connection test
- [x] 3.2 Verify live in the browser via real mouse clicks (select Claude Local → Save → Detect) that the screen shows the detected Claude path and status
