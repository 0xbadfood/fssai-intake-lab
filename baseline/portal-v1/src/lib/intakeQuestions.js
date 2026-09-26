// Tap-first intake: a finite question automaton that follows the FSSAI 2026 workflow chart.
// Each question says when it is relevant, when it is answered, and which options make sense given the
// earlier answers (a factory is never offered a street cart). Taps map directly to facts; free text is
// interpreted on the server into the same facts. `reconcile` clears answers an earlier change made invalid.
// Shared by client and server (keep this file free of JSX/browser APIs). `node scripts/check-intake.mjs` walks every path.

export const STATES = [
  'Andaman and Nicobar Islands', 'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chandigarh', 'Chhattisgarh',
  'Dadra and Nagar Haveli and Daman and Diu', 'Delhi', 'Goa', 'Gujarat', 'Haryana', 'Himachal Pradesh', 'Jammu and Kashmir',
  'Jharkhand', 'Karnataka', 'Kerala', 'Ladakh', 'Lakshadweep', 'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya',
  'Mizoram', 'Nagaland', 'Odisha', 'Puducherry', 'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura',
  'Uttar Pradesh', 'Uttarakhand', 'West Bengal',
]
export const POPULAR_STATES = [
  'Maharashtra', 'Karnataka', 'Delhi', 'Tamil Nadu', 'Uttar Pradesh', 'Gujarat',
  'Telangana', 'West Bengal', 'Kerala', 'Rajasthan', 'Haryana', 'Punjab',
]

const STATE_ALIASES = {
  orissa: 'Odisha', pondicherry: 'Puducherry', uttaranchal: 'Uttarakhand', 'nct of delhi': 'Delhi', 'new delhi': 'Delhi',
  'jammu & kashmir': 'Jammu and Kashmir', 'andaman & nicobar islands': 'Andaman and Nicobar Islands', bombay: 'Maharashtra',
}

/** Map free text (e.g. "MAHARASHTRA", "NCT of Delhi") to a canonical state/UT name, or null. */
export function matchState(text) {
  const t = String(text || '').toLowerCase().replace(/\s+/g, ' ').trim()
  if (!t) return null
  for (const [alias, name] of Object.entries(STATE_ALIASES)) if (t.includes(alias)) return name
  return [...STATES].sort((a, b) => b.length - a.length).find((s) => t.includes(s.toLowerCase())) || null
}

// ---------- Fact vocabulary ----------

export const ACTIVITY_LABEL = {
  cook: 'Cooks & serves food',
  make: 'Makes or packs food',
  sell: 'Sells, stores or transports food',
  import: 'Imports food',
}
export const TRADE_LABEL = { retail: 'Sells to customers', wholesale: 'Wholesale / distribution', storage: 'Stores food', transport: 'Transports food' }
export const PLACE_LABEL = {
  street: 'Street cart / stall',
  home: 'Home',
  premises: 'Own business premises',
  hub: 'Airport / railway / seaport',
  vehicles: 'Vehicles only',
}
export const LOCATIONS_LABEL = { one: 'One place', many: 'Several places in one state', multistate: 'Places in more than one state' }
// Kind of Business groups used on the workflow chart and in Form A/B.
export const KOB_LABEL = {
  foodService: 'Food service',
  manufacturer: 'Manufacturing / processing / repacking',
  tradeRetailStorageTransport: 'Trade / retail / storage / transport',
}

const acts = (f) => f.activities || []
const trades = (f) => f.trade || []
const within = (list, allowed) => list.every((x) => allowed.includes(x))
const has = (f, a) => acts(f).includes(a)

export const isFoodBusiness = (f) => acts(f).length > 0
export const isNotFood = (f) => Array.isArray(f.activities) && f.activities.length === 0 && f.food_business === false
export const isDeemed = (f) => f.place === 'street' && f.municipal_registered === true
/** Only outlets that sell to the public (cooking, or retail trade) can be carts, stalls or hub outlets. */
const outletOnly = (f) => within(acts(f), ['cook', 'sell']) && (!has(f, 'sell') || within(trades(f), ['retail']))
const transportOnly = (f) => within(acts(f), ['sell']) && trades(f).length > 0 && within(trades(f), ['transport'])
const storageOrTransportOnly = (f) => within(acts(f), ['sell']) && trades(f).length > 0 && within(trades(f), ['storage', 'transport'])
/** A mandatory Central Licence already applies, so turnover cannot change the result (workflow step 4). */
export const hasCentralOverride = (f) =>
  has(f, 'import') || f.place === 'hub' || f.ecommerce_platform === true || f.locations === 'multistate' || (f.states || []).length > 1

function premisesOption(f) {
  const parts = []
  if (has(f, 'cook')) parts.push('restaurant')
  if (has(f, 'make')) parts.push('factory')
  if (trades(f).includes('retail')) parts.push('shop')
  if (trades(f).some((t) => t === 'wholesale' || t === 'storage')) parts.push('warehouse')
  if (has(f, 'import') || trades(f).includes('transport')) parts.push('office')
  const u = [...new Set(parts)]
  const label = u.length > 1 ? `${u.slice(0, -1).join(', ')} or ${u.at(-1)}` : u[0] || 'business premises'
  const examples = {
    restaurant: 'restaurant, café, canteen, cloud kitchen',
    factory: 'factory, workshop, processing unit',
    shop: 'shop, kirana, supermarket',
    warehouse: 'warehouse, godown, cold storage',
    office: 'office or depot',
  }
  return { id: 'premises', emoji: has(f, 'make') ? '🏭' : '🏪', label: `A ${label}`, example: `Owned or rented: ${u.map((p) => examples[p]).join('; ')}` }
}

// A home kitchen only makes sense when food is cooked or made there; a seller simply works from home.
const homeKitchen = (f) => has(f, 'cook') || has(f, 'make')
const homeName = (f) => (homeKitchen(f) ? 'your home kitchen' : 'home')

function homeOption(f) {
  const examples = [
    has(f, 'cook') && 'tiffin service, home chef',
    has(f, 'make') && 'home bakery, homemade pickles or snacks',
    has(f, 'sell') && 'home-based shop, selling packaged food online',
  ].filter(Boolean)
  const text = examples.join('; ')
  return { id: 'home', emoji: '🏠', label: homeKitchen(f) ? 'My home kitchen' : 'From my home', example: text[0].toUpperCase() + text.slice(1) }
}

function streetOption(f) {
  const cook = has(f, 'cook')
  return {
    id: 'street', emoji: '🛺', label: cook ? 'A cart, stall or food truck' : 'A cart or street stall',
    example: cook ? 'Chaat cart, tea stall, pav bhaji thela, food truck' : 'Fruit or vegetable cart, snack or paan stall',
  }
}

// ---------- The automaton ----------
// relevant(f): the question applies to this business. answered(f): its facts are known.
// options(f): choices that make sense given earlier answers. value(f): the option ids the facts currently represent.

const RAW = [
  {
    id: 'activity',
    multi: true,
    title: 'What does your business do with food?',
    hint: 'Tap everything that applies.',
    keys: ['activities', 'kob', 'importer'],
    relevant: () => true,
    answered: (f) => Array.isArray(f.activities),
    options: () => [
      { id: 'cook', emoji: '🍳', label: 'Cook & serve', example: 'Restaurant, café, tiffin service, cloud kitchen, caterer, canteen' },
      { id: 'make', emoji: '🏭', label: 'Make or pack', example: 'Bakery, pickles, namkeen, spices, dairy, repacking, bottled water' },
      { id: 'sell', emoji: '🛒', label: 'Sell, store or transport', example: 'Kirana shop, distributor, wholesaler, cold storage, delivery vans' },
      { id: 'import', emoji: '🚢', label: 'Import food', example: 'Bring food products into India from another country' },
      { id: 'none', emoji: '🤷', label: 'None of these', example: "I'm not sure my business involves food", exclusive: true },
    ],
    value: (f) => (Array.isArray(f.activities) ? (f.activities.length ? f.activities : ['none']) : null),
    apply: (ids) => ({ activities: ids.includes('none') ? [] : ids, food_business: undefined }),
    show: (f) => (acts(f).length ? acts(f).map((a) => ACTIVITY_LABEL[a]).join(' · ') : 'None of these'),
  },
  {
    // Workflow step 1: is it a food business under the FSS Act?
    id: 'nonfood',
    title: 'Which of these is closest?',
    keys: ['food_business'],
    relevant: (f) => Array.isArray(f.activities) && f.activities.length === 0,
    answered: (f) => f.food_business != null,
    options: () => [
      { id: 'family', emoji: '🏠', label: 'I cook only for my family', example: 'Nothing is sold or served to others' },
      { id: 'own-use', emoji: '🌾', label: 'I grow food for my own use', example: 'Kitchen garden or farm produce you eat yourself' },
      { id: 'non-food', emoji: '🧴', label: 'My products are not food', example: 'Cosmetics, utensils, packaging, cleaning products' },
      { id: 'back', emoji: '↩️', label: 'Actually, I do one of those', example: 'Go back to the previous question' },
    ],
    value: (f) => (f.food_business === false ? [f.nonfood_reason || 'non-food'] : null),
    apply: ([id]) => (id === 'back' ? { activities: undefined, kob: undefined, importer: undefined, food_business: undefined } : { food_business: false, nonfood_reason: id }),
    show: (f) => ({ family: 'Cooks only for family', 'own-use': 'Grows food for own use', 'non-food': 'Products are not food' })[f.nonfood_reason] || 'Not a food business',
  },
  {
    id: 'trade',
    multi: true,
    title: 'What kind of selling, storing or transport?',
    hint: 'Tap everything that applies.',
    keys: ['trade'],
    relevant: (f) => has(f, 'sell'),
    answered: (f) => trades(f).length > 0,
    options: () => [
      { id: 'retail', emoji: '🏬', label: 'Sell to customers', example: 'Kirana, supermarket, sweet shop, fruit stall, online shop' },
      { id: 'wholesale', emoji: '📦', label: 'Wholesale or distribution', example: 'Supply shops, restaurants or other businesses' },
      { id: 'storage', emoji: '❄️', label: 'Store food', example: 'Warehouse, godown, cold storage' },
      { id: 'transport', emoji: '🚛', label: 'Transport food', example: 'Trucks, tempos, refrigerated vans' },
    ],
    value: (f) => (trades(f).length ? trades(f) : null),
    apply: (ids) => ({ trade: ids }),
    show: (f) => trades(f).map((t) => TRADE_LABEL[t]).join(' · '),
  },
  {
    id: 'place',
    title: (f) =>
      within(acts(f), ['make']) ? 'Where do you make or pack it?' : within(acts(f), ['cook']) ? 'Where do you cook?' : 'Where do you run it from?',
    keys: ['place'],
    relevant: isFoodBusiness,
    answered: (f) => f.place != null,
    options: (f) =>
      [
        outletOnly(f) && streetOption(f),
        within(acts(f), ['cook', 'make', 'sell']) && (!has(f, 'sell') || within(trades(f), ['retail'])) && homeOption(f),
        premisesOption(f),
        outletOnly(f) && {
          id: 'hub', emoji: '✈️', label: 'Airport, railway or seaport', example: 'Outlet inside an airport, station or port, or on central-government premises',
        },
        transportOnly(f) && { id: 'vehicles', emoji: '🚛', label: 'Only my vehicles', example: 'No shop or warehouse; just trucks or vans' },
      ].filter(Boolean),
    value: (f) => (f.place ? [f.place] : null),
    apply: ([id]) => ({ place: id }),
    show: (f) => (f.place === 'premises' ? premisesOption(f).label : f.place === 'home' ? (homeKitchen(f) ? 'Home kitchen' : 'From home') : PLACE_LABEL[f.place]),
  },
  {
    // Workflow step 3: deemed registration for registered street vendors.
    id: 'vending',
    title: 'Is your stall registered with the municipality?',
    hint: 'For example a vending certificate from your Municipal Corporation or Town Vending Committee.',
    keys: ['municipal_registered'],
    relevant: (f) => f.place === 'street',
    answered: (f) => f.municipal_registered != null,
    options: () => [
      { id: 'yes', emoji: '✅', label: 'Yes, I have a vending certificate', example: 'Issued by the municipality / Town Vending Committee' },
      { id: 'no', emoji: '❌', label: 'No', example: 'Not registered yet' },
      { id: 'unsure', emoji: '🤔', label: 'Not sure', example: "We'll treat it as not registered" },
    ],
    value: (f) => (f.municipal_registered == null ? null : [f.municipal_registered ? 'yes' : 'no']),
    valid: () => true,
    apply: ([id]) => ({ municipal_registered: id === 'yes' }),
    show: (f) => (f.municipal_registered ? 'Yes' : 'No'),
  },
  {
    // Workflow step 7: every premise needs its own approval; a multi-state head office needs a Central Licence.
    id: 'locations',
    title: (f) => (f.place === 'vehicles' ? 'Where do your vehicles run?' : 'Do you run it from more than one place?'),
    keys: ['locations'],
    relevant: (f) => isFoodBusiness(f) && !isDeemed(f) && !impliedBy(f, 'locations'),
    answered: (f) => f.locations != null,
    options: (f) =>
      f.place === 'vehicles'
        ? [
            { id: 'one', emoji: '📍', label: 'Within one state', example: 'All trips start and end in one state' },
            { id: 'multistate', emoji: '🗺️', label: 'Across states', example: 'Vehicles based in or running through more than one state' },
          ]
        : [
            { id: 'one', emoji: '📍', label: 'Just one place', example: 'One shop, kitchen, unit or stall' },
            { id: 'many', emoji: '🏘️', label: 'Several places, one state', example: 'Two or more outlets or units in the same state' },
            { id: 'multistate', emoji: '🗺️', label: 'Places in more than one state', example: 'Outlets, units or offices in two or more states' },
          ],
    value: (f) => (f.locations ? [f.locations] : null),
    apply: ([id]) => ({ locations: id }),
    show: (f) => LOCATIONS_LABEL[f.locations],
  },
  {
    id: 'state',
    kind: 'states',
    multi: (f) => f.locations === 'multistate',
    title: (f) => (f.locations === 'multistate' ? 'Which states are you in?' : 'Which state is your business in?'),
    hint: (f) => (f.locations === 'multistate' ? 'Tap every state where you have a place of business.' : null),
    keys: ['states'],
    relevant: isFoodBusiness,
    answered: (f) => (f.states || []).length > 0,
    value: () => null,
    valid: (f) => (f.locations === 'multistate' ? f.states.length >= 2 : f.states.length === 1 || f.locations == null),
    show: (f) => (f.states || []).join(', '),
  },
  {
    id: 'online',
    title: 'Do you sell online?',
    keys: ['sells_online', 'ecommerce_platform'],
    relevant: (f) => isFoodBusiness(f) && !isDeemed(f) && !storageOrTransportOnly(f),
    answered: (f) => f.ecommerce_platform != null,
    options: () => [
      { id: 'no', emoji: '🙅', label: 'No', example: 'Only in person / offline' },
      { id: 'seller', emoji: '📱', label: 'Yes, on apps as a seller', example: 'Swiggy, Zomato, Amazon, Flipkart, my own website' },
      { id: 'platform', emoji: '🌐', label: 'I run a food marketplace', example: 'An app or website where OTHER sellers list their food' },
    ],
    value: (f) => (f.ecommerce_platform == null ? null : [f.ecommerce_platform ? 'platform' : f.sells_online ? 'seller' : 'no']),
    apply: ([id]) => ({ sells_online: id !== 'no', ecommerce_platform: id === 'platform' }),
    show: (f) => (f.ecommerce_platform ? 'Runs a food marketplace' : f.sells_online ? 'Sells on apps / own website' : 'Offline only'),
  },
  {
    // Workflow step 6, asked only when no mandatory Central Licence already applies.
    id: 'turnover',
    title: 'Roughly how much do you sell in a year?',
    hint: 'Just starting? Pick what you expect in your first year.',
    keys: ['turnover_crore'],
    relevant: (f) => isFoodBusiness(f) && !isDeemed(f) && !hasCentralOverride(f),
    answered: (f) => f.turnover_crore != null,
    options: () => TURNOVER_OPTIONS,
    value: (f) => (f.turnover_crore == null ? null : [TURNOVER_OPTIONS.find((o) => f.turnover_crore <= o.value)?.id || 't4']),
    valid: () => true,
    apply: ([id]) => ({ turnover_crore: TURNOVER_OPTIONS.find((o) => o.id === id).value }),
    show: (f) => formatTurnover(f.turnover_crore),
  },
]

const TURNOVER_OPTIONS = [
  { id: 't2', emoji: '🌱', label: 'Up to ₹1.5 crore', example: 'Up to about ₹41,000 a day — a stall, home business, shop or small restaurant', value: 1.5 },
  { id: 't3', emoji: '🌳', label: '₹1.5 crore – ₹50 crore', example: 'Up to about ₹13.7 lakh a day — a factory or restaurant chain', value: 50 },
  { id: 't4', emoji: '🏔️', label: 'More than ₹50 crore', example: 'A large manufacturer or distributor', value: 51 },
]

// ---------- Consistency arm: implied answers, unlikely combinations, contradictions ----------
// implied: when `when` holds, `key` is known without asking (home kitchen = one place). A different value is a contradiction.
// unlikely: possible but suspicious; the user confirms or changes one of the answers involved.
// Contradictions between a typed answer and earlier answers are stored in facts.conflicts by mergeInterpretation.
export const RULES = [
  {
    id: 'home-one-place', kind: 'implied', key: 'locations', value: 'one', questions: ['place', 'locations'],
    when: (f) => f.place === 'home',
    message: (f) => `You run it from ${homeName(f)}, but also said you have several places. Which is right?`,
    fixLabel: (f) => (homeKitchen(f) ? 'Just one place: my home kitchen' : 'Just one place: my home'),
  },
  {
    id: 'home-high-sales', kind: 'unlikely', questions: ['place', 'turnover'],
    when: (f) => f.place === 'home' && f.turnover_crore > 1.5,
    message: (f) => `Sales above ₹1.5 crore a year are unusual for a business run from ${homeName(f)}. Is that right?`,
  },
  {
    id: 'street-high-sales', kind: 'unlikely', questions: ['place', 'turnover'],
    when: (f) => f.place === 'street' && f.turnover_crore > 1.5,
    message: 'Sales above ₹1.5 crore a year are unusual for a cart or stall. Is that right?',
  },
  {
    id: 'street-many-states', kind: 'unlikely', questions: ['place', 'locations'],
    when: (f) => f.place === 'street' && f.locations === 'multistate',
    message: 'Carts or stalls in more than one state are unusual. Is that right?',
  },
  {
    id: 'small-outlet-marketplace', kind: 'unlikely', questions: ['place', 'online'],
    when: (f) => (f.place === 'street' || f.place === 'home') && f.ecommerce_platform === true,
    message: 'You said you run a food marketplace (an app where other sellers list food). Selling your own food on Swiggy or Zomato is different. Which is right?',
  },
]

export function impliedBy(f, key) {
  return RULES.some((r) => r.kind === 'implied' && r.key === key && r.when(f))
}

/** Open issues, in order: contradictions from typed answers first, then rule breaks the user has not confirmed. */
export function divergences(f = {}) {
  const out = (f.conflicts || []).map((c) => ({ ...c, id: `conflict:${c.questionId}`, kind: 'conflict' }))
  for (const r of RULES) {
    if (!r.when(f)) continue
    if (r.kind === 'implied' ? f[r.key] != null && f[r.key] !== r.value : !(f.confirmed || []).includes(r.id)) out.push(r)
  }
  return out
}

/** Fill implied answers; drop ones whose reason no longer holds (e.g. moved from home kitchen to a shop). */
function applyImplied(facts) {
  const f = { ...facts }
  let marks = [...(f.implied || [])]
  for (const key of marks) if (!impliedBy(f, key)) delete f[key]
  marks = marks.filter((key) => impliedBy(f, key))
  for (const r of RULES) {
    if (r.kind === 'implied' && r.when(f) && f[r.key] == null) {
      f[r.key] = r.value
      if (!marks.includes(r.key)) marks.push(r.key)
    }
  }
  if (marks.length) f.implied = marks
  else delete f.implied
  return f
}

const clearPatch = (qid) => Object.fromEntries((RAW.find((q) => q.id === qid)?.keys || []).map((k) => [k, undefined]))
const CHANGE_LABEL = { activity: 'what I do', trade: 'what I sell', place: 'where I run it', locations: 'number of places', state: 'my states', online: 'selling online', turnover: 'my yearly sales' }

const CHECK = {
  id: 'check',
  title: (f) => {
    const d = divergences(f)[0]
    if (!d) return 'Just checking'
    if (d.kind !== 'conflict') return call(d.message, f)
    return d.added ? `You also mentioned "${d.added}". Should I add it?` : `Earlier you said "${d.was}", but that sounds like "${d.now}". Which is right?`
  },
  hint: () => 'Tap the one that is right.',
  keys: [],
  relevant: (f) => divergences(f).length > 0,
  answered: () => false,
  options: (f) => {
    const d = divergences(f)[0]
    if (!d) return []
    if (d.kind === 'conflict' && d.added) {
      return [
        { id: 'switch', emoji: '➕', label: 'Yes, add it', example: `Becomes: ${d.now}` },
        { id: 'keep', emoji: '↩️', label: 'No, leave it out', example: `Stays: ${d.was}` },
      ]
    }
    if (d.kind === 'conflict') {
      return [
        { id: 'keep', emoji: '↩️', label: `Keep: ${d.was}`, example: 'What I said before' },
        { id: 'switch', emoji: '✏️', label: `Change to: ${d.now}`, example: 'What I just wrote' },
      ]
    }
    const change = d.questions
      .filter((qid) => RAW.find((q) => q.id === qid)?.answered(f) && !(qid === d.key && d.kind === 'implied'))
      .map((qid) => ({ id: `change:${qid}`, emoji: '✏️', label: `Change ${CHANGE_LABEL[qid] || qid}`, example: `Now: ${RAW.find((q) => q.id === qid).show(f)}` }))
    return d.kind === 'implied'
      ? [{ id: 'set', emoji: '✅', label: call(d.fixLabel, f), example: 'Fix the other answer' }, ...change]
      : [{ id: 'confirm', emoji: '✅', label: "Yes, that's right", example: 'Keep my answers' }, ...change]
  },
  value: () => null,
  valid: () => true,
  apply: ([id], f) => {
    const d = divergences(f)[0]
    if (!d) return {}
    if (d.kind === 'conflict') {
      const rest = (f.conflicts || []).filter((c) => c.questionId !== d.questionId)
      return { ...(id === 'switch' ? d.patch : {}), conflicts: rest.length ? rest : undefined }
    }
    if (id === 'confirm') return { confirmed: [...(f.confirmed || []), d.id] }
    if (id === 'set') return { [d.key]: d.value }
    if (id.startsWith('change:')) return clearPatch(id.slice(7))
    return {}
  },
  show: () => '',
}

export const QUESTIONS = [CHECK, ...RAW].map((q) => ({ ...q, ask: (f = {}) => q.relevant(f) && !q.answered(f) }))

// ---------- Helpers used by client, server and the path checker ----------

const call = (x, f) => (typeof x === 'function' ? x(f) : x)
export const titleFor = (q, f = {}) => call(q.title, f)
export const hintFor = (q, f = {}) => call(q.hint, f) || null
export const isMulti = (q, f = {}) => !!call(q.multi, f)
export const optionsFor = (q, f = {}) => (q.options ? q.options(f) : [])

/** Is the question's current answer still consistent with the options the earlier answers allow? */
export function isAnswerValid(q, f) {
  if (!q.answered(f)) return true
  if (q.valid) return q.valid(f)
  const ids = optionsFor(q, f).map((o) => o.id)
  return (q.value(f) || []).every((id) => ids.includes(id))
}

export function formatTurnover(cr) {
  if (cr == null) return '—'
  if (cr <= 1.5) return 'Up to ₹1.5 crore / year'
  if (cr <= 50) return '₹1.5 – ₹50 crore / year'
  return 'Above ₹50 crore / year'
}

export const nextQuestion = (facts) => QUESTIONS.find((q) => q.ask(facts || {})) || null

export function clearQuestion(facts, questionId) {
  const q = QUESTIONS.find((x) => x.id === questionId)
  const next = { ...facts }
  q?.keys.forEach((k) => delete next[k])
  if (questionId === 'nonfood') delete next.nonfood_reason
  if (questionId === 'activity') delete next.food_business
  if (next.confirmed) {
    next.confirmed = next.confirmed.filter((id) => !RULES.find((r) => r.id === id)?.questions.includes(questionId))
    if (!next.confirmed.length) delete next.confirmed
  }
  if (next.conflicts) {
    next.conflicts = next.conflicts.filter((c) => c.questionId !== questionId)
    if (!next.conflicts.length) delete next.conflicts
  }
  return next
}

/** Clear answers that earlier answers made impossible (e.g. "street cart" after switching to "make or pack"). */
export function reconcile(facts) {
  let f = applyImplied(facts)
  for (let pass = 0; pass < QUESTIONS.length; pass++) {
    const bad = QUESTIONS.find((q) => q.relevant(f) && !isAnswerValid(q, f))
    if (!bad) break
    f = applyImplied(clearQuestion(f, bad.id))
  }
  return f
}

/** Apply a tap answer. Returns the new facts, or throws a user-facing message for an invalid pick. */
export function applyTap(facts, q, { optionIds, states }) {
  if (q.kind === 'states') {
    const picked = sanitizeFacts({ states: Array.isArray(states) ? states : [] }).states || []
    if (!picked.length) throw new Error('Pick a state.')
    if (isMulti(q, facts) && picked.length < 2) throw new Error('Pick at least two states, or change your answer about locations.')
    if (!isMulti(q, facts) && picked.length > 1) throw new Error('Pick one state.')
    return { facts: reconcile({ ...facts, states: picked }), answer: picked.join(', ') }
  }
  const opts = optionsFor(q, facts)
  let ids = [...new Set((Array.isArray(optionIds) ? optionIds : []).filter((o) => opts.some((x) => x.id === o)))]
  if (ids.some((id) => opts.find((o) => o.id === id).exclusive)) ids = ids.filter((id) => opts.find((o) => o.id === id).exclusive).slice(0, 1)
  if (!ids.length || (!isMulti(q, facts) && ids.length !== 1)) throw new Error('Pick an option.')
  return {
    facts: reconcile(sanitizeFacts({ ...facts, ...q.apply(ids, facts) })),
    answer: ids.map((o) => opts.find((x) => x.id === o).label).join(', '),
  }
}

const BOOL_KEYS = ['food_business', 'municipal_registered', 'sells_online', 'ecommerce_platform', 'opt_in_registration']
const ENUMS = {
  place: Object.keys(PLACE_LABEL),
  locations: Object.keys(LOCATIONS_LABEL),
  nonfood_reason: ['family', 'own-use', 'non-food'],
}

/** Coerce untrusted facts (from the LLM, the client or older records) into the known shape. */
export function sanitizeFacts(input) {
  const f = {}
  const src = input && typeof input === 'object' ? input : {}
  if (Array.isArray(src.activities)) f.activities = [...new Set(src.activities.filter((a) => ACTIVITY_LABEL[a]))]
  else if (Array.isArray(src.kob) || src.importer === true) {
    // Older records and model output may describe the business by Kind of Business instead of activities.
    const kob = Array.isArray(src.kob) ? src.kob : []
    const a = []
    if (kob.includes('foodService')) a.push('cook')
    if (kob.includes('manufacturer')) a.push('make')
    if (kob.includes('tradeRetailStorageTransport') && !(src.importer === true && kob.length === 1)) a.push('sell')
    if (src.importer === true) a.push('import')
    if (a.length) f.activities = a
  }
  if (Array.isArray(src.trade)) {
    const t = [...new Set(src.trade.filter((x) => TRADE_LABEL[x]))]
    if (t.length) f.trade = t
  }
  for (const k of BOOL_KEYS) if (typeof src[k] === 'boolean') f[k] = src[k]
  for (const [k, allowed] of Object.entries(ENUMS)) if (allowed.includes(src[k])) f[k] = src[k]
  if (!f.place) {
    if (src.is_street_vendor === true) f.place = 'street'
    else if (src.govt_airport_seaport_railway === true) f.place = 'hub'
    else if (src.home_based === true) f.place = 'home'
    else if (src.is_street_vendor === false) f.place = 'premises'
  }
  const t = Number(src.turnover_crore)
  if (src.turnover_crore != null && src.turnover_crore !== '' && Number.isFinite(t) && t >= 0 && t < 1e6) f.turnover_crore = t
  if (Array.isArray(src.states)) {
    const s = [...new Set(src.states.map(matchState).filter(Boolean))]
    if (s.length) f.states = s
  }
  if (Array.isArray(src.products)) f.products = src.products.map((p) => String(p).trim().slice(0, 60)).filter(Boolean).slice(0, 20)
  if (typeof src.city === 'string' && src.city.trim()) f.city = src.city.trim().slice(0, 60)
  if (typeof src.description === 'string' && src.description.trim()) f.description = src.description.trim().slice(0, 500)
  if (Array.isArray(src.confirmed)) {
    const c = [...new Set(src.confirmed.filter((id) => RULES.some((r) => r.id === id && r.kind === 'unlikely')))]
    if (c.length) f.confirmed = c
  }
  if (Array.isArray(src.implied)) {
    const m = [...new Set(src.implied.filter((k) => RULES.some((r) => r.kind === 'implied' && r.key === k)))]
    if (m.length) f.implied = m
  }
  if (Array.isArray(src.conflicts)) {
    const c = src.conflicts
      .filter((x) => x && RAW.some((q) => q.id === x.questionId) && x.patch && typeof x.patch === 'object')
      .slice(0, 5)
      .map((x) => ({
        questionId: x.questionId,
        patch: Object.fromEntries(Object.entries(x.patch).filter(([k]) => RAW.find((q) => q.id === x.questionId).keys.includes(k))),
        was: String(x.was || '').slice(0, 120),
        now: String(x.now || '').slice(0, 120),
        ...(x.added ? { added: String(x.added).slice(0, 120) } : {}),
      }))
    if (c.length) f.conflicts = c
  }
  if (f.activities?.length) delete f.food_business
  if (f.food_business !== false) delete f.nonfood_reason
  if (!f.activities?.includes('sell')) delete f.trade
  if (f.place !== 'street') delete f.municipal_registered
  // Derived Kind of Business groups (workflow step 5) and the importer flag.
  if (f.activities) {
    const kob = []
    if (f.activities.includes('cook')) kob.push('foodService')
    if (f.activities.includes('make')) kob.push('manufacturer')
    if (f.activities.includes('sell') || f.activities.includes('import')) kob.push('tradeRetailStorageTransport')
    f.kob = kob
    f.importer = f.activities.includes('import')
  }
  return f
}

/**
 * Merge an interpreted typed answer ({ choice, facts }) from any interpreter layer.
 * A matched option is applied exactly like a tap. Other facts fill questions not answered yet; when they
 * disagree with an earlier answer they become a conflict the user resolves ("Earlier you said X…").
 * Lists only ever grow (a typed "we also make pickles" adds to the activities rather than replacing them).
 */
export function mergeInterpretation(facts, q, { choice = [], facts: raw = {} }, text) {
  const extra = { ...raw }
  const rupees = Number(extra.annual_sales_rupees)
  if (Number.isFinite(rupees) && rupees > 0) extra.turnover_crore = rupees / 1e7
  delete extra.annual_sales_rupees
  for (const k of ['activities', 'trade', 'states', 'products']) {
    if (Array.isArray(extra[k]) && Array.isArray(facts[k])) extra[k] = [...new Set([...facts[k], ...extra[k]])]
  }
  const opts = optionsFor(q, facts)
  const ids = (Array.isArray(choice) ? choice : []).filter((c) => opts.some((o) => o.id === c))
  const picked = ids.length && (isMulti(q, facts) || ids.length === 1) ? q.apply(ids, facts) : {}

  const candidate = sanitizeFacts({ ...facts, ...extra })
  const changed = Object.keys(candidate).filter(
    (k) => !['kob', 'importer', 'description', 'implied', 'confirmed', 'conflicts'].includes(k) && JSON.stringify(candidate[k]) !== JSON.stringify(facts[k]),
  )
  const merged = { ...facts }
  const conflicts = [...(facts.conflicts || [])]
  const byQuestion = new Map()
  for (const k of changed) {
    const owner = RAW.find((x) => x.keys.includes(k))
    if (!owner || owner.id === q.id || !owner.answered(facts) || !owner.relevant(facts)) merged[k] = candidate[k]
    else byQuestion.set(owner, { ...byQuestion.get(owner), [k]: candidate[k] })
  }
  for (const [owner, patch] of byQuestion) {
    const after = sanitizeFacts({ ...facts, ...patch })
    if (owner.show(after) === owner.show(facts) || !isAnswerValid(owner, after)) continue
    const i = conflicts.findIndex((c) => c.questionId === owner.id)
    // A list that only grew is an addition ("we also make pickles"), not a contradiction.
    const grown = Object.entries(patch).every(([k, v]) => Array.isArray(v) && Array.isArray(facts[k]) && facts[k].every((x) => v.includes(x)))
    const added = grown && owner.show(sanitizeFacts({ ...facts, ...Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, v.filter((x) => !facts[k].includes(x))])) }))
    const conflict = { questionId: owner.id, patch, was: owner.show(facts), now: owner.show(after), ...(added ? { added } : {}) }
    if (i >= 0) conflicts[i] = conflict
    else conflicts.push(conflict)
  }
  return reconcile(
    sanitizeFacts({
      ...merged,
      ...picked,
      conflicts: conflicts.length ? conflicts : undefined,
      description: facts.description || String(text || '').trim().slice(0, 500),
    }),
  )
}
