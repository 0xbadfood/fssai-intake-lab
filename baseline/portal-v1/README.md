# Portal intake v1 (frozen)

The portal's own intake code as it was before the intake moved to the server (fssai-portal commit `05244db`,
2026-09-26): `src/lib/intakeQuestions.js`, `applicationPlan.js`, `eligibility.js`, `answerRules.js`.

`graph/graph.v1.json` is a parity port of exactly this code, so the parity walk and its mutation tests
(`walk --parity`, `npm test`) run against this copy. Do not edit it.
