#!/usr/bin/env node
// Hand-written test answers (written by Claude, a different model family from the generator), in the styles
// real owners type. Labels follow the proposed resolutions of the expert queries; re-check them after the
// expert's answers. Test split only. Output: records/handwritten/claude-v1.jsonl
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { createEngine, loadGraph } from '../engine/index.js'
import { LAB_ROOT } from '../engine/graph.js'
import { viewMaker } from './classify.mjs'
import { makeRecord } from './records.mjs'

const graph = loadGraph(path.join(LAB_ROOT, 'graph/graph.v2.json'))
const E = createEngine(graph)
const makeView = viewMaker(E, graph)
const CTX = {
  activity: {}, service: { activities: ['cook'] }, manufacture: { activities: ['make'] }, trade: { activities: ['sell'] },
  'place/restaurant': { activities: ['cook'], service_kinds: ['restaurant'] }, 'place/shop': { activities: ['sell'], trade_kinds: ['retail'] },
  online: { activities: ['cook'], service_kinds: ['restaurant'], place: 'premises', locations: 'one', states: ['Goa'] },
}
const STEP = (v) => v.split('/')[0]
const A = [
  ['activity', 'bhai hum samose aur kachori banake bechte hain thele pe', ['cook']],
  ['activity', 'kirana', ['sell']],
  ['activity', 'hamara papad ka gruh udyog hai, 6 auratein kaam karti hain', ['make']],
  ['activity', 'i get dates and dry fruits from iran and sell to wholesalers in delhi', ['import', 'sell']],
  ['activity', 'Dubai bhejte hain basmati', ['export']],
  ['activity', 'tiffin service chalati hu ghar se', ['cook']],
  ['activity', 'we run a cold storage for potato farmers', ['sell']],
  ['activity', 'Beauty parlour hai mera', []],
  ['activity', 'fssai kya hota hai pehle ye batao', []],
  ['activity', 'we make pickles and also run a small shop selling other brands', ['make', 'sell']],
  ['activity', 'मैं दूध की डेयरी चलाता हूं, पनीर और घी बनाता हूं', ['make']],
  ['activity', 'resturant', ['cook']],
  ['service', 'shaadi party ka khana banate hain, hall wale bulate hain', ['caterer']],
  ['service', 'dhaba on NH44 near panipat', ['vending_est']],
  ['service', 'chai ki tapri', ['petty']],
  ['service', 'office canteen for 300 employees in whitefield', ['canteen']],
  ['service', '4 star hotel with 60 rooms and a coffee shop', ['hotel']],
  ['service', 'we deliver dabbas to offices', ['vending_est']],
  ['service', 'cloud kitchen, only swiggy zomato orders', ['restaurant']],
  ['service', 'ICDS aanganwadi me bacchon ka khana', ['anganwadi']],
  ['service', 'thela leke gali gali golgappe bechta hu', ['hawker']],
  ['service', 'school mein mid day meal banate aur parosate hain', ['mdm_canteen']],
  ['service', 'we sell cosmetics', []],
  ['service', 'restaurent + cattering both', ['caterer', 'restaurant']],
  ['manufacture', 'atta chakki', ['milling']],
  ['manufacture', 'kacchi ghani sarson ka tel', ['oil']],
  ['manufacture', 'we make whey protein and multivitamin gummies', ['nutraceutical']],
  ['manufacture', 'bakery - bread rusk cake', ['general']],
  ['manufacture', 'मिनरल वाटर की बोतल भरते हैं', ['packaged_water']],
  ['manufacture', 'frozen prawns processing for export', ['fish']],
  ['manufacture', 'buy tea in bulk and pack in 250g pouches with our brand', ['repack']],
  ['manufacture', 'paneer, dahi, lassi', ['dairy']],
  ['manufacture', 'chicken cutting and packing, we slaughter birds on site', ['meat', 'slaughter']],
  ['manufacture', 'food colours and flavours for bakeries', ['additives']],
  ['manufacture', 'ayurvedic chyawanprash type khane wale product', ['ayurveda']],
  ['manufacture', 'we make leather shoes', []],
  ['trade', 'supermarket', ['retail']],
  ['trade', 'FMCG distributor for 3 districts', ['distribution']],
  ['trade', 'reefer trucks, milk tanker', ['transport']],
  ['trade', 'godown kiraye pe dete hain anaj ke liye', ['storage']],
  ['trade', 'amway jaisa direct selling', ['direct_seller']],
  ['trade', 'vending machine in offices for snacks and drinks', ['vending_agency']],
  ['trade', 'thok vyapari hain dal chawal ke', ['wholesale']],
  ['trade', 'cold room for fruits and vegetables', ['storage_cold']],
  ['place/restaurant', 'ghar ki rasoi se', ['home']],
  ['place/restaurant', 'rented shop in market', ['premises']],
  ['place/restaurant', 'food truck', ['street']],
  ['place/restaurant', 'inside Bengaluru airport terminal 2', ['airport']],
  ['place/restaurant', 'stall on platform no 1 at nagpur junction', ['railway']],
  ['place/shop', 'dukaan', ['premises']],
  ['place/shop', 'thela', ['street']],
  ['online', 'nahi, sirf dukaan se', ['no']],
  ['online', 'zomato pe hain', ['seller']],
  ['online', 'we built an app where home chefs list their food', ['platform']],
  ['online', 'instagram pe order lete hain', ['seller']],
]
const records = A.map(([view, text, targets]) => {
  const v = makeView({ step: STEP(view), context: CTX[view] })
  return makeRecord({
    step: v.step, candidates: v.options.map((o) => o.id), graphVersion: graph.version, knownFacts: v.facts, text,
    lang: /[ऀ-ॿ]/.test(text) ? 'hi' : null, targets, unknown: targets.length === 0,
    source: 'human', producer: { author: 'claude (different model family from the generator)', labels: 'proposed expert resolutions' },
    status: 'model-reviewed', review: { view }, split: 'test',
  })
})
const bad = records.filter((r) => r.targets.some((t) => !r.candidates.includes(t)))
if (bad.length) throw new Error(`labels not among options: ${bad.map((r) => `${r.text} → ${r.targets}`).join('; ')}`)
writeFileSync(path.join(LAB_ROOT, 'records/handwritten/claude-v1.jsonl'), records.map((r) => JSON.stringify(r)).join('\n') + '\n')
console.log(`${records.length} hand-written test records`)
