# Production answer cache → records (2026-09-25)

3 cached answers read (read-only); 3 records; 3 confirmed by the blind reviewer; 0 with personal details. All in the test split.

| Step | Text | Cached choice | Blind reviewer | Agree | Facts (cleaned) |
|---|---|---|---|---|---|
| activity | i run a cloud kitchen in pune about 80 lakh a year we sell on swiggy | cook | cook | yes | `{"activities":["cook"],"sells_online":true,"place":"premises","states":["Maharashtra"],"city":"Pune","business":[],"unknown_kind":false}` |
| activity | i cook from home | cook | cook | yes | `{"activities":["cook"],"place":"home","business":[],"unknown_kind":false}` |
| online | no but we have 3 outlets in goa | no | no | yes | `{"activities":["cook"],"place":"premises","locations":"many","states":["Goa"],"description":"I cook from home","implied":["locations"],"business":[],"unknown_kind":false}` |

