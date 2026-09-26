// Layer 1 of the intake interpreter: deterministic reading of short typed answers (no model).
// Matches known phrases (English, Hinglish) to the current question's options, and parses money and states.
// An answer counts as "complete" only when every meaningful word is explained, so anything richer goes to the
// cache / model layers. Shared by client and server (no browser or Node APIs).
import { STATES, optionsFor, isMulti } from './intakeQuestions.js'

const STOP = new Set(
  ('i im i\'m we my our me us a an the is are am was it its of for to in on at and or with from by as so just only also do does ' +
  'have has run runs running own owns sell sells about around approx approximately roughly nearly almost maybe like ' +
  'ji haan hai hain hum mera meri mere main ka ki ke se me mein aur bhi toh to bas kuch ek sir madam please yes yeah ok okay business')
    .split(/\s+/),
)
// Phrases are matched before stop words are dropped, so a bare "yes" or "haan" still selects an option.

/** Phrases per question/option. Longest phrases are matched first, so "not registered" wins over "registered". */
export const LEXICON = {
  activity: {
    cook: ['restaurant', 'cafe', 'dhaba', 'hotel', 'canteen', 'caterer', 'catering', 'cloud kitchen', 'tiffin', 'tiffin service', 'mess', 'food truck', 'chaat', 'tea stall', 'chai', 'juice', 'fast food', 'cook', 'cooking', 'serve food', 'home chef', 'bar'],
    make: ['bakery', 'manufacture', 'manufacturer', 'manufacturing', 'factory', 'pickle', 'pickles', 'achar', 'papad', 'namkeen', 'packing', 'packaging', 'repack', 'repacking', 'processing', 'dairy', 'spices', 'masala', 'bottled water', 'make', 'making', 'produce', 'sweets making'],
    sell: ['shop', 'kirana', 'grocery', 'store', 'retail', 'retailer', 'wholesale', 'wholesaler', 'distributor', 'trader', 'trading', 'supermarket', 'godown', 'warehouse', 'cold storage', 'transport', 'transporter', 'truck', 'selling'],
    import: ['import', 'importer', 'importing', 'imported'],
    none: ['none', 'none of these', 'nothing', 'not food'],
  },
  trade: {
    retail: ['shop', 'kirana', 'grocery', 'supermarket', 'retail', 'retailer', 'store', 'customers', 'sell to customers', 'online shop'],
    wholesale: ['wholesale', 'wholesaler', 'distributor', 'distribution', 'supplier', 'supply', 'stockist', 'trader', 'dealer'],
    storage: ['warehouse', 'godown', 'cold storage', 'storage', 'store food'],
    transport: ['transport', 'transporter', 'truck', 'trucks', 'tempo', 'van', 'vans', 'logistics', 'delivery vehicle'],
  },
  place: {
    street: ['cart', 'thela', 'stall', 'street', 'street stall', 'footpath', 'food truck', 'hawker', 'rehri', 'khokha'],
    home: ['home', 'house', 'ghar', 'home kitchen', 'from home', 'my home'],
    premises: ['restaurant', 'factory', 'unit', 'rented', 'rent', 'premises', 'office', 'warehouse', 'godown', 'building', 'shop'],
    hub: ['airport', 'railway', 'railway station', 'station', 'seaport', 'port', 'central government'],
    vehicles: ['only vehicles', 'vehicles only', 'just trucks', 'only trucks', 'no warehouse'],
  },
  vending: {
    yes: ['yes', 'haan', 'certificate', 'registered', 'vending certificate', 'have certificate'],
    no: ['no', 'nahi', 'not registered', 'no certificate', 'not yet'],
    unsure: ['not sure', 'dont know', 'don\'t know', 'pata nahi', 'maybe', 'unsure'],
  },
  locations: {
    one: ['one', 'one place', 'single', 'just one', 'only one', 'one shop', 'one outlet', 'one state', 'within one state'],
    many: ['two', 'three', 'multiple', 'several', 'branches', 'many places', 'more than one', 'outlets', 'same state'],
    multistate: ['multiple states', 'different states', 'many states', 'other states', 'across states', 'all india', 'pan india', 'more than one state'],
  },
  online: {
    no: ['no', 'nahi', 'offline', 'only offline', 'not online', 'dont sell online', 'don\'t sell online'],
    seller: ['yes', 'swiggy', 'zomato', 'amazon', 'flipkart', 'website', 'online', 'instagram', 'whatsapp', 'blinkit', 'zepto', 'bigbasket', 'meesho', 'jiomart'],
    platform: ['marketplace', 'aggregator', 'platform', 'my own app', 'other sellers'],
  },
  nonfood: {
    family: ['family', 'only family', 'for my family', 'ghar ke liye'],
    'own-use': ['own use', 'myself', 'kitchen garden'],
    'non-food': ['not food', 'cosmetics', 'utensils', 'packaging material', 'cleaning'],
    back: ['back', 'go back'],
  },
}

export function normalizeText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/₹|\brs\.?|\binr\b|rupees?/g, ' rs ')
    .replace(/(\d),(?=\d)/g, '$1')
    .replace(/[^a-z0-9.'\s]/g, ' ')
    .replace(/\.(?!\d)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Order-insensitive signature of the meaningful words, for cache lookups ("i run a bakery" = "bakery"). */
export function tokenSignature(text) {
  const words = normalizeText(text).split(' ').filter((w) => w && !STOP.has(w))
  return [...new Set(words)].sort().join(' ')
}

const UNIT = { crore: 1e7, crores: 1e7, cr: 1e7, lakh: 1e5, lakhs: 1e5, lac: 1e5, lacs: 1e5, l: 1e5, k: 1e3, thousand: 1e3, hazar: 1e3, hazaar: 1e3 }
const PERIOD = { day: 365, daily: 365, din: 365, month: 12, monthly: 12, mahina: 12, mahine: 12, year: 1, yearly: 1, annual: 1, annually: 1, annum: 1, saal: 1, sal: 1 }
const MONEY_RE = /(\d+(?:\.\d+)?)\s*(crores?|cr|lakhs?|lacs?|l|k|thousand|hazaa?r)?\b(?:\s*rs)?(?:\s*(?:per|a|an|every|each|\/|har|ek)?\s*(day|daily|din|month|monthly|mahin[ae]|year|yearly|annual(?:ly)?|annum|saal|sal)\b)?/

/** Yearly sales in crore from text like "80 lakh", "20k a month", "₹5,000 per day". Returns { crore, span } or null. */
export function parseSales(text) {
  const t = normalizeText(text)
  const m = t.match(MONEY_RE)
  if (!m) return null
  const unit = m[2] ? UNIT[m[2].replace(/s$/, '')] ?? UNIT[m[2]] : 1
  let period = m[3] ? PERIOD[m[3]] : 1
  if (!m[3]) for (const [w, p] of Object.entries(PERIOD)) if (new RegExp(`\\b${w}\\b`).test(t)) { period = p; break }
  const rupees = Number(m[1]) * unit * period
  if (!Number.isFinite(rupees) || rupees < 1000) return null // a bare "80" is not a sales figure
  return { crore: rupees / 1e7, span: m[0] }
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const STATE_NAMES = [...STATES, 'orissa', 'pondicherry', 'uttaranchal', 'bombay', 'new delhi'].sort((a, b) => b.length - a.length)

/** Every state/UT mentioned, in canonical form. */
export function findStates(text) {
  let t = normalizeText(text)
  const out = []
  for (const s of STATE_NAMES) {
    const re = new RegExp(`\\b${escape(s.toLowerCase())}\\b`)
    if (re.test(t)) {
      out.push({ orissa: 'Odisha', pondicherry: 'Puducherry', uttaranchal: 'Uttarakhand', bombay: 'Maharashtra', 'new delhi': 'Delhi' }[s] || s)
      t = t.replace(re, ' ')
    }
  }
  return { states: [...new Set(out)], rest: t }
}

/** Remove matched phrases (longest first) and report which option ids they belonged to. */
function matchPhrases(text, table, allowed) {
  let t = ` ${normalizeText(text)} `
  const hits = new Set()
  const phrases = Object.entries(table)
    .filter(([id]) => allowed.includes(id))
    .flatMap(([id, list]) => list.map((p) => [id, normalizeText(p)]))
    .sort((a, b) => b[1].length - a[1].length)
  for (const [id, p] of phrases) {
    const re = new RegExp(`\\s${escape(p)}\\s`, 'g')
    if (re.test(t)) {
      hits.add(id)
      t = t.replace(re, ' ')
    }
  }
  return { ids: [...hits], rest: t.trim() }
}

const leftover = (rest) => rest.split(/\s+/).filter((w) => w && !STOP.has(w) && !/^\d+$/.test(w))

/**
 * Try to answer the current question from the text alone.
 * Returns { choice, facts, complete } where complete = the whole answer was understood, or null.
 */
export function ruleAnswer(question, facts, text) {
  const norm = normalizeText(text)
  if (!norm || norm.length > 120) return null
  if (question.kind === 'states') {
    const { states, rest } = findStates(norm)
    if (!states.length) return null
    const complete = !leftover(rest).length && (isMulti(question, facts) ? states.length >= 2 : states.length === 1)
    return { choice: [], facts: { states }, complete }
  }
  if (question.id === 'turnover') {
    const sale = parseSales(norm)
    if (!sale) return null
    const rest = norm.replace(sale.span, ' ').replace(/\b(rs|per|a|an|every|each|year|yearly|month|monthly|day|daily|sales|turnover|revenue|income|approx)\b/g, ' ')
    return { choice: [], facts: { turnover_crore: sale.crore }, complete: !leftover(rest).length }
  }
  const table = LEXICON[question.id]
  if (!table) return null
  const allowed = optionsFor(question, facts).map((o) => o.id)
  const { ids, rest } = matchPhrases(norm, table, allowed)
  if (!ids.length) return null
  const valid = isMulti(question, facts) ? !(ids.includes('none') && ids.length > 1) : ids.length === 1
  return { choice: ids, facts: {}, complete: valid && !leftover(rest).length }
}
