// FSSAI licensing eligibility engine — mirrors the 2026 FSSAI Registration &
// Licensing Workflow (turnover thresholds effective 1 April 2026).

export const KOB_OPTIONS = [
  { id: 'manufacturer', label: 'Manufacturing / Processing / Repacking' },
  { id: 'tradeRetailStorageTransport', label: 'Trade / Retail / Storage / Transport' },
  { id: 'foodService', label: 'Food Service (Restaurant / Caterer / Canteen)' },
]

export const SPECIAL_CATEGORY_OPTIONS = [
  { id: 'importer', label: 'Importer of food items' },
  { id: 'ecommerce', label: 'E-commerce food business operator' },
  { id: 'multiStateHeadOffice', label: 'Head / Registered office operating in more than one State/UT' },
  { id: 'govtAirportSeaportRailway', label: 'Central Govt. / Airport / Seaport / Railway premises' },
]

const SPECIAL_CATEGORY_LABELS = Object.fromEntries(
  SPECIAL_CATEGORY_OPTIONS.map((o) => [o.id, o.label]),
)

export const EFFECTIVE_DATE = '1 April 2026'

export const LICENCE = {
  REGISTRATION: 'FSSAI Registration',
  STATE: 'State Licence',
  CENTRAL: 'Central Licence',
}

/**
 * @param {object} input
 * @param {number} input.turnoverCrore - annual turnover in INR crore
 * @param {string[]} input.kob - subset of KOB_OPTIONS ids
 * @param {string[]} input.specialCategories - subset of SPECIAL_CATEGORY_OPTIONS ids
 * @param {boolean} input.isStreetVendor
 * @param {boolean} input.municipalRegistered
 */
export function checkEligibility({
  turnoverCrore = 0,
  kob = [],
  specialCategories = [],
  isStreetVendor = false,
  municipalRegistered = false,
} = {}) {
  const reasons = []

  // 1. Deemed registration for municipally-registered street vendors.
  if (isStreetVendor && municipalRegistered) {
    return {
      outcome: 'deemed',
      licence: null,
      overrideApplied: false,
      specialCategoriesTriggered: [],
      kob,
      reasons: [
        'Deemed FSSAI-registered under the Street Vendors (Protection of Livelihood and Regulation of Street Vending) Act, 2014.',
      ],
      guidance:
        'Maintain hygiene and safety compliance per the FSS Act. No FSSAI application is required.',
      upsell:
        'Optional: many street vendors still apply for FSSAI Registration to display the logo and build consumer trust.',
    }
  }

  if (isStreetVendor && !municipalRegistered) {
    reasons.push(
      'As a street vendor not yet registered with your local Municipal Corporation / Town Vending Committee, you most likely qualify for FSSAI Registration based on turnover.',
    )
  }

  // 2. Mandatory Central Licence overrides — independent of turnover.
  const triggered = specialCategories.filter((id) => SPECIAL_CATEGORY_LABELS[id])
  if (triggered.length > 0) {
    const labels = triggered.map((id) => SPECIAL_CATEGORY_LABELS[id])
    return {
      outcome: 'override',
      licence: LICENCE.CENTRAL,
      overrideApplied: true,
      specialCategoriesTriggered: triggered,
      kob,
      reasons: [
        ...reasons,
        `Central Licence is mandatory for: ${labels.join(', ')}.`,
        'This overrides the turnover-based calculation below.',
      ],
      effectiveDate: EFFECTIVE_DATE,
    }
  }

  // 3. Turnover-based classification (effective 1 April 2026).
  let licence
  let bracket
  if (turnoverCrore <= 1.5) {
    licence = LICENCE.REGISTRATION
    bracket = 'Your annual turnover is ≤ ₹1.5 Crore, which qualifies for FSSAI Registration.'
  } else if (turnoverCrore <= 50) {
    licence = LICENCE.STATE
    bracket =
      'Your annual turnover is between ₹1.5 Crore and ₹50 Crore, which requires a State Licence.'
  } else {
    licence = LICENCE.CENTRAL
    bracket = 'Your annual turnover exceeds ₹50 Crore, which requires a Central Licence.'
  }

  return {
    outcome: 'turnover',
    licence,
    overrideApplied: false,
    specialCategoriesTriggered: [],
    reasons: [...reasons, bracket],
    effectiveDate: EFFECTIVE_DATE,
    kob,
  }
}

// --- Unified application status vocabulary (mirrors the flowchart's decision outcomes) ---

export const STATUS = {
  DRAFT: 'DRAFT',
  SUBMITTED: 'SUBMITTED',
  UNDER_SCRUTINY: 'UNDER_SCRUTINY',
  CLARIFICATION_REQUESTED: 'CLARIFICATION_REQUESTED',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
}

export const STATUS_META = {
  [STATUS.DRAFT]: { label: 'Draft', color: 'slate' },
  [STATUS.SUBMITTED]: { label: 'Submitted', color: 'blue' },
  [STATUS.UNDER_SCRUTINY]: { label: 'Under Scrutiny', color: 'amber' },
  [STATUS.CLARIFICATION_REQUESTED]: { label: 'Clarification Requested', color: 'orange' },
  [STATUS.APPROVED]: { label: 'Approved', color: 'green' },
  [STATUS.REJECTED]: { label: 'Rejected', color: 'red' },
}

export function generateApplicationReference() {
  let ref = ''
  for (let i = 0; i < 17; i++) ref += Math.floor(Math.random() * 10)
  return ref
}

export function generateLicenceNumber() {
  let ref = ''
  for (let i = 0; i < 14; i++) ref += Math.floor(Math.random() * 10)
  return ref
}
