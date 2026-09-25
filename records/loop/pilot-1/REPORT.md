# Cache-fill pilot: pilot-1

Steps: activity, service, manufacture · 12 answers per option + 15 no-match per step · graph v2 · 2042 s

## Yield

Accepted = the blind reviewer chose exactly the intended option (or nothing, for no-match answers). Strong = the blind self-check agreed too.

| Step | Answers | Accepted | Strong | No-match recognised | Duplicates | Errors |
|---|---:|---:|---:|---:|---:|---:|
| activity | 65 | 45/50 (90%) | 88% | 9/15 (60%) | 0 | 5 |
| service | 110 | 76/95 (80%) | 80% | 7/15 (47%) | 0 | 20 |
| manufacture | 145 | 107/130 (82%) | 82% | 8/15 (53%) | 0 | 13 |

Reviewer and self-check (both blind) agree on 96% of 282 answers.

## Per option

Low yield means answers written for this option are often read as another one: a sign of overlapping options (worth showing the expert) or of weak generation.

| Step:option | Accepted | Most often read as |
|---|---:|---:|
| manufacture:novel | 5/12 | none (3), nutraceutical (2) |
| service:mdm_canteen | 3/7 | none (2), mdm_caterer+mdm_canteen (1) |
| service:petty | 4/7 | none (3) |
| manufacture:meat | 4/7 | none (2), fish (1) |
| manufacture:proprietary | 4/7 | general (2), none (1) |
| service:canteen | 8/12 | none (3), hotel (1) |
| manufacture:slaughter | 8/12 | fish (2), meat (1) |
| service:vending_est | 5/7 | none (2) |
| service:mdm_caterer | 5/7 | none (2) |
| activity:cook | 10/12 | make (1), cook+make (1) |
| activity:import | 10/12 | import+sell (1), none (1) |
| manufacture:milling | 10/12 | none (2) |
| activity:export | 6/7 | none (1) |
| service:hawker | 6/7 | none (1) |
| manufacture:additives | 6/7 | none (1) |
| manufacture:nutraceutical | 6/7 | additives (1) |
| manufacture:ayurveda | 6/7 | general (1) |
| service:hotel | 11/12 | none (1) |
| service:caterer | 11/12 | canteen+caterer (1) |
| service:anganwadi | 11/12 | none (1) |
| manufacture:oil | 11/12 | none (1) |
| activity:make | 12/12 | — |
| activity:sell | 7/7 | — |
| service:restaurant | 12/12 | — |
| manufacture:general | 7/7 | — |
| manufacture:dairy | 7/7 | — |
| manufacture:fish | 7/7 | — |
| manufacture:packaged_water | 12/12 | — |
| manufacture:repack | 7/7 | — |
| manufacture:irradiation | 7/7 | — |

## Styles and languages

| Style | Answers | Accepted |
|---|---:|---:|
| short | 44 | 91% |
| sentence | 43 | 95% |
| hinglish | 45 | 73% |
| hindi | 40 | 60% |
| typo | 36 | 78% |
| indirect | 32 | 91% |
| detailed | 35 | 94% |
| nonfood | 16 | 81% |
| nearmiss | 13 | 8% |
| offtopic | 10 | 90% |
| unlisted | 6 | 17% |

Languages: en 216, hi-Latn 58, hi 42, mixed 4. Answers in Devanagari: 41; the portal's text normalisation turns 38 of them into an empty cache key.

## Variety

| Measure | Value |
|---|---:|
| Exact duplicates (same normalised text) | 2 |
| Same words, any order (token signature) | 0 |
| Mean word overlap between answers for the same option (Jaccard, lower = more varied) | 0.04 |
| Answer length in words (10th / median / 90th percentile) | 3 / 8 / 14 |
| Distinct words | 974 |

## Throughput

| Model | Calls | Failures (retried) | Prompt tokens | Output tokens | Mean s/call |
|---|---:|---:|---:|---:|---:|
| qwen3.8-27b | 353 | 0 | 199454 | 22701 | 2.31 |
| qwen3.8-flash-next | 396 | 114 | 212338 | 37856 | 4.54 |

252 accepted records in 2042 s (7 per minute).

## Samples

Accepted (first 4 per step by id):

- `activity` → import · hindi · "मैं नेपाल से चाय आयात करता हूं"
- `activity` → make · hindi · "आप हमारी फैक्ट्री में चिपस और नाश्ते की चीजें पैक करते हैं।"
- `activity` → make · short · "repacking oil bottles"
- `activity` → make · detailed · "I have a small unit in Ludhiana where I process and bag my own dry fruits."
- `service` → canteen · detailed · "located in Pune, we serve lunch and dinner to 200+ students of the engineering college, only open during term time"
- `service` → anganwadi · typo · "angnawdi"
- `service` → caterer · hinglish · "main wedding catering business karta hoon"
- `service` → vending_est · detailed · "We have a boarding house in Jaipur serving meals for students."
- `manufacture` → milling · short · "Dal grinding"
- `manufacture` → oil · detailed · "palm oil factory in nagaland with 20 employees"
- `manufacture` → packaged_water · indirect · "we take municipal water and filter it into 1L bottles"
- `manufacture` → packaged_water · hindi · "पानी भरने का काम करते हैं"

Disagreements (intent → blind reviewer / self-check), first 40:

- `activity` cook → make / cook · "we make food and give it to people"
- `activity` cook → cook+make / cook+make · "we make and serve meals"
- `activity` import → import+sell / import · "I bring frozen shrimp from Vietnam to my cold storage in Kochi."
- `activity` none → sell / sell · "I sell spices like cumin and turmeric in bulk"
- `activity` none → cook / cook · "Maine apne ghar pe chota sa juice bar kholi hai"
- `activity` none → sell / sell · "I sell fresh fruits from a fruit cart, no processing"
- `service` caterer → canteen+caterer / caterer · "we do catering for schools and colleges"
- `service` canteen → hotel / hotel · "होटल का डाइनिंग हॉल"
- `service` mdm_canteen → mdm_caterer+mdm_canteen / mdm_canteen · "school midday meal"
- `service` mdm_canteen → mdm_caterer / mdm_canteen · "midday meal in govt schol"
- `service` none → petty / none · "i make and sell homemade pickles in jars"
- `service` none → restaurant / restaurant · "i run a cloud kitchen but only sell vegan packaged meals"
- `service` none → mdm_caterer / mdm_caterer · "main school me khana pakata hu par khud nahi khilata, sirf deliver karta hu"
- `manufacture` meat → fish / fish · "packaging fresh fish fillets"
- `manufacture` slaughter → meat / meat · "poultry processing"
- `manufacture` slaughter → fish / fish · "We handle the killing and evisceration of fish in our harbor."
- `manufacture` slaughter → fish / fish · "मैं मछली की कटाई और प्रोसेसिंग करता हूं।"
- `manufacture` nutraceutical → additives / additives · "Chandigarh mein hum 500kg monthly turmeric curcumin extract pack karte hain for export"
- `manufacture` proprietary → general / general · "handmade granola"
- `manufacture` proprietary → general / general · "we blend our own exotic spices and sell under brand name, not buying bulk"
- `manufacture` novel → nutraceutical / novel · "insect protein powder"
- `manufacture` novel → nutraceutical / nutraceutical · "algae based protein bar for gyms"
- `manufacture` novel → additives / additives · "बेसिलस सबासिलस का पाउडर"
- `manufacture` novel → general / general · "we make snacks with black ants for local stores"
- `manufacture` ayurveda → general / general · "ham aam aahara ki chutneyi banate hai"
- `manufacture` none → general / general · "I make chutney at home and sell it in small jars to my neighbours."
- `manufacture` none → general / general · "मैं सिर्फ़ तंदूरी ब्रेड बेचती हूँ, घर से।"
- `manufacture` none → meat / meat · "We store and distribute frozen chicken for a big company, but we don't cook it."
- `manufacture` none → ayurveda / general · "I make herbal teas from my own garden herbs."
- `manufacture` none → general / general · "We sell ready-made meals but we don't have a factory, we do it in a shared kitchen."
