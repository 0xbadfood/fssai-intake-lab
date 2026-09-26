// Turns intake facts into: licence verdict, which form (A/B), details to collect, documents to upload.
// Shared by client and server (no JSX / browser APIs).
import { checkEligibility, LICENCE } from './eligibility.js'
import { ACTIVITY_LABEL, KOB_LABEL, TRADE_LABEL, formatTurnover, isNotFood, matchState, nextQuestion } from './intakeQuestions.js'

export const GOVT_FEE_PER_YEAR = { [LICENCE.REGISTRATION]: 100, [LICENCE.STATE]: 2000, [LICENCE.CENTRAL]: 7500 }

export function eligibilityFromFacts(f = {}) {
  // Workflow step 1: not a food business under the FSS Act.
  if (isNotFood(f)) {
    return {
      outcome: 'notfood',
      licence: null,
      reasons: ['What you described is not a food business under the FSS Act, so FSSAI approval is not required.'],
      guidance: 'If you start selling, serving, making, storing or transporting food for others, you will need FSSAI registration or a licence.',
    }
  }
  const specialCategories = []
  if (f.importer) specialCategories.push('importer')
  if (f.ecommerce_platform) specialCategories.push('ecommerce')
  if (f.locations === 'multistate' || (f.states || []).length > 1) specialCategories.push('multiStateHeadOffice')
  if (f.place === 'hub') specialCategories.push('govtAirportSeaportRailway')
  const e = checkEligibility({
    turnoverCrore: f.turnover_crore ?? 0,
    kob: f.kob || [],
    specialCategories,
    isStreetVendor: f.place === 'street',
    municipalRegistered: f.place === 'street' && !!f.municipal_registered,
  })
  if (e.outcome === 'deemed' && f.opt_in_registration) {
    return { ...e, outcome: 'optin', licence: LICENCE.REGISTRATION, reasons: [...e.reasons, 'You chose to apply for FSSAI Registration anyway.'] }
  }
  const notes = []
  // Workflow step 7: one approval per premise (transporters are licensed once for their vehicles).
  if (f.locations === 'multistate' && f.place !== 'vehicles') {
    notes.push('The Central Licence covers your head office. Each outlet or unit also needs its own registration or licence, based on its own turnover.')
  } else if (f.locations === 'many') {
    notes.push('Each place of business needs its own registration or licence. We start with one and repeat it for the others.')
  }
  // Workflow step 8: the application route on FoSCoS.
  if (f.place === 'hub') notes.push('Filed on the airport / seaport / railway route of FoSCoS, which handles these premises.')
  return notes.length ? { ...e, reasons: [...e.reasons, ...notes] } : e
}

/** 'A' (registration), 'B' (state/central licence) or null (nothing to file). */
export const formKind = (e) => (!e?.licence ? null : e.licence === LICENCE.REGISTRATION ? 'A' : 'B')

// ---------- Details (Form A/B fields). Mostly taps; typing only where unavoidable. ----------

const PRODUCT_SUGGESTIONS = {
  foodService: ['Meals & thalis', 'Snacks & fast food', 'Sweets & desserts', 'Tea, coffee & juices', 'Bakery items', 'Tiffin / meal boxes'],
  manufacturer: ['Bakery products', 'Namkeen & snacks', 'Pickles & preserves', 'Spices & masalas', 'Dairy products', 'Sweets & confectionery', 'Edible oil', 'Ready-to-eat food', 'Packaged drinking water'],
  tradeRetailStorageTransport: ['Groceries & provisions', 'Packaged foods', 'Fruits & vegetables', 'Dairy products', 'Beverages', 'Meat & fish'],
  importer: ['Edible oils', 'Dry fruits & nuts', 'Chocolates & confectionery', 'Beverages', 'Packaged foods', 'Food ingredients'],
}

export function productSuggestions(f = {}) {
  const lists = [...(f.kob || []).map((k) => PRODUCT_SUGGESTIONS[k]), f.importer ? PRODUCT_SUGGESTIONS.importer : null].filter(Boolean)
  return [...new Set([...(f.products || []), ...lists.flat()])]
}

const has = (f, k) => (f.kob || []).includes(k)

export const FIELDS = [
  { id: 'legal_name', section: 'Business', label: 'Business name', type: 'text', example: 'Sharma Foods' },
  { id: 'entity_type', section: 'Business', label: 'Type of business', type: 'choice', options: ['Proprietorship', 'Partnership', 'LLP', 'Private Ltd company', 'Public Ltd company', 'Trust / Society / Co-op'] },
  { id: 'products', section: 'Business', label: 'What food do you make or sell?', type: 'multichoice', suggestions: productSuggestions },
  { id: 'operating_since', section: 'Business', label: 'How long have you been running?', type: 'choice', options: ['Not started yet', 'Less than 1 year', '1–5 years', 'More than 5 years'] },

  { id: 'applicant_name', section: 'You', label: 'Your full name', type: 'text', example: 'Rahul Kumar Sharma' },
  { id: 'designation', section: 'You', label: 'Your role', type: 'choice', options: ['Owner / Proprietor', 'Partner', 'Director', 'Manager', 'Authorised signatory'] },
  { id: 'mobile', section: 'You', label: 'Mobile number', type: 'text', example: '98765 43210', inputMode: 'tel' },
  { id: 'email', section: 'You', label: 'Email', type: 'text', example: 'you@business.com', inputMode: 'email' },

  { id: 'premises_address', section: 'Premises', label: 'Address of the premises', type: 'text', example: 'Shop 4, Ganesh Market, MG Road' },
  { id: 'city', section: 'Premises', label: 'City / town', type: 'text', example: 'Pune' },
  { id: 'pincode', section: 'Premises', label: 'PIN code', type: 'text', example: '411001', inputMode: 'numeric' },
  { id: 'state', section: 'Premises', label: 'State', type: 'choice', options: (f) => f.states || [], hideIfSingle: true },

  { id: 'employees', section: 'Operations', label: 'How many people work there?', type: 'choice', options: ['1–5', '6–20', '21–50', '51–200', 'More than 200'], forms: ['B'] },
  { id: 'water_source', section: 'Operations', label: 'Where does your water come from?', type: 'choice', options: ['Municipal supply', 'Borewell', 'Tanker / packaged water', 'Water not used'], forms: ['B'] },
  { id: 'capacity', section: 'Operations', label: 'How much do you produce per day?', type: 'choice', options: ['Up to 100 kg / L', '100 kg – 2 tonnes', '2 – 10 tonnes', 'More than 10 tonnes'], forms: ['B'], when: (f) => has(f, 'manufacturer') },
  { id: 'seating', section: 'Operations', label: 'How many seats for customers?', type: 'choice', options: ['Takeaway / delivery only', 'Up to 20', '21–50', 'More than 50'], forms: ['B'], when: (f) => has(f, 'foodService') },
  { id: 'vehicles', section: 'Operations', label: 'Food transport vehicles you own', type: 'choice', options: ['None', '1', '2–5', 'More than 5'], forms: ['B'], when: (f) => (f.trade || []).includes('transport') },
  { id: 'storage_type', section: 'Operations', label: 'What kind of storage?', type: 'choice', options: ['Dry storage / godown', 'Cold storage', 'Both'], forms: ['B'], when: (f) => (f.trade || []).includes('storage') },
  { id: 'iec_number', section: 'Operations', label: 'Import Export Code (IEC)', type: 'text', example: '0512345678', inputMode: 'numeric', when: (f) => !!f.importer },
]

export function fieldsFor(facts, e) {
  const kind = formKind(e)
  return FIELDS.filter((fd) => (!fd.forms || fd.forms.includes(kind)) && (!fd.when || fd.when(facts)))
}

const filled = (v) => (Array.isArray(v) ? v.length > 0 : typeof v === 'string' ? v.trim() !== '' : v != null)

export function missingFields(facts, e, info = {}) {
  return fieldsFor(facts, e).filter((fd) => !filled(info[fd.id]))
}

const titleCase = (x) => x.toLowerCase().replace(/\b\p{L}/gu, (c) => c.toUpperCase())
const clean = (x) => (typeof x === 'string' && x.trim() && x.trim().toLowerCase() !== 'null' ? x.trim() : null)

/** Facts read from accepted document photos, normalised by code. Each value carries its source label. */
export function docFacts(docsByType = {}) {
  const out = {}
  const id = isDocOk(docsByType.identity) ? docsByType.identity.verification?.extracted || {} : {}
  const addr = isDocOk(docsByType.address) ? docsByType.address.verification?.extracted || {} : {}
  const put = (k, v, source) => v && (out[k] = { value: v, source })
  const name = clean(id.holder_name)
  put('applicant_name', name && (name === name.toUpperCase() ? titleCase(name) : name), 'your ID')
  const line = clean(addr.address_line)
  put('premises_address', line && (line === line.toUpperCase() ? titleCase(line) : line), 'your electricity bill')
  const city = clean(addr.city)
  put('city', city && (city === city.toUpperCase() ? titleCase(city) : city), 'your electricity bill')
  put('pincode', (String(addr.pincode || '').match(/\b\d{6}\b/) || String(addr.address_line || '').match(/\b\d{6}\b/) || [])[0], 'your electricity bill')
  put('state', matchState(addr.state) || matchState(addr.address_line), 'your electricity bill')
  return out
}

/** Info with gaps filled from documents first, then account/intake. Returns { info, sources }. */
export function prefillInfo(facts = {}, user = {}, info = {}, docsByType = {}) {
  const fromDocs = docFacts(docsByType)
  const sources = {}
  const out = { ...info }
  if (out.state && !(facts.states || []).includes(out.state)) delete out.state
  const docState = fromDocs.state && (facts.states || []).includes(fromDocs.state.value) ? fromDocs.state : null
  const candidates = {
    applicant_name: [fromDocs.applicant_name, { value: user.name, source: 'your account' }],
    legal_name: [{ value: user.businessName, source: 'your account' }],
    mobile: [{ value: user.phone, source: 'your account' }],
    email: [{ value: user.email, source: 'your account' }],
    premises_address: [fromDocs.premises_address],
    city: [fromDocs.city, { value: facts.city, source: 'your answers' }],
    pincode: [fromDocs.pincode],
    state: [docState, { value: facts.states?.length === 1 ? facts.states[0] : undefined, source: 'your answers' }],
    products: [{ value: facts.products, source: 'your answers' }],
  }
  for (const [k, list] of Object.entries(candidates)) {
    if (filled(out[k])) continue
    const hit = list.find((c) => c && filled(c.value))
    if (hit) {
      out[k] = hit.value
      sources[k] = hit.source
    }
  }
  return { info: out, sources }
}

// ---------- Documents ----------

export function requiredDocuments(facts, e, info = {}) {
  const kind = formKind(e)
  if (!kind) return []
  const docs = [
    { id: 'identity', why: 'Photo ID of the person applying' },
    { id: 'address', why: 'Shows the address of your premises' },
  ]
  if (kind === 'B') {
    docs.push({ id: 'premise', why: 'Proves you can use the premises (owned, rented or NOC)' })
    if (has(facts, 'manufacturer')) {
      docs.push({ id: 'layout', why: 'Required for manufacturing units' })
      docs.push({ id: 'water-test', why: 'Water used in making food must be tested' })
    }
    if (has(facts, 'manufacturer') || has(facts, 'foodService')) docs.push({ id: 'noc', why: 'Needed in some states / municipalities', optional: true })
    if (facts.importer) docs.push({ id: 'importer-docs', why: 'Required for importers' })
    if (info.entity_type && info.entity_type !== 'Proprietorship') docs.push({ id: 'authority-letter', why: `Needed for ${info.entity_type === 'LLP' ? 'an LLP' : `a ${info.entity_type.toLowerCase()}`} to authorise the applicant` })
    if ((facts.place === 'vehicles' || (facts.trade || []).includes('transport')) && info.vehicles !== 'None') docs.push({ id: 'transporter-proof', why: 'Required when you transport food' })
  }
  return docs
}

export const isDocOk = (doc) => doc?.status === 'accepted' || doc?.status === 'review'

// ---------- Overall readiness ----------

export function readiness(app, docsByType = {}) {
  const facts = app?.facts || {}
  const e = eligibilityFromFacts(facts)
  const intakeDone = !nextQuestion(facts)
  const missing = intakeDone ? missingFields(facts, e, app?.info) : []
  const docs = intakeDone ? requiredDocuments(facts, e, app?.info) : []
  const missingDocs = docs.filter((d) => !d.optional && !isDocOk(docsByType[d.id]))
  return { e, kind: formKind(e), intakeDone, missing, docs, missingDocs, ready: intakeDone && !!formKind(e) && !missing.length && !missingDocs.length }
}

// ---------- Auto-generated Form A / B ----------

export function buildForm(app, docsByType, docLabels = {}) {
  const facts = app.facts || {}
  const info = app.info || {}
  const e = eligibilityFromFacts(facts)
  const kind = formKind(e)
  const v = (x) => (Array.isArray(x) ? x.join(', ') : x) || null
  const kob = (facts.kob || []).map((k) => KOB_LABEL[k])
  const sections = [
    {
      title: 'Particulars of the applicant',
      rows: [['Name of applicant', v(info.applicant_name)], ['Designation', v(info.designation)], ['Mobile', v(info.mobile)], ['Email', v(info.email)]],
    },
    {
      title: 'Particulars of the food business',
      rows: [
        ['Name of business', v(info.legal_name)],
        ['Constitution', v(info.entity_type)],
        ['Kind of business', v(kob)],
        ['Activities', v([...(facts.activities || []).map((a) => ACTIVITY_LABEL[a]), ...(facts.trade || []).map((t) => TRADE_LABEL[t])])],
        ['Food products / categories', v(info.products)],
        ['Operating since', v(info.operating_since)],
        ['Annual turnover', formatTurnover(facts.turnover_crore)],
        ['Sells online', facts.sells_online ? 'Yes' : 'No'],
      ],
    },
    {
      title: 'Address of the premises',
      rows: [['Address', v(info.premises_address)], ['City / town', v(info.city)], ['PIN code', v(info.pincode)], ['State', v(info.state)]],
    },
  ]
  if (kind === 'B') {
    const ops = [['Number of employees', v(info.employees)], ['Source of water', v(info.water_source)]]
    if (has(facts, 'manufacturer')) ops.push(['Production capacity per day', v(info.capacity)])
    if (has(facts, 'foodService')) ops.push(['Seating capacity', v(info.seating)])
    if ((facts.trade || []).includes('transport')) ops.push(['Transport vehicles', v(info.vehicles)])
    if ((facts.trade || []).includes('storage')) ops.push(['Storage', v(info.storage_type)])
    if (facts.importer) ops.push(['IEC number', v(info.iec_number)])
    if ((facts.states || []).length > 1) ops.push(['States of operation', v(facts.states)])
    sections.push({ title: 'Operations', rows: ops })
  } else if (facts.importer) {
    sections[1].rows.push(['IEC number', v(info.iec_number)])
  }
  sections.push({
    title: 'Documents enclosed',
    rows: requiredDocuments(facts, e, info).map((d) => {
      const doc = docsByType[d.id]
      return [docLabels[d.id] || d.id, isDocOk(doc) ? `✓ ${doc.file?.name || 'uploaded'}` : d.optional ? 'Not enclosed (optional)' : null]
    }),
  })
  const title = kind === 'A' ? 'Form A — Application for Registration' : `Form B — Application for ${e.licence}`
  return { kind, title, licence: e.licence, sections }
}
