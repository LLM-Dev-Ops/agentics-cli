/**
 * Phase 2 Pipeline — Stage 5: DDD Model Generator
 *
 * Generates a Domain-Driven Design model as markdown + JSON, driven by the
 * SPARC architecture output, ADRs, and research dossier.
 *
 * Produces bounded contexts (one per architecture service), a context map,
 * and a ubiquitous language glossary — all derived from actual SPARC/dossier
 * content rather than noun-extraction heuristics.
 *
 * Primary output: DDD markdown documents
 * Compat output: domain-model.json, context-map.json for downstream consumers
 *
 * Error codes:
 *   ECLI-P2-010  Missing prerequisite stage output (SPARC or ADR)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type {
  Phase2Context,
  Phase2StageOutput,
  Phase2SPARCOutput,
  Phase2ADRRecord,
  ResearchDossier,
  Phase2DomainModel,
  Phase2DDDBoundedContext,
  Phase2AggregateDefinition,
  Phase2Entity,
  Phase2ValueObject,
  Phase2DomainEvent,
  Phase2Command,
  Phase2Query,
  UbiquitousLanguageTerm,
  Phase2ContextRelation,
  SubdomainType,
} from '../types.js';
import { createSpan, endSpan, emitSpan } from '../telemetry.js';
import { createClaudeCodeRunner } from '../../../runtime/claude-code-runner.js';

// ============================================================================
// Constants
// ============================================================================

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const JSON_INDENT = 2;

/**
 * Load agentics fleet report from phase2Dir and format for LLM context.
 */
function loadAgenticsFleetContextForDDD(phase2Dir: string): string {
  try {
    const reportPath = path.join(phase2Dir, 'agentics-agents-report.json');
    if (!fs.existsSync(reportPath)) return '';
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf-8')) as {
      results?: Array<{ domain: string; agent: string; role: string; status: number; response: unknown }>;
    };
    if (!report.results || report.results.length === 0) return '';
    const successResults = report.results.filter(r => r.status === 200);
    if (successResults.length === 0) return '';
    const summaries = successResults.slice(0, 12).map(r => {
      const resp = r.response as Record<string, unknown> | undefined;
      const data = resp?.['data'] as Record<string, unknown> | undefined;
      let finding = '';
      if (data) {
        const vals = Object.values(data).filter(v => typeof v === 'string').slice(0, 2);
        finding = vals.map(v => String(v).slice(0, 100)).join('; ');
      }
      return `- [${r.domain}/${r.agent}] ${r.role}: ${finding || 'completed'}`;
    }).join('\n');
    return `\nAGENTICS FLEET ANALYSIS (${successResults.length} agents):\n${summaries}\n`;
  } catch { return ''; }
}

// ============================================================================
// Context Name Normalization
// ============================================================================

/**
 * Domain vocabulary for normalizing raw NLP-extracted context names into
 * canonical domain terms. Each entry maps a regex (matching raw fragments)
 * to a clean kebab-case domain term.
 *
 * Order matters: first match wins. More specific patterns come first.
 */
const DOMAIN_VOCABULARY: Array<[RegExp, string]> = [
  // Emissions / environmental reporting
  [/\b(?:emission|ghg|carbon|co2|greenhouse|scope[\s-]?[123])/i, 'emissions-tracking'],
  // Discrepancy / correction / remediation (before anomaly so "correct discrepancies" wins)
  [/\b(?:correct|remediat|rectif|resolv|fix).*(?:discrepanc|error|issue)/i, 'discrepancy-resolution'],
  [/\b(?:discrepanc).*(?:correct|resolv|remediat|fix)/i, 'discrepancy-resolution'],
  // Anomaly / detection (pure detection, not correction)
  [/\b(?:anomal|inconsisten|outlier|deviation)/i, 'anomaly-detection'],
  // Bare discrepancy without correction context → anomaly detection
  [/\b(?:discrepanc)/i, 'anomaly-detection'],
  // Environmental compliance / sustainability
  [/\b(?:sustainab|environment(?:al)?[\s-]?compliance|esg|csrd|tcfd|gri|cdp)/i, 'environmental-compliance'],
  // Waste / disposal / recycling
  [/\b(?:waste|disposal|recycl|hazardous|landfill|circular[\s-]?economy)/i, 'waste-management'],
  // Water / resource usage
  [/\b(?:water[\s-]?usage|water[\s-]?consump|effluent|water[\s-]?treatment)/i, 'water-management'],
  // Energy / consumption
  [/\b(?:energy[\s-]?consump|electricity|renewable|solar|wind|fossil[\s-]?fuel|kilowatt|megawatt)/i, 'energy-management'],
  // Regulatory / disclosure / filing
  [/\b(?:disclosure|filing|regulatory[\s-]?report|regulatory[\s-]?submiss)/i, 'regulatory-disclosure'],
  // Workflow / orchestration / lead / task routing
  [/\b(?:workflow|orchestrat|task[\s-]?rout|lead[\s-]?manag|work[\s-]?assign|dispatch)/i, 'workflow-orchestration'],
  // Bare "lead" as a standalone context (often means workflow coordination)
  [/^lead$/i, 'workflow-orchestration'],
  // Point of sale / POS / retail data ingestion (BEFORE promotion so "point-of-sale-retailers" wins)
  [/\b(?:point[\s-]?(?:of[\s-]?)?sale|pos[\s-]?data|retail[\s-]?(?:data|partner|point))/i, 'point-of-sale'],
  // Trade promotion / CPG / promotional effectiveness
  [/\b(?:promoti|trade[\s-]?promoti|trade[\s-]?spend|campaign[\s-]?effect|promo[\s-]?effect)/i, 'promotion-effectiveness'],
  // Budget / trade spending / financial planning
  [/\b(?:budget|trade[\s-]?spend|spend[\s-]?allocat|financial[\s-]?plan)/i, 'budget-management'],
  // Contract / retailer agreement
  [/\b(?:contract|retailer[\s-]?agreement|trade[\s-]?agreement|vendor[\s-]?contract)/i, 'contract-management'],
  // Cannibalization / sales displacement
  [/\b(?:cannibaliz|sales[\s-]?displace|channel[\s-]?shift|demand[\s-]?shift)/i, 'promotion-effectiveness'],
  // Underperforming / ineffective (promotion context)
  [/\b(?:underperform|ineffect|low[\s-]?roi|poor[\s-]?perform)/i, 'promotion-effectiveness'],
  // Inventory / stock
  [/\b(?:inventory|stock|warehouse|reorder|stockout)/i, 'inventory-optimization'],
  // Demand / forecasting
  [/\b(?:demand|forecast|predict|trend|seasonal)/i, 'demand-forecasting'],
  // Supply chain / coordination
  [/\b(?:supply[\s-]?chain|coordination|upstream|downstream)/i, 'supply-chain-coordination'],
  // Supply risk / imbalance / shortage
  [/\b(?:supply[\s-]?imbalance|shortage|surplus|supply[\s-]?risk|stockout|overstock)/i, 'supply-risk-detection'],
  // Procurement / sourcing
  [/\b(?:procurement|sourcing|purchas|vendor|supplier)/i, 'procurement-automation'],
  // Facility / transfer / warehouse movement
  [/\b(?:facility|transfer|warehouse[\s-]?movement|inter[\s-]?site|relocation)/i, 'facility-transfer'],
  // Compliance / audit
  [/\b(?:compliance|audit|regulat|inspection|certif)/i, 'compliance-auditing'],
  // Distribution / logistics / shipping
  [/\b(?:distribution|logistics|shipping|transport|delivery|route)/i, 'distribution-logistics'],
  // Quality
  [/\b(?:quality|defect|qa)/i, 'quality-assurance'],
  // Analytics / reporting / dashboard
  [/\b(?:analytics|dashboard|report|metric|kpi|visualization)/i, 'analytics-reporting'],
  // Order management
  [/\b(?:order|fulfillment|sales[\s-]?order|purchase[\s-]?order)/i, 'order-management'],
  // Customer / CRM
  [/\b(?:customer|crm|client|account[\s-]?management)/i, 'customer-management'],
  // Finance / billing
  [/\b(?:finance|billing|invoice|payment|accounting)/i, 'financial-ops'],
  // Production / manufacturing
  [/\b(?:production|manufactur|assembly|plant)/i, 'production-management'],
  // Monitoring / alerting
  [/\b(?:monitor|real[\s-]?time|alert|notification)/i, 'monitoring-alerts'],
  // Security / access
  [/\b(?:security|auth|access[\s-]?control|rbac|iam)/i, 'security-access'],
  // Mining / heavy equipment / predictive maintenance (BEFORE generic asset so "mining equipment" wins)
  [/\b(?:mining|mine[\s-]?site|ore|mineral|excavat|open[\s-]?pit|underground[\s-]?mine)/i, 'mining-operations'],
  [/\b(?:haul[\s-]?truck|loader|excavator|crusher|conveyor|drill[\s-]?rig|shovel)/i, 'equipment-telemetry'],
  [/\b(?:vibrat|bearing[\s-]?temp|oil[\s-]?analys|thermal[\s-]?imag|sensor[\s-]?data|iiot)/i, 'equipment-telemetry'],
  [/\b(?:predict(?:ive)?[\s-]?maint|condition[\s-]?monitor|failure[\s-]?predict|remaining[\s-]?useful[\s-]?life|rul\b)/i, 'predictive-maintenance'],
  [/\b(?:efficiency[\s-]?degrad|performance[\s-]?decay|throughput[\s-]?declin|degradat)/i, 'efficiency-degradation'],
  [/\b(?:production[\s-]?throughput|tonnage|output[\s-]?rate|processing[\s-]?rate|mill[\s-]?throughput)/i, 'production-throughput'],
  [/\b(?:fleet[\s-]?dispatch|fleet[\s-]?manag|vehicle[\s-]?track|gps[\s-]?track|dispatch[\s-]?optim)/i, 'fleet-dispatch'],
  [/\b(?:blast|drill[\s-]?pattern|fragmentation|blast[\s-]?optim)/i, 'blast-optimization'],
  [/\b(?:tailings|dam[\s-]?monitor|geotechnical|slope[\s-]?stabil)/i, 'geotechnical-monitoring'],
  // Asset / maintenance (generic fallback)
  [/\b(?:maintenance|asset|equipment)/i, 'asset-maintenance'],

  // ── Healthcare / Life Sciences ──
  [/\b(?:patient|ehr|electronic[\s-]?health[\s-]?record|medical[\s-]?record|emr)/i, 'patient-management'],
  [/\b(?:clinical[\s-]?trial|trial[\s-]?protocol|study[\s-]?design|randomiz|placebo)/i, 'clinical-trials'],
  [/\b(?:drug[\s-]?discover|molecule|compound|target[\s-]?identif|lead[\s-]?optim)/i, 'drug-discovery'],
  [/\b(?:pharmacovigilance|adverse[\s-]?event|drug[\s-]?safety|side[\s-]?effect)/i, 'pharmacovigilance'],
  [/\b(?:hipaa|phi|protected[\s-]?health|health[\s-]?data[\s-]?privacy)/i, 'health-data-compliance'],
  [/\b(?:fhir|hl7|icd[\s-]?10|snomed|health[\s-]?interop)/i, 'health-interoperability'],
  [/\b(?:lab[\s-]?result|diagnostic|pathology|radiology|imaging[\s-]?report)/i, 'diagnostics-lab'],
  [/\b(?:pharmacy|prescription|dispens|formulary|medication[\s-]?manag)/i, 'pharmacy-management'],
  [/\b(?:claim[\s-]?adjud|claim[\s-]?process|medical[\s-]?claim|denial[\s-]?manag)/i, 'claims-adjudication'],
  [/\b(?:telehealth|telemedicine|remote[\s-]?patient|virtual[\s-]?care|rpm)/i, 'telehealth'],
  [/\b(?:genomic|genome|dna|sequenc|biomarker|proteom)/i, 'genomics-analytics'],

  // ── Financial Services / Banking ──
  [/\b(?:trading|trade[\s-]?execut|order[\s-]?book|market[\s-]?mak|algo[\s-]?trad)/i, 'trade-execution'],
  [/\b(?:kyc|know[\s-]?your[\s-]?customer|aml|anti[\s-]?money[\s-]?launder|sanctions[\s-]?screen)/i, 'kyc-aml'],
  [/\b(?:loan[\s-]?originat|mortgage|underwriting[\s-]?credit|credit[\s-]?assess)/i, 'loan-origination'],
  [/\b(?:portfolio[\s-]?manag|asset[\s-]?allocat|rebalanc|wealth[\s-]?manag)/i, 'portfolio-management'],
  [/\b(?:fraud[\s-]?detect|fraud[\s-]?prevent|transaction[\s-]?monitor|suspicious[\s-]?activ)/i, 'fraud-detection'],
  [/\b(?:payment[\s-]?process|payment[\s-]?gateway|settlement|clearing[\s-]?house|swift|ach)/i, 'payment-processing'],
  [/\b(?:risk[\s-]?manag|credit[\s-]?risk|market[\s-]?risk|operational[\s-]?risk|var\b|value[\s-]?at[\s-]?risk)/i, 'risk-management'],
  [/\b(?:treasury|cash[\s-]?manag|liquidity|fund[\s-]?transfer)/i, 'treasury-management'],
  [/\b(?:core[\s-]?banking|account[\s-]?ledger|general[\s-]?ledger|double[\s-]?entry)/i, 'core-banking'],

  // ── Insurance ──
  [/\b(?:underwriting|risk[\s-]?assess|policy[\s-]?pric|actuarial[\s-]?model)/i, 'underwriting'],
  [/\b(?:claims[\s-]?process|claim[\s-]?filing|claim[\s-]?settl|loss[\s-]?adjust)/i, 'claims-processing'],
  [/\b(?:policy[\s-]?manag|policy[\s-]?admin|endorsement|renewal|cancellat)/i, 'policy-administration'],
  [/\b(?:reinsurance|retrocession|treaty|facultative)/i, 'reinsurance'],
  [/\b(?:actuari|loss[\s-]?ratio|combined[\s-]?ratio|reserve[\s-]?estimat)/i, 'actuarial-analytics'],

  // ── Telecom ──
  [/\b(?:network[\s-]?operat|noc|cell[\s-]?tower|base[\s-]?station|ran\b|radio[\s-]?access)/i, 'network-operations'],
  [/\b(?:subscriber|sim[\s-]?manag|number[\s-]?portab|msisdn|imsi)/i, 'subscriber-management'],
  [/\b(?:cdr|call[\s-]?detail|billing[\s-]?mediat|usage[\s-]?record|rating[\s-]?engine)/i, 'billing-mediation'],
  [/\b(?:spectrum|frequency[\s-]?allocat|bandwidth[\s-]?manag)/i, 'spectrum-management'],
  [/\b(?:service[\s-]?provision|activation|deactivat|service[\s-]?fulfil)/i, 'service-provisioning'],
  [/\b(?:oss|bss|telecom[\s-]?operation|network[\s-]?inventory)/i, 'telecom-oss-bss'],

  // ── Oil & Gas ──
  [/\b(?:reservoir|well[\s-]?log|seismic|subsurface|petrophysic)/i, 'reservoir-engineering'],
  [/\b(?:drill(?:ing)?[\s-]?operat|wellbore|mud[\s-]?log|bit[\s-]?optim|rig[\s-]?schedul)/i, 'drilling-operations'],
  [/\b(?:pipeline[\s-]?monitor|pipeline[\s-]?integrit|pig[\s-]?run|leak[\s-]?detect|corrosion)/i, 'pipeline-integrity'],
  [/\b(?:refin(?:ery|ing)|crude[\s-]?process|distillat|cracking|hydrocarbon)/i, 'refinery-operations'],
  [/\b(?:upstream|midstream|downstream|field[\s-]?develop|fpso)/i, 'field-operations'],
  [/\b(?:well[\s-]?complet|fracking|hydraulic[\s-]?fractur|stimulat)/i, 'well-completions'],

  // ── Agriculture / AgTech ──
  [/\b(?:crop[\s-]?manag|crop[\s-]?monitor|planting|harvest|growing[\s-]?season)/i, 'crop-management'],
  [/\b(?:precision[\s-]?farm|precision[\s-]?ag|variable[\s-]?rate|ndvi|satellite[\s-]?imag)/i, 'precision-agriculture'],
  [/\b(?:soil[\s-]?analy|soil[\s-]?health|soil[\s-]?moist|nutrient[\s-]?manag|fertiliz)/i, 'soil-analytics'],
  [/\b(?:irrigat|water[\s-]?schedul|drip[\s-]?system|pivot[\s-]?irrigat)/i, 'irrigation-management'],
  [/\b(?:livestock|herd[\s-]?manag|cattle|poultry|animal[\s-]?health|feed[\s-]?manag)/i, 'livestock-management'],
  [/\b(?:yield[\s-]?optim|yield[\s-]?predict|yield[\s-]?estimat|crop[\s-]?yield)/i, 'yield-optimization'],
  [/\b(?:grain[\s-]?storage|silo|post[\s-]?harvest|cold[\s-]?chain[\s-]?ag)/i, 'post-harvest-logistics'],

  // ── Construction / Real Estate ──
  [/\b(?:bim|building[\s-]?information|3d[\s-]?model|revit|ifc)/i, 'bim-management'],
  [/\b(?:construction[\s-]?project|job[\s-]?site|general[\s-]?contract|subcontract)/i, 'construction-project'],
  [/\b(?:safety[\s-]?compliance|osha|incident[\s-]?report|safety[\s-]?inspect|ppe)/i, 'safety-compliance'],
  [/\b(?:material[\s-]?manag|bill[\s-]?of[\s-]?material|bom|takeoff|estimat[\s-]?cost)/i, 'materials-management'],
  [/\b(?:property[\s-]?manag|tenant|lease[\s-]?manag|rent[\s-]?collect|occupancy)/i, 'property-management'],
  [/\b(?:appraisal|property[\s-]?valuat|comparable|market[\s-]?analys[\s-]?real)/i, 'property-valuation'],
  [/\b(?:mls|listing|real[\s-]?estate[\s-]?listing|showing[\s-]?schedul)/i, 'listing-management'],

  // ── Utilities / Energy Grid ──
  [/\b(?:grid[\s-]?manag|power[\s-]?grid|transmission|distribution[\s-]?grid|feeder)/i, 'grid-management'],
  [/\b(?:smart[\s-]?meter|meter[\s-]?data|ami|advanced[\s-]?metering|mdm)/i, 'meter-data-management'],
  [/\b(?:outage[\s-]?manag|outage[\s-]?detect|storm[\s-]?restor|crew[\s-]?dispatch)/i, 'outage-management'],
  [/\b(?:demand[\s-]?response|load[\s-]?manag|peak[\s-]?shav|demand[\s-]?side)/i, 'demand-response'],
  [/\b(?:scada|supervisory[\s-]?control|plc|dcs|industrial[\s-]?control)/i, 'scada-control'],
  [/\b(?:microgrid|distributed[\s-]?energy|battery[\s-]?storage|energy[\s-]?storage)/i, 'distributed-energy'],

  // ── Aviation / Aerospace ──
  [/\b(?:flight[\s-]?operat|flight[\s-]?plan|atc|air[\s-]?traffic|airspace)/i, 'flight-operations'],
  [/\b(?:mro|aircraft[\s-]?maint|airworth|component[\s-]?repair|overhaul)/i, 'aircraft-mro'],
  [/\b(?:crew[\s-]?schedul|pilot[\s-]?roster|crew[\s-]?manag|fatigue[\s-]?manag)/i, 'crew-scheduling'],
  [/\b(?:baggage|cargo[\s-]?air|freight[\s-]?air|load[\s-]?plan)/i, 'air-cargo'],
  [/\b(?:reservation[\s-]?air|booking[\s-]?air|pnr|revenue[\s-]?manag[\s-]?air)/i, 'airline-revenue'],

  // ── Maritime / Shipping ──
  [/\b(?:vessel[\s-]?track|ais|ship[\s-]?track|maritime[\s-]?monitor)/i, 'vessel-tracking'],
  [/\b(?:port[\s-]?operat|terminal[\s-]?operat|berth[\s-]?manag|dockside)/i, 'port-operations'],
  [/\b(?:container[\s-]?manag|container[\s-]?track|reefer|teu)/i, 'container-management'],
  [/\b(?:charter|voyage[\s-]?plan|freight[\s-]?rate|demurrage|laytime)/i, 'charter-management'],
  [/\b(?:maritime[\s-]?safety|imo|solas|ballast[\s-]?water|maritime[\s-]?compliance)/i, 'maritime-safety'],

  // ── Automotive ──
  [/\b(?:vehicle[\s-]?telematic|connected[\s-]?car|obd|can[\s-]?bus|v2x)/i, 'vehicle-telematics'],
  [/\b(?:dealer[\s-]?manag|dealership|dms|vehicle[\s-]?sales)/i, 'dealer-management'],
  [/\b(?:autonomous|self[\s-]?driv|adas|lidar[\s-]?process|perception[\s-]?system)/i, 'autonomous-systems'],
  [/\b(?:recall[\s-]?manag|safety[\s-]?recall|nhtsa|defect[\s-]?track)/i, 'recall-management'],
  [/\b(?:ev[\s-]?charg|charging[\s-]?station|charging[\s-]?network|battery[\s-]?manag)/i, 'ev-charging'],

  // ── Hospitality / Travel ──
  [/\b(?:reservation|booking[\s-]?engine|room[\s-]?allocat|availability[\s-]?manag)/i, 'reservation-management'],
  [/\b(?:revenue[\s-]?manag|yield[\s-]?manag|dynamic[\s-]?pric|rate[\s-]?optim)/i, 'revenue-optimization'],
  [/\b(?:guest[\s-]?experience|guest[\s-]?profil|concierge|hospitality[\s-]?crm)/i, 'guest-experience'],
  [/\b(?:loyalty[\s-]?program|reward[\s-]?point|tier[\s-]?manag|member[\s-]?benefit)/i, 'loyalty-program'],
  [/\b(?:housekeep|room[\s-]?status|turnover|minibar)/i, 'housekeeping-ops'],
  [/\b(?:workforce[\s-]?plan|staffing[\s-]?optim|labor[\s-]?schedul|shift[\s-]?plan|crew[\s-]?schedul)/i, 'workforce-planning'],
  [/\b(?:staffing[\s-]?level|staffing[\s-]?alert|staffing[\s-]?need|understaf|overstaff)/i, 'staffing-alerts'],
  [/\b(?:labor[\s-]?cost|labor[\s-]?analyt|wage[\s-]?cost|payroll[\s-]?analyt|overtime[\s-]?track)/i, 'labor-cost-analytics'],
  [/\b(?:occupancy[\s-]?analyt|occupancy[\s-]?rate|occupancy[\s-]?forecast|bed[\s-]?utiliz)/i, 'occupancy-analytics'],
  [/\b(?:demand[\s-]?forecast|demand[\s-]?predict|seasonal[\s-]?demand|booking[\s-]?trend|booking[\s-]?forecast)/i, 'demand-forecasting'],

  // ── Education / EdTech ──
  [/\b(?:student[\s-]?information|sis|enrollment|registrar|transcript)/i, 'student-information'],
  [/\b(?:lms|learning[\s-]?manag|course[\s-]?manag|e[\s-]?learn|online[\s-]?course)/i, 'learning-management'],
  [/\b(?:curriculum|syllabus|lesson[\s-]?plan|learning[\s-]?object)/i, 'curriculum-design'],
  [/\b(?:assessment|grading|exam|quiz|rubric|formative[\s-]?assess)/i, 'assessment-grading'],
  [/\b(?:accreditation|program[\s-]?review|institutional[\s-]?effect)/i, 'accreditation'],

  // ── Government / Public Sector ──
  [/\b(?:permit|licensing|building[\s-]?permit|zoning|land[\s-]?use)/i, 'permitting-licensing'],
  [/\b(?:case[\s-]?manag|casework|social[\s-]?service|benefit[\s-]?admin)/i, 'case-management'],
  [/\b(?:citizen[\s-]?service|constituent|public[\s-]?portal|311|e[\s-]?gov)/i, 'citizen-services'],
  [/\b(?:grant[\s-]?manag|grant[\s-]?award|federal[\s-]?fund|disbursement)/i, 'grant-management'],
  [/\b(?:public[\s-]?safety|emergency[\s-]?dispatch|cad|911|first[\s-]?respond)/i, 'public-safety'],
  [/\b(?:tax[\s-]?admin|revenue[\s-]?collect|assessment[\s-]?roll|property[\s-]?tax)/i, 'tax-administration'],

  // ── Legal / LegalTech ──
  [/\b(?:case[\s-]?track|legal[\s-]?case|litigation[\s-]?manag|docket|court[\s-]?filing)/i, 'litigation-management'],
  [/\b(?:e[\s-]?discovery|document[\s-]?review|legal[\s-]?hold|preserv[\s-]?notice)/i, 'e-discovery'],
  [/\b(?:contract[\s-]?analys|clm|contract[\s-]?lifecycle|clause[\s-]?extract)/i, 'contract-analytics'],
  [/\b(?:legal[\s-]?billing|timekeeper|matter[\s-]?manag|ledes|utbms)/i, 'legal-billing'],
  [/\b(?:ip[\s-]?manag|patent|trademark|copyright[\s-]?track)/i, 'ip-management'],

  // ── Media / Entertainment ──
  [/\b(?:content[\s-]?manag|cms|digital[\s-]?asset|dam|media[\s-]?library)/i, 'content-management'],
  [/\b(?:drm|digital[\s-]?rights|content[\s-]?protect|piracy[\s-]?detect)/i, 'digital-rights'],
  [/\b(?:ad[\s-]?tech|ad[\s-]?serv|programmatic|demand[\s-]?side|supply[\s-]?side[\s-]?platform)/i, 'ad-tech'],
  [/\b(?:audience[\s-]?analytic|viewer[\s-]?metric|engagement[\s-]?track|rating)/i, 'audience-analytics'],
  [/\b(?:royalt|residual|licensing[\s-]?fee|content[\s-]?licensing)/i, 'royalty-management'],
  [/\b(?:streaming|transcod|cdn[\s-]?manag|video[\s-]?delivery|adaptive[\s-]?bitrate)/i, 'streaming-delivery'],

  // ── Cybersecurity ──
  [/\b(?:threat[\s-]?intellig|ioc|indicator[\s-]?of[\s-]?compromise|threat[\s-]?feed)/i, 'threat-intelligence'],
  [/\b(?:siem|security[\s-]?event|log[\s-]?correlat|security[\s-]?analytic)/i, 'siem-analytics'],
  [/\b(?:vulnerabilit[\s-]?manag|cve|patch[\s-]?manag|vulnerability[\s-]?scan)/i, 'vulnerability-management'],
  [/\b(?:incident[\s-]?response|security[\s-]?incident|breach[\s-]?response|ir[\s-]?playbook)/i, 'incident-response'],
  [/\b(?:penetration[\s-]?test|pentest|red[\s-]?team|attack[\s-]?simulat)/i, 'penetration-testing'],
  [/\b(?:identity[\s-]?governance|iga|privileged[\s-]?access|pam|zero[\s-]?trust)/i, 'identity-governance'],

  // ── Logistics / 3PL / Warehouse ──
  [/\b(?:route[\s-]?optim|route[\s-]?plan|last[\s-]?mile|delivery[\s-]?optim)/i, 'route-optimization'],
  [/\b(?:wms|warehouse[\s-]?manag[\s-]?system|pick[\s-]?pack|put[\s-]?away|slotting)/i, 'warehouse-operations'],
  [/\b(?:cross[\s-]?dock|transload|consolidat[\s-]?shipment)/i, 'cross-docking'],
  [/\b(?:freight[\s-]?broker|carrier[\s-]?manag|tms|transport[\s-]?manag[\s-]?system)/i, 'freight-management'],
  [/\b(?:customs[\s-]?clear|import[\s-]?export|tariff|trade[\s-]?compliance|hs[\s-]?code)/i, 'customs-compliance'],
  [/\b(?:cold[\s-]?chain|temperature[\s-]?monitor|perishable|pharma[\s-]?logistics)/i, 'cold-chain-logistics'],

  // ── E-commerce / Marketplace ──
  [/\b(?:product[\s-]?catalog|pim|product[\s-]?information|sku[\s-]?manag)/i, 'product-catalog'],
  [/\b(?:shopping[\s-]?cart|checkout|cart[\s-]?abandon|conversion[\s-]?funnel)/i, 'checkout-experience'],
  [/\b(?:marketplace|seller[\s-]?manag|vendor[\s-]?onboard|commission[\s-]?track)/i, 'marketplace-ops'],
  [/\b(?:return[\s-]?manag|rma|refund|reverse[\s-]?logistic)/i, 'returns-management'],
  [/\b(?:recommendation[\s-]?engine|personali[sz]|collaborative[\s-]?filter)/i, 'recommendation-engine'],

  // ── HR / workforce (moved after specific industry patterns to avoid false matches)
  [/\b(?:hr|employee|workforce|personnel|talent)/i, 'workforce-management'],
  [/\b(?:payroll|compensation|benefit[\s-]?admin|deduction)/i, 'payroll-management'],
  [/\b(?:recruit|applicant[\s-]?track|ats|talent[\s-]?acquis|job[\s-]?post)/i, 'talent-acquisition'],
  [/\b(?:performance[\s-]?review|goal[\s-]?setting|okr|360[\s-]?feedback)/i, 'performance-management'],
  [/\b(?:learning[\s-]?develop|training[\s-]?manag|skill[\s-]?gap|upskill)/i, 'learning-development'],

  // Integration adapter (keep as-is if already suffixed)
  [/-integration$/, '__keep__'],
  // API gateway (keep as-is)
  [/^api-gateway$/, '__keep__'],
];

/**
 * Normalize a raw context/service name into a canonical domain term.
 *
 * Rules:
 * - Strip verb phrases and sentence fragments
 * - Map to domain vocabulary via regex matching
 * - Enforce kebab-case with max 3 words
 * - Reject names longer than 40 characters (truncate to last full word)
 * - Collapse synonymous contexts to the same canonical name
 */
export function normalizeContextName(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .trim();

  // Check against domain vocabulary
  for (const [pattern, canonical] of DOMAIN_VOCABULARY) {
    if (pattern.test(cleaned) || pattern.test(raw)) {
      if (canonical === '__keep__') break; // Use fallback normalization
      return canonical;
    }
  }

  // Fallback: strip stop words and keep max 3 meaningful words
  const CONTEXT_STOP_WORDS = new Set([
    'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
    'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were', 'be',
    'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will',
    'would', 'could', 'should', 'may', 'might', 'can', 'shall', 'must',
    'that', 'which', 'who', 'whom', 'this', 'these', 'those', 'it', 'its',
    'not', 'no', 'nor', 'so', 'if', 'when', 'where', 'how', 'what', 'why',
    'all', 'each', 'every', 'both', 'few', 'more', 'most', 'other', 'some',
    'such', 'than', 'too', 'very', 'just', 'about', 'above', 'after',
    'before', 'between', 'into', 'through', 'during', 'without', 'within',
    'inside', 'outside', 'also', 'only', 'then', 'once', 'here', 'there',
    'up', 'down', 'out', 'off', 'over', 'under', 'again', 'further',
    'likely', 'earlier', 'later', 'already', 'still', 'even', 'well',
  ]);

  const words = cleaned
    .split(/[\s-]+/)
    .filter(w => w.length > 1 && !CONTEXT_STOP_WORDS.has(w));

  if (words.length === 0) return raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'default-context';

  // Take max 3 words
  const slug = words.slice(0, 3).join('-');

  // Enforce 40-char limit, truncating at word boundary
  if (slug.length <= 40) return slug;
  const truncated = slug.slice(0, 40);
  const lastDash = truncated.lastIndexOf('-');
  return lastDash > 0 ? truncated.slice(0, lastDash) : truncated;
}

// ============================================================================
// Subdomain Classification
// ============================================================================

/**
 * Classify a context into core, supporting, or generic subdomain based on
 * its normalized name and description.
 *
 * - Core: Contexts that embody the primary competitive advantage / domain logic
 * - Supporting: Contexts that enable the core but are not differentiating
 * - Generic: Infrastructure, integration adapters, and cross-cutting concerns
 */
const SUBDOMAIN_RULES: Array<[RegExp, SubdomainType]> = [
  // Generic: integration adapters, gateways, infrastructure
  [/-integration$/i, 'generic'],
  [/^api-gateway$/i, 'generic'],
  [/\b(?:integration|adapter|connector|gateway|infrastructure)/i, 'generic'],
  [/\b(?:netsuite|oracle|sap|azure|aws|gcp|salesforce|servicenow|dynamics|workday)/i, 'generic'],
  [/\b(?:analytics|reporting|dashboard|monitoring|alert)/i, 'generic'],
  // Supporting: important but not the core differentiator
  [/\b(?:procurement|compliance|audit|quality|assurance)/i, 'supporting'],
  [/\b(?:facility|transfer|distribution|logistics)/i, 'supporting'],
  [/\b(?:security|access|auth|workforce|hr)/i, 'supporting'],
  [/\b(?:workflow|orchestrat|task[\s-]?rout)/i, 'supporting'],
  [/\b(?:waste|water|energy)[\s-]?management/i, 'supporting'],
  [/\b(?:regulatory|disclosure|filing)/i, 'supporting'],
  // Supporting: CPG trade promotion supporting contexts
  [/\b(?:budget|contract|point[\s-]?of[\s-]?sale)/i, 'supporting'],
  // Supporting: mining infrastructure contexts
  [/\b(?:fleet[\s-]?dispatch|geotechnical|blast[\s-]?optim|tailings)/i, 'supporting'],
  // Supporting: cross-industry infrastructure
  [/\b(?:identity[\s-]?governance|payroll|housekeep|cold[\s-]?chain|customs[\s-]?compliance)/i, 'supporting'],
  [/\b(?:crew[\s-]?schedul|meter[\s-]?data|billing[\s-]?mediat|service[\s-]?provision)/i, 'supporting'],
  [/\b(?:accreditation|curriculum|assessment[\s-]?grad|learning[\s-]?develop)/i, 'supporting'],
  [/\b(?:legal[\s-]?billing|ip[\s-]?manage|royalt|digital[\s-]?rights)/i, 'supporting'],
  // Core: mining predictive maintenance and production
  [/\b(?:predict(?:ive)?[\s-]?maint|equipment[\s-]?telemetry|efficiency[\s-]?degrad|production[\s-]?throughput|mining[\s-]?operat)/i, 'core'],
  // Core: primary domain logic that differentiates the system
  [/\b(?:promoti|trade[\s-]?promoti|campaign|cannibaliz)/i, 'core'],
  [/\b(?:emission|ghg|carbon|co2|scope[\s-]?[123])/i, 'core'],
  [/\b(?:anomal|discrepanc|outlier|deviation)/i, 'core'],
  [/\b(?:environment(?:al)?[\s-]?compliance|sustainab|esg)/i, 'core'],
  [/\b(?:inventory|stock|warehouse)/i, 'core'],
  [/\b(?:demand|forecast|predict)/i, 'core'],
  [/\b(?:supply[\s-]?risk|risk[\s-]?detect|imbalance|shortage)/i, 'core'],
  [/\b(?:supply[\s-]?chain|coordination)/i, 'core'],
  [/\b(?:order[\s-]?management|fulfillment)/i, 'core'],
  [/\b(?:production|manufactur)/i, 'core'],
  // Core: healthcare
  [/\b(?:patient|clinical[\s-]?trial|drug[\s-]?discover|pharmacovigilance|genomic)/i, 'core'],
  [/\b(?:claim[\s-]?adjud|diagnostics|telehealth)/i, 'core'],
  // Core: financial services
  [/\b(?:trade[\s-]?execut|kyc[\s-]?aml|fraud[\s-]?detect|risk[\s-]?manag|loan[\s-]?originat)/i, 'core'],
  [/\b(?:portfolio[\s-]?manag|payment[\s-]?process|core[\s-]?banking)/i, 'core'],
  // Core: insurance
  [/\b(?:underwriting|claims[\s-]?process|policy[\s-]?admin|actuarial)/i, 'core'],
  // Core: telecom
  [/\b(?:network[\s-]?operat|subscriber[\s-]?manag)/i, 'core'],
  // Core: oil & gas
  [/\b(?:reservoir|drill(?:ing)?[\s-]?operat|pipeline[\s-]?integrit|refin(?:ery|ing))/i, 'core'],
  // Core: agriculture
  [/\b(?:crop[\s-]?manag|precision[\s-]?agri|yield[\s-]?optim|livestock)/i, 'core'],
  // Core: automotive
  [/\b(?:vehicle[\s-]?telematic|autonomous|recall[\s-]?manag)/i, 'core'],
  // Core: aviation / maritime
  [/\b(?:flight[\s-]?operat|aircraft[\s-]?mro|vessel[\s-]?track|port[\s-]?operat)/i, 'core'],
  // Core: cybersecurity
  [/\b(?:threat[\s-]?intellig|siem|vulnerability[\s-]?manag|incident[\s-]?response)/i, 'core'],
  // Core: e-commerce
  [/\b(?:checkout|recommendation[\s-]?engine|marketplace[\s-]?ops)/i, 'core'],
  // Core: utilities
  [/\b(?:grid[\s-]?manag|outage[\s-]?manag|demand[\s-]?response|scada)/i, 'core'],
  // Core: construction
  [/\b(?:bim|construction[\s-]?project|safety[\s-]?compliance)/i, 'core'],
  // Core: hospitality
  [/\b(?:revenue[\s-]?optim|reservation[\s-]?manag|guest[\s-]?experience|workforce[\s-]?plan|demand[\s-]?forecast|staffing[\s-]?alert|labor[\s-]?cost|occupancy[\s-]?analyt)/i, 'core'],
  // Core: legal
  [/\b(?:litigation[\s-]?manag|e[\s-]?discovery|contract[\s-]?analytic)/i, 'core'],
  // Core: government
  [/\b(?:permit|case[\s-]?manag|citizen[\s-]?service|public[\s-]?safety)/i, 'core'],
  // Core: media
  [/\b(?:ad[\s-]?tech|streaming[\s-]?delivery|audience[\s-]?analytic)/i, 'core'],
];

function classifySubdomain(contextName: string, description: string): SubdomainType {
  const text = `${contextName} ${description}`.toLowerCase();
  for (const [pattern, subdomain] of SUBDOMAIN_RULES) {
    if (pattern.test(text)) return subdomain;
  }
  return 'supporting'; // Default: supporting
}

// ============================================================================
// Context Map Relationship Inference
// ============================================================================

/**
 * Domain-aware relationship rules. Each rule specifies a source pattern,
 * target pattern, and the relationship to create between them.
 *
 * These rules encode the structural domain knowledge: which contexts
 * naturally feed data to which others, and what integration pattern
 * governs the boundary.
 */
interface RelationshipRule {
  readonly sourcePattern: RegExp;
  readonly targetPattern: RegExp;
  readonly type: Phase2ContextRelation['type'];
  readonly integration_pattern: string;
  readonly data_flows: string[];
  readonly description: string;
  readonly anti_corruption_strategy?: string;
}

const RELATIONSHIP_RULES: RelationshipRule[] = [
  // inventory → demand-forecasting: inventory levels feed forecast models
  {
    sourcePattern: /\b(?:inventory|stock)\b/,
    targetPattern: /\b(?:demand|forecast)\b/,
    type: 'published-language',
    integration_pattern: 'Published Language — inventory levels published as standardized events',
    data_flows: ['InventoryLevelChanged', 'StockCountUpdated', 'ReorderPointReached'],
    description: 'Inventory levels feed demand forecast models via published events',
  },
  // demand-forecasting → supply-risk-detection: forecasts trigger risk alerts
  {
    sourcePattern: /\b(?:demand|forecast)\b/,
    targetPattern: /\b(?:supply[\s-]?risk|risk[\s-]?detect|imbalance|shortage)\b/,
    type: 'anticorruption-layer',
    integration_pattern: 'ACL — forecast output translated to risk-domain language',
    data_flows: ['DemandForecastPublished', 'ForecastAnomalyDetected'],
    description: 'Demand forecasts trigger supply risk evaluation through ACL',
    anti_corruption_strategy: 'Risk context translates forecast DTOs into risk assessment commands, rejecting malformed forecasts',
  },
  // supply-risk → procurement: risk alerts trigger procurement/transfer actions
  {
    sourcePattern: /\b(?:supply[\s-]?risk|risk[\s-]?detect|imbalance|shortage)\b/,
    targetPattern: /\b(?:procurement|sourcing|purchas)\b/,
    type: 'anticorruption-layer',
    integration_pattern: 'ACL — risk alerts translated to procurement commands',
    data_flows: ['SupplyRiskAlertRaised', 'ShortageDetected', 'SurplusIdentified'],
    description: 'Supply risk alerts trigger procurement automation through ACL',
    anti_corruption_strategy: 'Procurement context validates risk severity and maps alerts to PO creation or transfer requests',
  },
  // supply-risk → facility-transfer: risk alerts trigger facility transfers
  {
    sourcePattern: /\b(?:supply[\s-]?risk|risk[\s-]?detect|imbalance|shortage)\b/,
    targetPattern: /\b(?:facility|transfer)\b/,
    type: 'anticorruption-layer',
    integration_pattern: 'ACL — risk alerts translated to transfer orders',
    data_flows: ['SupplyRiskAlertRaised', 'InterFacilityTransferRequested'],
    description: 'Supply risk detection triggers facility transfer requests through ACL',
    anti_corruption_strategy: 'Transfer context validates facility capacity before accepting transfer commands',
  },
  // procurement → ERP integrations: all ERP writes go through ACL
  {
    sourcePattern: /\b(?:procurement|sourcing|purchas)\b/,
    targetPattern: /\b(?:netsuite|oracle|sap|dynamics|workday|erp)\b/,
    type: 'anticorruption-layer',
    integration_pattern: 'Anti-Corruption Layer — domain commands translated to ERP-native API calls',
    data_flows: ['PurchaseOrderCreated', 'VendorPaymentScheduled', 'ReceiptConfirmed'],
    description: 'All ERP writes go through anti-corruption layer',
    anti_corruption_strategy: 'Adapter translates domain aggregates to ERP-native entities, handles field mapping, retry, and idempotency',
  },
  // facility-transfer → ERP integrations
  {
    sourcePattern: /\b(?:facility|transfer)\b/,
    targetPattern: /\b(?:netsuite|oracle|sap|dynamics|workday|erp)\b/,
    type: 'anticorruption-layer',
    integration_pattern: 'Anti-Corruption Layer — transfer orders mapped to ERP inventory movements',
    data_flows: ['TransferOrderCreated', 'InventoryMovementRecorded'],
    description: 'Facility transfers written to ERP through anti-corruption layer',
    anti_corruption_strategy: 'Adapter maps inter-facility transfers to ERP-specific inventory movement transactions',
  },
  // ERP ↔ ERP: partnership when sharing backend
  {
    sourcePattern: /\b(?:netsuite)\b/,
    targetPattern: /\b(?:oracle)\b/,
    type: 'partnership',
    integration_pattern: 'Partnership — shared ERP backend with coordinated release schedules',
    data_flows: ['ERPSyncCompleted', 'MasterDataReplicated'],
    description: 'Shared ERP backend partnership with coordinated data synchronization',
  },
  // inventory → supply-chain-coordination
  {
    sourcePattern: /\b(?:inventory|stock)\b/,
    targetPattern: /\b(?:supply[\s-]?chain[\s-]?coord|coordination|orchestrat)\b/,
    type: 'customer-supplier',
    integration_pattern: 'Customer-Supplier — inventory provides stock data to supply chain coordinator',
    data_flows: ['StockLevelReport', 'WarehouseCapacityUpdate'],
    description: 'Inventory management supplies stock data to supply chain coordination',
  },
  // demand-forecasting → supply-chain-coordination
  {
    sourcePattern: /\b(?:demand|forecast)\b/,
    targetPattern: /\b(?:supply[\s-]?chain[\s-]?coord|coordination|orchestrat)\b/,
    type: 'customer-supplier',
    integration_pattern: 'Customer-Supplier — forecasts inform supply chain planning',
    data_flows: ['DemandForecastPublished', 'SeasonalTrendAnalysis'],
    description: 'Demand forecasts inform supply chain coordination planning',
  },
  // order-management → inventory
  {
    sourcePattern: /\b(?:order[\s-]?management|fulfillment)\b/,
    targetPattern: /\b(?:inventory|stock)\b/,
    type: 'customer-supplier',
    integration_pattern: 'Customer-Supplier — orders consume and reserve inventory',
    data_flows: ['OrderPlaced', 'InventoryReserved', 'OrderFulfilled'],
    description: 'Order management reserves and consumes inventory stock',
  },
  // order-management → procurement
  {
    sourcePattern: /\b(?:order[\s-]?management|fulfillment)\b/,
    targetPattern: /\b(?:procurement|sourcing)\b/,
    type: 'customer-supplier',
    integration_pattern: 'Customer-Supplier — unfulfillable orders trigger procurement',
    data_flows: ['StockoutDetected', 'ProcurementRequested'],
    description: 'Orders that cannot be fulfilled trigger procurement workflows',
  },
  // production → inventory
  {
    sourcePattern: /\b(?:production|manufactur)\b/,
    targetPattern: /\b(?:inventory|stock)\b/,
    type: 'customer-supplier',
    integration_pattern: 'Customer-Supplier — production output feeds inventory',
    data_flows: ['ProductionCompleted', 'GoodsReceivedIntoStock'],
    description: 'Completed production feeds inventory with finished goods',
  },
];

/**
 * Build the context map by inferring relationships between bounded contexts
 * using domain-semantic rules, explicit SPARC dependencies, and structural
 * patterns (integration adapters, shared kernels, observer contexts).
 */
function buildContextMap(
  contexts: Phase2DDDBoundedContext[],
  deduplicatedServices: Array<{ name: string; dependencies: string[] }>,
  normalizedNameMap: Map<string, string>,
): Phase2ContextRelation[] {
  const contextNames = new Set(contexts.map(c => c.name));
  const relations: Phase2ContextRelation[] = [];
  const seen = new Set<string>(); // "upstream|downstream|type" dedup key

  const addRelation = (rel: Phase2ContextRelation): void => {
    if (rel.upstream === rel.downstream) return;
    if (!contextNames.has(rel.upstream) || !contextNames.has(rel.downstream)) return;
    const key = `${rel.upstream}|${rel.downstream}|${rel.type}`;
    if (seen.has(key)) return;
    seen.add(key);
    relations.push(rel);
  };

  // 1. Apply domain-semantic relationship rules
  for (const rule of RELATIONSHIP_RULES) {
    for (const source of contexts) {
      if (!rule.sourcePattern.test(source.name)) continue;
      for (const target of contexts) {
        if (source.name === target.name) continue;
        if (!rule.targetPattern.test(target.name)) continue;
        addRelation({
          upstream: source.name,
          downstream: target.name,
          type: rule.type,
          description: rule.description,
          integration_pattern: rule.integration_pattern,
          data_flows: rule.data_flows,
          anti_corruption_strategy: rule.anti_corruption_strategy,
        });
      }
    }
  }

  // 2. Integration adapters: any *-integration context gets a shared-kernel
  //    relationship from infrastructure contexts that provide data connectivity
  const integrationContexts = contexts.filter(c =>
    c.name.endsWith('-integration') || /\b(?:azure|aws|gcp)\b/.test(c.name),
  );
  const coreAndSupporting = contexts.filter(c => {
    const sub = c.subdomain ?? classifySubdomain(c.name, c.description);
    return sub === 'core' || sub === 'supporting';
  });

  for (const infra of integrationContexts) {
    // If the infra context name contains a cloud provider, it's a shared kernel
    if (/\b(?:azure|aws|gcp)\b/.test(infra.name)) {
      for (const core of coreAndSupporting) {
        addRelation({
          upstream: infra.name,
          downstream: core.name,
          type: 'shared-kernel',
          description: `${infra.name} provides shared data connectivity to ${core.name}`,
          integration_pattern: 'Shared Kernel — common data connectivity and authentication layer',
          data_flows: ['ConnectionPoolShared', 'AuthTokenExchanged'],
        });
      }
    }
  }

  // 3. Compliance/auditing: conformist observer to all write-path contexts
  const auditContexts = contexts.filter(c => /\b(?:compliance|audit)\b/.test(c.name));
  const writePathContexts = contexts.filter(c => c.commands.length > 0 && !/\b(?:compliance|audit)\b/.test(c.name));

  for (const audit of auditContexts) {
    for (const writer of writePathContexts) {
      addRelation({
        upstream: writer.name,
        downstream: audit.name,
        type: 'conformist',
        description: `${audit.name} observes all write operations in ${writer.name} for audit trail`,
        integration_pattern: 'Conformist — audit context subscribes to domain events without transforming them',
        data_flows: writer.domainEvents
          .filter(e => e.name.endsWith('Succeeded'))
          .slice(0, 3)
          .map(e => e.name),
      });
    }
  }

  // 4. Explicit SPARC dependencies (normalized) — only add if not already covered
  for (const svc of deduplicatedServices) {
    const normalizedDown = normalizedNameMap.get(svc.name)!;
    for (const dep of svc.dependencies) {
      if (!normalizedNameMap.has(dep)) continue;
      const normalizedUp = normalizedNameMap.get(dep)!;
      addRelation({
        upstream: normalizedUp,
        downstream: normalizedDown,
        type: 'customer-supplier',
        description: `${normalizedDown} depends on ${normalizedUp}`,
        integration_pattern: 'Customer-Supplier — downstream conforms to upstream API contract',
        data_flows: [],
      });
    }
  }

  return relations;
}

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function pascalCase(text: string): string {
  return text
    .replace(/[-_\s]+(.)?/g, (_, c: string | undefined) => (c ? c.toUpperCase() : ''))
    .replace(/^(.)/, (_, c: string) => c.toUpperCase());
}

/**
 * Convert an API string like "POST /vendor/create-vendor" into a
 * domain command name like "CreateVendor".
 *
 * Strategy: strip HTTP method and path prefix, extract the action
 * slug (e.g. "create-vendor"), and PascalCase it.
 *
 * Safety: enforces max 3 meaningful words in the command name.
 * If the action slug is longer than 3 words, uses a standard CRUD
 * verb + context name (e.g., "UpdateProject") to prevent sentence
 * fragments from becoming 80-character PascalCase monstrosities.
 */
function toCommandName(apiMethod: string, contextName: string): string {
  // Strip leading HTTP method (POST, PUT, PATCH, DELETE)
  const withoutMethod = apiMethod.replace(/^\s*(POST|PUT|PATCH|DELETE)\s+/i, '');
  // Extract the last path segment (the action: "create-vendor", "update-payment")
  const segments = withoutMethod.split('/').filter(Boolean);
  const action = segments[segments.length - 1] ?? '';
  const cleaned = action.replace(/[^a-zA-Z0-9-]/g, '');
  if (!cleaned) return `Execute${contextName}`;

  // Split into words and enforce max 3 words
  const words = cleaned.split('-').filter(w => w.length > 0);
  if (words.length <= 3) {
    return pascalCase(cleaned);
  }

  // Too long — extract a CRUD verb if present, otherwise default to "Execute"
  const CRUD_VERBS = ['create', 'update', 'delete', 'remove', 'add', 'set', 'cancel', 'approve', 'reject', 'submit', 'process', 'manage'];
  const verb = words.find(w => CRUD_VERBS.includes(w.toLowerCase()));
  if (verb) {
    // Take the verb + at most 2 domain words after it
    const verbIdx = words.indexOf(verb);
    const tail = words.slice(verbIdx + 1, verbIdx + 3);
    return pascalCase([verb, ...tail].join('-'));
  }

  // No recognizable verb — use first 3 words
  return pascalCase(words.slice(0, 3).join('-'));
}

/**
 * Convert an API string like "GET /vendor" or "GET /vendor:id" into a
 * domain query name like "GetVendor" or "GetVendorById".
 *
 * Safety: enforces max 3 words to prevent sentence-fragment query names.
 */
function toQueryName(apiMethod: string, contextName: string): string {
  const withoutMethod = apiMethod.replace(/^\s*(GET)\s+/i, '');
  const segments = withoutMethod.split('/').filter(Boolean);
  const last = segments[segments.length - 1] ?? '';
  // Handle ":id" or "{id}" parameter patterns
  if (last.includes(':id') || last.includes('{id}')) {
    return `Get${contextName}ById`;
  }
  // If the last segment is just the context name, it's a list query
  const cleaned = last.replace(/[^a-zA-Z0-9-]/g, '');
  if (!cleaned || slugify(cleaned) === slugify(contextName)) {
    return `List${contextName}`;
  }
  // Enforce max 3 words
  const words = cleaned.split('-').filter(w => w.length > 0);
  if (words.length > 3) {
    return `Get${pascalCase(words.slice(0, 3).join('-'))}`;
  }
  return `Get${pascalCase(cleaned)}`;
}

// ============================================================================
// API Signature Parser (used by domain-codegen downstream)
// ============================================================================

export interface ParsedApiMethod {
  methodName: string;
  params: Array<{ name: string; type: string }>;
  returnType: string | null;
}

export function parseApiSignature(api: string): ParsedApiMethod | null {
  const match = api.match(/^(\w+)\(([^)]*)\)(?:\s*:\s*([\w\[\]<>,|\s]+))?/);
  if (!match) return null;

  const methodName = match[1]!;
  const paramStr = match[2] ?? '';
  const returnType = match[3]?.trim() ?? null;

  const params: Array<{ name: string; type: string }> = [];
  if (paramStr.trim().length > 0) {
    for (const segment of paramStr.split(',')) {
      const parts = segment.trim().split(/\s*:\s*/);
      const name = parts[0]?.trim() ?? '';
      const type = parts[1]?.trim() ?? '';
      if (name && type) {
        params.push({ name, type });
      }
    }
  }

  return { methodName, params, returnType };
}

// ============================================================================
// DDD Markdown Generator
// ============================================================================

function writeDDDMarkdown(model: Phase2DomainModel, sparc: Phase2SPARCOutput): string {
  const lines: string[] = [];

  lines.push('# Domain-Driven Design Model');
  lines.push('');
  lines.push(`Generated from SPARC architecture with ${sparc.architecture?.services?.length ?? 0} services.`);
  lines.push('');

  // Bounded Contexts
  lines.push('## Bounded Contexts');
  lines.push('');
  for (const ctx of model.contexts) {
    const subdomainLabel = ctx.subdomain ? ` [${ctx.subdomain} subdomain]` : '';
    lines.push(`### ${ctx.name}${subdomainLabel}`);
    lines.push(`> ${ctx.description}`);
    lines.push('');

    if (ctx.aggregates.length > 0) {
      lines.push('#### Aggregates');
      for (const agg of ctx.aggregates) {
        lines.push(`- **${agg.name}** (root: ${agg.root})`);
        if (agg.entities.length > 0) {
          for (const e of agg.entities) {
            lines.push(`  - Entity: ${e.name} — ${e.description ?? ''}`);
          }
        }
        if (agg.valueObjects.length > 0) {
          for (const vo of agg.valueObjects) {
            lines.push(`  - Value Object: ${vo.name}`);
          }
        }
        if (agg.invariants && agg.invariants.length > 0) {
          lines.push('  - Invariants:');
          for (const inv of agg.invariants) {
            lines.push(`    - ${inv}`);
          }
        }
      }
      lines.push('');
    }

    if (ctx.commands.length > 0) {
      lines.push('#### Commands');
      for (const cmd of ctx.commands) {
        lines.push(`- **${cmd.name}**: ${cmd.description ?? ''}`);
      }
      lines.push('');
    }

    if (ctx.queries.length > 0) {
      lines.push('#### Queries');
      for (const q of ctx.queries) {
        lines.push(`- **${q.name}**: returns ${q.returns ?? 'data'}`);
      }
      lines.push('');
    }

    if (ctx.domainEvents.length > 0) {
      lines.push('#### Domain Events');
      for (const evt of ctx.domainEvents) {
        lines.push(`- **${evt.name}**: ${evt.description ?? `triggered by ${evt.triggeredBy ?? 'command'}`}`);
      }
      lines.push('');
    }
  }

  // Context Map
  lines.push('## Context Map');
  lines.push('');
  if (model.contextMap.length > 0) {
    lines.push('| Upstream | Downstream | Relationship | Pattern | Description |');
    lines.push('|----------|------------|-------------|---------|-------------|');
    for (const rel of model.contextMap) {
      const pattern = rel.integration_pattern ?? '';
      lines.push(`| ${rel.upstream} | ${rel.downstream} | ${rel.type} | ${pattern} | ${rel.description ?? ''} |`);
    }
    lines.push('');

    // Data flows detail
    const flowRelations = model.contextMap.filter(r => r.data_flows && r.data_flows.length > 0);
    if (flowRelations.length > 0) {
      lines.push('### Data Flows');
      lines.push('');
      for (const rel of flowRelations) {
        lines.push(`**${rel.upstream} → ${rel.downstream}**: ${rel.data_flows!.join(', ')}`);
        if (rel.anti_corruption_strategy) {
          lines.push(`  - ACL Strategy: ${rel.anti_corruption_strategy}`);
        }
        lines.push('');
      }
    }
  } else {
    lines.push('No inter-context relationships (single bounded context).');
  }
  lines.push('');

  // Ubiquitous Language
  if (model.ubiquitousLanguageGlossary.length > 0) {
    lines.push('## Ubiquitous Language');
    lines.push('');
    lines.push('| Term | Definition | Context |');
    lines.push('|------|-----------|---------|');
    for (const term of model.ubiquitousLanguageGlossary) {
      lines.push(`| ${term.term} | ${term.definition} | ${term.context} |`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ============================================================================
// DDD Model Builder — derived from SPARC + dossier
// ============================================================================

export function buildPhase2DDD(
  sparc: Phase2SPARCOutput,
  adrs: Phase2ADRRecord[],
  dossier: ResearchDossier,
  scenarioQuery?: string,
): Phase2DomainModel {
  const services = sparc.architecture?.services ?? [];
  const glossary: UbiquitousLanguageTerm[] = [];

  // Normalize service names to canonical domain terms and deduplicate.
  // Multiple raw NLP fragments may collapse to the same canonical name;
  // when that happens, merge their capabilities and keep the first.
  const normalizedNameMap = new Map<string, string>(); // raw -> normalized
  for (const svc of services) {
    normalizedNameMap.set(svc.name, normalizeContextName(svc.name));
  }

  // Deduplicate: group services by their normalized name
  const seen = new Set<string>();
  const deduplicatedServices = services.filter((svc) => {
    const normalized = normalizedNameMap.get(svc.name)!;
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });

  // Build bounded contexts from deduplicated services
  const contexts: Phase2DDDBoundedContext[] = deduplicatedServices.map((svc) => {
    const contextName = normalizedNameMap.get(svc.name)!;
    const svcName = pascalCase(contextName);

    // ── Extract typed fields and value objects from API signatures ──
    const parsedApis = svc.api.map(a => parseApiSignature(a)).filter(Boolean) as ParsedApiMethod[];
    const entityFields: string[] = [];
    const valueObjects: Phase2ValueObject[] = [];
    const seenVOs = new Set<string>();

    for (const parsed of parsedApis) {
      // Collect unique parameter names as entity fields
      for (const p of parsed.params) {
        if (!entityFields.includes(p.name)) entityFields.push(p.name);
        // Complex types (non-primitive) become value objects
        const primitives = new Set(['string', 'number', 'boolean', 'Date', 'void', 'any', 'unknown']);
        const baseType = p.type.replace(/[\[\]<>,|?\s]/g, '');
        if (baseType && !primitives.has(baseType) && !seenVOs.has(baseType)) {
          seenVOs.add(baseType);
          valueObjects.push({
            name: baseType,
            description: `${baseType} value for ${svc.name}`,
            invariants: [`${baseType} must contain valid, well-formed data`],
          });
        }
      }
      // Return types as value objects too
      if (parsed.returnType) {
        const baseRet = parsed.returnType.replace(/[\[\]<>,|?\s]/g, '');
        const primitives = new Set(['string', 'number', 'boolean', 'Date', 'void', 'any', 'unknown']);
        if (baseRet && !primitives.has(baseRet) && !seenVOs.has(baseRet)) {
          seenVOs.add(baseRet);
          valueObjects.push({
            name: baseRet,
            description: `Response value from ${svc.name}`,
            invariants: [`${baseRet} must satisfy the service contract schema`],
          });
        }
      }
    }

    // ── Derive domain-specific invariants from responsibility + scenario ──
    const invariants: string[] = [];

    // Extract key nouns/concepts from responsibility for invariants
    const resp = svc.responsibility.toLowerCase();
    if (resp.includes('inventory') || resp.includes('stock'))
      invariants.push(`${svcName} stock quantity must be non-negative`);
    if (resp.includes('price') || resp.includes('pricing') || resp.includes('markdown') || resp.includes('cost'))
      invariants.push(`${svcName} price must be a positive decimal value`);
    if (resp.includes('order') || resp.includes('purchase'))
      invariants.push(`${svcName} order must have at least one line item`);
    if (resp.includes('forecast') || resp.includes('demand') || resp.includes('predict'))
      invariants.push(`${svcName} forecast horizon must be between 1 and 365 days`);
    if (resp.includes('auth') || resp.includes('identity') || resp.includes('credential'))
      invariants.push(`${svcName} credentials must be validated before access is granted`);
    if (resp.includes('schedul') || resp.includes('workflow') || resp.includes('orchestrat'))
      invariants.push(`${svcName} workflow transitions must follow the defined state machine`);
    if (resp.includes('notification') || resp.includes('alert') || resp.includes('event'))
      invariants.push(`${svcName} events must be idempotent and include a correlation ID`);
    if (resp.includes('integrat') || resp.includes('connect') || resp.includes('sync'))
      invariants.push(`${svcName} integration payloads must conform to the upstream contract schema`);
    if (resp.includes('report') || resp.includes('analytic') || resp.includes('dashboard') || resp.includes('metric'))
      invariants.push(`${svcName} report data must reference a valid time range`);
    if (resp.includes('user') || resp.includes('employee') || resp.includes('staff'))
      invariants.push(`${svcName} user records must have a unique identifier`);
    if (resp.includes('store') || resp.includes('location') || resp.includes('site'))
      invariants.push(`${svcName} location must have a valid geographic identifier`);
    if (resp.includes('config') || resp.includes('setting') || resp.includes('parameter'))
      invariants.push(`${svcName} configuration changes must be versioned`);

    // Always include a data-integrity invariant derived from the responsibility
    invariants.push(`${svcName} aggregate state must be internally consistent after every command`);

    // If we still have few invariants, add one from dependency contracts
    if (invariants.length < 3 && svc.dependencies.length > 0) {
      invariants.push(`${svcName} must validate responses from ${svc.dependencies.slice(0, 2).join(', ')} before updating state`);
    }

    // Aggregate from service — with typed entity and derived value objects
    const rootEntity: Phase2Entity = {
      name: svcName,
      description: svc.responsibility,
    };

    // Add sub-entities for non-trivial API surfaces (>3 methods = likely has sub-entities)
    const subEntities: Phase2Entity[] = [];
    if (svc.api.length > 3) {
      // Group API methods by prefix to discover implicit sub-entities
      const prefixCounts = new Map<string, number>();
      for (const api of svc.api) {
        const parsed = parseApiSignature(api);
        if (!parsed) continue;
        // Extract the domain noun from method name (e.g., "updateItem" -> "Item")
        const noun = parsed.methodName.replace(/^(get|set|update|create|delete|remove|add|find|list|fetch|submit|cancel|approve|reject)/i, '');
        if (noun && noun !== svcName && noun.length > 2) {
          prefixCounts.set(noun, (prefixCounts.get(noun) ?? 0) + 1);
        }
      }
      for (const [noun] of prefixCounts) {
        subEntities.push({
          name: noun,
          description: `${noun} managed by ${svc.name}`,
        });
      }
    }

    const aggregate: Phase2AggregateDefinition = {
      name: `${svcName}Aggregate`,
      root: svcName,
      entities: [rootEntity, ...subEntities],
      valueObjects,
      invariants,
    };

    // Commands from non-GET APIs — with parsed inputs and meaningful preconditions
    const commands: Phase2Command[] = svc.api
      .filter(a => !a.toLowerCase().startsWith('get'))
      .map(apiMethod => {
        const parsed = parseApiSignature(apiMethod);
        const inputFields = parsed?.params.map(p => `${p.name}: ${p.type}`) ?? ['requestPayload'];
        const cmdName = toCommandName(apiMethod, svcName);

        // Derive preconditions from command semantics
        const preconditions: string[] = [];
        const methodLower = apiMethod.toLowerCase();
        if (methodLower.includes('update') || methodLower.includes('modify'))
          preconditions.push(`${svcName} aggregate must exist before update`);
        else if (methodLower.includes('delete') || methodLower.includes('remove'))
          preconditions.push(`${svcName} aggregate must exist and not be in a protected state`);
        else if (methodLower.includes('create') || methodLower.includes('add'))
          preconditions.push(`No duplicate ${svcName} with the same identity may exist`);
        else if (methodLower.includes('submit') || methodLower.includes('approve'))
          preconditions.push(`${svcName} must be in a submittable/approvable state`);
        if (svc.dependencies.length > 0)
          preconditions.push(`Dependent service ${svc.dependencies[0]} must be reachable`);
        if (preconditions.length === 0)
          preconditions.push(`Caller must be authorized to invoke ${cmdName}`);

        return {
          name: cmdName,
          description: `${apiMethod} for ${svc.name}`,
          input: inputFields,
          preconditions,
          postconditions: [`${cmdName} completes and domain event is emitted`],
        };
      });

    // Queries from GET APIs — with parsed parameters and typed returns
    const queries: Phase2Query[] = svc.api
      .filter(a => a.toLowerCase().startsWith('get') || a.toLowerCase().includes('get'))
      .map(apiMethod => {
        const parsed = parseApiSignature(apiMethod);
        const params = parsed?.params.map(p => `${p.name}: ${p.type}`) ?? ['filters'];
        const returnType = parsed?.returnType ?? `${svcName}Response`;
        return {
          name: toQueryName(apiMethod, svcName),
          description: `${apiMethod} for ${svc.name}`,
          parameters: params,
          returns: returnType,
        };
      });

    // Domain events from commands
    const domainEvents: Phase2DomainEvent[] = commands.flatMap(cmd => [
      {
        name: `${cmd.name}Succeeded`,
        description: `Emitted when ${cmd.name} completes successfully`,
        payload: ['result'],
        triggeredBy: cmd.name,
      },
      {
        name: `${cmd.name}Failed`,
        description: `Emitted when ${cmd.name} fails`,
        payload: ['error'],
        triggeredBy: cmd.name,
      },
    ]);

    // Add to glossary
    glossary.push({
      term: svcName,
      definition: svc.responsibility,
      context: contextName,
      aliases: [svc.name, contextName].filter((v, i, a) => a.indexOf(v) === i),
    });

    // ADR refs — match against both the original raw name and normalized name
    const adrRefs = adrs
      .filter(a => {
        const lower = a.title.toLowerCase() + ' ' + a.context.toLowerCase();
        return lower.includes(svc.name.toLowerCase()) || lower.includes(contextName.toLowerCase());
      })
      .map(a => a.id);

    return {
      name: contextName,
      description: svc.responsibility,
      aggregates: [aggregate],
      domainEvents,
      commands,
      queries,
      ubiquitousLanguage: [],
      adrRefs,
      subdomain: classifySubdomain(contextName, svc.responsibility),
    };
  });

  // Build context map using domain-semantic relationship inference
  const contextMap = buildContextMap(contexts, deduplicatedServices, normalizedNameMap);

  // Add dossier-derived glossary terms
  const dossierTerms = new Set<string>();
  for (const item of dossier.items) {
    if (item.category === 'requirement' || item.category === 'recommendation') {
      // Extract key term from title
      const term = item.title.split(/[:\-–]/)[0]?.trim();
      if (term && term.length > 2 && term.length < 40 && !dossierTerms.has(term.toLowerCase())) {
        dossierTerms.add(term.toLowerCase());
        glossary.push({
          term,
          definition: item.content.slice(0, 120),
          context: item.source,
          aliases: [],
        });
      }
    }
  }

  return {
    contexts,
    contextMap,
    ubiquitousLanguageGlossary: glossary,
    scenarioQuery,
  };
}

// ============================================================================
// ADR-027 Change 2: LLM-Enriched DDD Model
//
// After mechanical derivation, Claude enriches each bounded context with
// typed aggregate fields, domain-specific invariants, and ubiquitous language.
// Falls back silently to the mechanical model on LLM failure.
// ============================================================================

/**
 * Enrich a mechanically-derived DDD model using Claude Code LLM.
 * Adds typed aggregate fields, domain-specific invariants, and ubiquitous language
 * terms that the deterministic derivation cannot produce.
 *
 * Modifies the model's arrays in-place (push to existing arrays).
 */
function enrichDDDWithLLM(
  model: Phase2DomainModel,
  dossier: ResearchDossier,
  query: string,
  phase2Dir = '',
): void {
  try {
    const runner = createClaudeCodeRunner();
    const contextSummaries = model.contexts.map(c => {
      const aggNames = c.aggregates.map(a => a.name).join(', ');
      const cmdNames = c.commands.map(cmd => cmd.name).join(', ');
      return `- ${c.name} (${c.subdomain ?? 'supporting'}): ${c.description.slice(0, 100)}\n  Aggregates: ${aggNames}\n  Commands: ${cmdNames}`;
    }).join('\n');

    const dossierContext = dossier.items
      .filter(i => ['requirement', 'recommendation', 'decision-rationale'].includes(i.category))
      .slice(0, 20)
      .map(i => `- ${i.title}: ${i.content.slice(0, 150)}`)
      .join('\n');

    // ADR-027: Include agentics fleet analysis from 110 agents
    const agentContext = phase2Dir ? loadAgenticsFleetContextForDDD(phase2Dir) : '';

    const prompt =
      `You are a DDD expert enriching a domain model for: ${query}\n` +
      `\nBOUNDED CONTEXTS:\n${contextSummaries}\n` +
      `\nRESEARCH FINDINGS:\n${dossierContext}\n` +
      (agentContext ? agentContext + '\n' : '') +
      `\nFor each bounded context, provide:\n` +
      `1. Aggregate root typed fields (use specific types: string, number, boolean, Date, and domain enums like "status: enum(open|in_progress|completed|deferred)")\n` +
      `2. 2-4 domain-specific invariants (business rules that must always hold true)\n` +
      `3. 3-6 ubiquitous language terms with definitions specific to this domain\n` +
      `\nReturn a JSON object with this exact structure:\n` +
      `{\n` +
      `  "contexts": {\n` +
      `    "<context-name>": {\n` +
      `      "fields": [{"name": "field_name", "type": "string|number|boolean|Date|enum(val1|val2)"}],\n` +
      `      "invariants": ["Business rule description"],\n` +
      `      "ubiquitousLanguage": [{"term": "Term", "definition": "Definition"}]\n` +
      `    }\n` +
      `  }\n` +
      `}\n` +
      `\nCRITICAL: Use domain-specific field names and types for ${query}. NOT generic "data: Record<string, unknown>" or "payload: any".`;

    const result = runner.invoke<Record<string, unknown>>(prompt, {
      runId: `ddd-enrich-${Date.now()}`,
      timeoutMs: 180_000,
    });

    const data = result.data as Record<string, unknown>;

    // Try to extract contexts from the response
    // The LLM may return JSON directly (parsed by envelope unwrapper) or as content string
    let enrichmentContexts: Record<string, LLMDDDEnrichment> | undefined;

    if (data.contexts && typeof data.contexts === 'object') {
      enrichmentContexts = data.contexts as Record<string, LLMDDDEnrichment>;
    } else if (typeof data.content === 'string') {
      try {
        const parsed = JSON.parse(data.content);
        if (parsed.contexts) enrichmentContexts = parsed.contexts;
      } catch { /* content was not JSON */ }
    }

    if (!enrichmentContexts) {
      process.stderr.write('[ddd-generator] LLM enrichment: could not extract contexts from response\n');
      return;
    }

    applyDDDEnrichment(model, enrichmentContexts);
    process.stderr.write(
      `[ddd-generator] LLM-enriched DDD model: ${Object.keys(enrichmentContexts).length} contexts in ${result.durationMs}ms\n`
    );
  } catch (err: unknown) {
    process.stderr.write(
      `[ddd-generator] LLM DDD enrichment failed (using mechanical model): ${err instanceof Error ? err.message : String(err)}\n`
    );
  }
}

interface LLMDDDEnrichment {
  fields?: Array<{ name: string; type: string }>;
  invariants?: string[];
  ubiquitousLanguage?: Array<{ term: string; definition: string }>;
}

/**
 * Apply LLM-generated enrichment data to the mechanical DDD model.
 * Pushes typed fields as entities, adds invariants, and adds glossary terms.
 */
function applyDDDEnrichment(
  model: Phase2DomainModel,
  enrichment: Record<string, LLMDDDEnrichment>,
): void {
  for (const ctx of model.contexts) {
    const data = enrichment[ctx.name];
    if (!data) continue;

    // Add typed fields to the first aggregate as entities with type info
    const agg = ctx.aggregates.length > 0 ? ctx.aggregates[0] : undefined;
    if (data.fields && agg) {
      for (const field of data.fields) {
        const alreadyExists = agg.entities.some(e => e.name === field.name);
        if (!alreadyExists) {
          agg.entities.push({
            name: field.name,
            description: `${field.name}: ${field.type}`,
          });
        }
      }
    }

    // Add domain-specific invariants
    if (data.invariants && agg) {
      for (const inv of data.invariants) {
        if (!agg.invariants.includes(inv)) {
          agg.invariants.push(inv);
        }
      }
    }

    // Add ubiquitous language terms to the model glossary
    if (data.ubiquitousLanguage) {
      for (const term of data.ubiquitousLanguage) {
        const exists = model.ubiquitousLanguageGlossary.some(
          t => t.term.toLowerCase() === term.term.toLowerCase()
        );
        if (!exists) {
          model.ubiquitousLanguageGlossary.push({
            term: term.term,
            definition: term.definition,
            context: ctx.name,
            aliases: [],
          });
        }
      }
    }
  }
}

// ============================================================================
// Public: Main Stage Function
// ============================================================================

export async function generateDDDModel(
  context: Phase2Context,
): Promise<Phase2StageOutput> {
  const rootSpan = createSpan('ddd-generation', 'generate-ddd-model', {
    phase2Dir: context.phase2Dir,
  });

  try {
    // Retrieve prerequisites
    const sparcOutput = context.stageOutputs.get('sparc-specification');
    if (!sparcOutput || sparcOutput.status !== 'completed') {
      throw new Error('ECLI-P2-010: Missing prerequisite: sparc-specification must complete before ddd-generation');
    }

    const adrOutput = context.stageOutputs.get('adr-generation');
    if (!adrOutput || adrOutput.status !== 'completed') {
      throw new Error('ECLI-P2-010: Missing prerequisite: adr-generation must complete before ddd-generation');
    }

    const dossierOutput = context.stageOutputs.get('research-dossier');
    if (!dossierOutput || dossierOutput.status !== 'completed') {
      throw new Error('ECLI-P2-010: Missing prerequisite: research-dossier must complete before ddd-generation');
    }

    const sparc = sparcOutput.data as Phase2SPARCOutput;
    const adrs = (adrOutput.data as { adrs: Phase2ADRRecord[] }).adrs ?? (adrOutput.data as Phase2ADRRecord[]);
    const dossier = dossierOutput.data as ResearchDossier;

    // Build domain model — include the full scenario query for Ruflo swarm extraction
    const query = context.phase1Artifacts?.scenario?.query
      ?? context.phase1Artifacts?.manifest?.query
      ?? '';
    const domainModel = buildPhase2DDD(sparc, Array.isArray(adrs) ? adrs : [], dossier, query);

    // ADR-027 Change 2: Enrich DDD model with LLM-generated typed fields,
    // domain-specific invariants, and ubiquitous language terms.
    // Falls back silently to mechanical model if Claude is unavailable.
    enrichDDDWithLLM(domainModel, dossier, query, context.phase2Dir);

    // Generate markdown
    const dddMarkdown = writeDDDMarkdown(domainModel, sparc);

    // Write artifacts
    const dddDir = path.join(context.phase2Dir, 'ddd');
    const contextsDir = path.join(dddDir, 'contexts');
    fs.mkdirSync(dddDir, { recursive: true, mode: DIR_MODE });
    fs.mkdirSync(contextsDir, { recursive: true, mode: DIR_MODE });

    const artifactPaths: string[] = [];

    // Primary: DDD markdown
    const mdPath = path.join(dddDir, 'DDD-Model.md');
    fs.writeFileSync(mdPath, dddMarkdown + '\n', { encoding: 'utf-8', mode: FILE_MODE });
    artifactPaths.push(mdPath);

    // JSON compat files
    const domainModelPath = path.join(dddDir, 'domain-model.json');
    fs.writeFileSync(domainModelPath, JSON.stringify(domainModel, null, JSON_INDENT), { encoding: 'utf-8', mode: FILE_MODE });
    artifactPaths.push(domainModelPath);

    const contextMapPath = path.join(dddDir, 'context-map.json');
    fs.writeFileSync(contextMapPath, JSON.stringify(domainModel.contextMap, null, JSON_INDENT), { encoding: 'utf-8', mode: FILE_MODE });
    artifactPaths.push(contextMapPath);

    const glossaryPath = path.join(dddDir, 'ubiquitous-language.json');
    fs.writeFileSync(glossaryPath, JSON.stringify(domainModel.ubiquitousLanguageGlossary, null, JSON_INDENT), { encoding: 'utf-8', mode: FILE_MODE });
    artifactPaths.push(glossaryPath);

    // Per-context files
    for (const ctx of domainModel.contexts) {
      const contextSlug = slugify(ctx.name);
      const contextPath = path.join(contextsDir, `${contextSlug}.json`);
      fs.writeFileSync(contextPath, JSON.stringify(ctx, null, JSON_INDENT), { encoding: 'utf-8', mode: FILE_MODE });
      artifactPaths.push(contextPath);
    }

    endSpan(rootSpan, 'ok', {
      contextsGenerated: domainModel.contexts.length,
      relationsGenerated: domainModel.contextMap.length,
      glossaryTerms: domainModel.ubiquitousLanguageGlossary.length,
    });
    emitSpan(rootSpan);

    const timing = rootSpan.durationMs ?? 0;

    const output: Phase2StageOutput = {
      stage: 'ddd-generation',
      status: 'completed',
      data: domainModel,
      artifacts: artifactPaths,
      timing,
      summary: `     DDD: ${domainModel.contexts.length} bounded contexts, ${domainModel.contextMap.length} relations, ${domainModel.ubiquitousLanguageGlossary.length} glossary terms`,
    };

    context.stageOutputs.set('ddd-generation', output);
    return output;
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);

    endSpan(rootSpan, 'error', { error: errorMessage });
    emitSpan(rootSpan);

    const timing = rootSpan.durationMs ?? 0;

    const output: Phase2StageOutput = {
      stage: 'ddd-generation',
      status: 'failed',
      data: { error: errorMessage },
      artifacts: [],
      timing,
      summary: `DDD generation failed: ${errorMessage}`,
    };

    context.stageOutputs.set('ddd-generation', output);
    return output;
  }
}
