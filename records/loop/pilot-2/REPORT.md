# Cache-fill pilot: pilot-2

Steps: activity, service, manufacture · 12 answers per option + 15 no-match per step · graph v2 · 675 s

## Yield

Agreed = the blind reviewer chose exactly the intended option (or nothing, for no-match answers). Strong = the blind self-check agreed too. Relabelled = both blind classifiers agreed, with high confidence, on a different option than the planner intended; kept under their label and marked.

| Step | Answers | Agreed | Strong | No-match recognised | Relabelled | Records kept | Duplicates | Errors |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| activity | 72 | 55/57 (96%) | 93% | 13/15 (87%) | 2 | 70 (97%) | 0 | 0 |
| service | 100 | 76/85 (89%) | 85% | 15/15 (100%) | 3 | 94 (94%) | 0 | 0 |
| manufacture | 166 | 134/151 (89%) | 83% | 15/15 (100%) | 9 | 158 (95%) | 0 | 0 |

Reviewer and self-check (both blind) agree on 92% of 338 answers.

## Per option

Low yield means answers written for this option are often read as another one: a sign of overlapping options (worth showing the expert) or of weak generation.

| Step:option | Accepted | Most often read as |
|---|---:|---:|
| manufacture:proprietary | 6/12 | general (5), ayurveda (1) |
| service:mdm_canteen | 4/7 | canteen (2), mdm_caterer (1) |
| manufacture:novel | 4/7 | nutraceutical (2), general (1) |
| service:caterer | 5/7 | vending_est (2) |
| service:mdm_caterer | 5/7 | vending_est (2) |
| manufacture:slaughter | 5/7 | meat (2) |
| manufacture:meat | 11/13 | none (1), slaughter+meat (1) |
| service:vending_est | 6/7 | restaurant (1) |
| manufacture:fish | 6/7 | general (1) |
| manufacture:irradiation | 6/7 | milling (1) |
| activity:cook | 11/12 | none (1) |
| activity:make | 11/12 | none (1) |
| service:restaurant | 11/12 | canteen (1) |
| manufacture:oil | 11/12 | dairy+oil (1) |
| manufacture:additives | 11/12 | nutraceutical+additives (1) |
| activity:sell | 12/12 | — |
| activity:import | 14/14 | — |
| activity:export | 7/7 | — |
| service:hotel | 12/12 | — |
| service:canteen | 12/12 | — |
| service:petty | 7/7 | — |
| service:hawker | 7/7 | — |
| service:anganwadi | 7/7 | — |
| manufacture:general | 12/12 | — |
| manufacture:dairy | 7/7 | — |
| manufacture:milling | 7/7 | — |
| manufacture:packaged_water | 12/12 | — |
| manufacture:repack | 12/12 | — |
| manufacture:nutraceutical | 12/12 | — |
| manufacture:ayurveda | 12/12 | — |

## Styles and languages

| Style | Answers | Accepted |
|---|---:|---:|
| short | 46 | 87% |
| sentence | 43 | 95% |
| hinglish | 46 | 91% |
| hindi | 41 | 90% |
| typo | 44 | 86% |
| indirect | 35 | 86% |
| detailed | 38 | 97% |
| nearmiss | 7 | 71% |
| nonfood | 19 | 100% |
| offtopic | 13 | 100% |
| unlisted | 6 | 100% |

Languages: en 231, hi-Latn 64, hi 43. Answers in Devanagari: 41; the portal's text normalisation turns 40 of them into an empty cache key.

## Variety

| Measure | Value |
|---|---:|
| Exact duplicates (same normalised text) | 1 |
| Same words, any order (token signature) | 1 |
| Mean word overlap between answers for the same option (Jaccard, lower = more varied) | 0.04 |
| Answer length in words (10th / median / 90th percentile) | 3 / 7 / 14 |
| Distinct words | 1060 |

## Throughput

| Model | Calls | Failures (retried) | Prompt tokens | Output tokens | Mean s/call |
|---|---:|---:|---:|---:|---:|
| qwen3.8-27b | 371 | 0 | 213949 | 24317 | 2.36 |
| qwen3.8-flash-next | 338 | 0 | 187958 | 7793 | 1.76 |

322 accepted records in 675 s (29 per minute).

## Samples

Accepted (first 4 per step by id):

- `activity` → none · nearmiss · "I provide catering staff but do not touch the food."
- `activity` → sell · nearmiss · "I only buy and sell spices in bulk to other shops."
- `activity` → sell · hindi · "हम खाना नहीं बनाते, बस विक्रय करते हैं"
- `activity` → none · offtopic · "ok just tell me the fees"
- `service` → mdm_caterer · hinglish · "Midi day meal ka contract hai meri"
- `service` → restaurant · hindi · "होटल नहीं, सिर्फ खाना परोसते हैं।"
- `service` → hotel · detailed · "bengaluru me 40 room wala property hai, breakfast included"
- `service` → canteen · typo · "canteen in school"
- `manufacture` → general · indirect · "we mix our own blend of spices for restaurants"
- `manufacture` → additives · detailed · "In Pune, we have a 2000 sq ft plant producing citric acid and food grade acids for soft drink manufacturers."
- `manufacture` → additives · hindi · "हम फ़ूड अडिटिव्स की फैक्ट्री चलाते हैं"
- `manufacture` → proprietary · hinglish · "apna banaya hua special dry fruit mix"

Disagreements (intent → blind reviewer / self-check), first 40:

- `activity` cook → none / none · "Dushe se shuruaat ki hai"
- `activity` make → none / none · "Handmade soaps"
- `activity` none → sell / sell · "I only buy and sell spices in bulk to other shops."
- `activity` none → sell / sell · "I grow coffee beans and sell them raw to exporters."
- `service` restaurant → canteen / canteen · "We serve breakfast and lunch to office workers nearby."
- `service` caterer → vending_est / caterer · "मुहूर्त पर खाना बनाते हैं"
- `service` caterer → vending_est / vending_est · "We are a small team in Pune delivering thali to 200 guests at fairs"
- `service` vending_est → restaurant / petty · "We serve only takeout meals at a counter with no tables."
- `service` mdm_caterer → vending_est / vending_est · "School tiffin service"
- `service` mdm_caterer → vending_est / mdm_caterer · "My truck goes to different campuses every day to drop hot food."
- `service` mdm_canteen → canteen / canteen · "school canteen"
- `service` mdm_canteen → mdm_caterer / mdm_canteen · "We run the kitchen for the local government primary school."
- `service` mdm_canteen → canteen / mdm_canteen · "badi me school ka canteen chalata hu"
- `manufacture` oil → dairy+oil / dairy+oil · "milk and edible oill"
- `manufacture` meat → none / meat · "murgi ka ghar bana hai yahan"
- `manufacture` meat → slaughter+meat / meat · "we buy whole goats, dress them, and pack the meat in trays for city vendors"
- `manufacture` slaughter → meat / slaughter · "goat and sheep"
- `manufacture` slaughter → meat / meat · "bakra aur murgi ka kaam karte hai"
- `manufacture` fish → general / general · "panchakoi ka processing unit hai hamara"
- `manufacture` additives → nutraceutical+additives / additives+nutraceutical · "we do nutrionals and microbe culters for food"
- `manufacture` proprietary → general / general · "homemade pickles"
- `manufacture` proprietary → general / general · "मैं अपना खुद का लक्की मसाला बनाता हूँ"
- `manufacture` proprietary → general / general · "jaldi bane garam masala"
- `manufacture` proprietary → general / general · "we mix our own blend of spices for restaurants"
- `manufacture` proprietary → ayurveda / nutraceutical · "we make a herbal tea blend using local herbs"
- `manufacture` proprietary → general / general · "khud ke bana hue dry fruits"
- `manufacture` novel → nutraceutical / nutraceutical · "algal protein powder"
- `manufacture` novel → general / additives · "सेब की छिलके से बनी पाउडर बेचते हैं"
- `manufacture` novel → nutraceutical / novel · "algae derived collagen peptids"
- `manufacture` irradiation → milling / none · "xray machin se dal milti hain"

## Independent spot check (2026-09-25)

60 kept records drawn at random (seed 7) and graded by Claude, a third model from a different family, not a human:
55 correct, 3 debatable ("secret recipe masala" → proprietary, more likely general; "bakra aur murgi ka kaam" → meat or slaughter;
"refinery" → oil or sugar), 2 wrong ("Balika Samruddhi centre" → anganwadi; insect protein for dog food → novel food, but pet food
is outside FSSAI). Precision about 92% strict, 97% lenient. A human check by the in-house expert is still to do.
