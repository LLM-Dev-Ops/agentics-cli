# Decision Memo: Scope 3 Supplier Emissions Pipeline

## Decision

**GO** — Approve the 18-month, $2.4M implementation of the Scope 3 supplier carbon emissions extraction and reporting pipeline.

## Rationale

1. **Regulatory Mandate**: EU CSRD compliance is non-optional for organizations meeting the revenue and employee thresholds. Failure to report Scope 3 emissions by the mandated deadline exposes the organization to regulatory penalties and reputational risk.

2. **Competitive Positioning**: Early movers in Scope 3 reporting gain supplier engagement advantages. Organizations with mature emissions data can influence supplier decarbonization programs and attract ESG-conscious investors.

3. **Technical Readiness**: The existing SAP S/4HANA infrastructure and GCP cloud platform provide a solid foundation. The proposed architecture uses proven integration patterns (BAPI, BigQuery, Dataflow) rather than experimental technology.

4. **ROI Trajectory**: While initial implementation cost is $2.4M, the platform enables automated reporting that replaces an estimated $800K/year in manual data collection and consultant-driven emissions calculations. Breakeven at approximately 3 years.

## Alternatives Considered

1. **Manual Reporting with Consultants**: Lower upfront cost ($400K/year) but does not scale, creates recurring expense, and produces lower-quality data with higher latency. Rejected due to unsustainable cost curve and quality limitations.

2. **Third-Party SaaS Platform**: Faster time-to-value (6-9 months) but creates vendor dependency, limits customization for SAP integration, and raises data residency concerns for cross-border supplier data. Rejected due to long-term flexibility and data sovereignty requirements.

3. **Phased Manual-to-Automated Approach**: Start with manual reporting for Year 1 while building automation. Reduces initial risk but doubles the effort (manual + automated in parallel) and delays competitive advantage. Rejected as false economy.

## Conditions for Success

- Executive sponsor actively engaged through all 4 phases
- SAP BAPI access provisioned within first 30 days
- Sustainability consulting partner onboarded by month 2
- Data governance framework approved before Core Pipeline phase begins
- Quarterly milestone reviews with go/no-go gates between phases

## Risks Accepted

- Supplier data quality will require ongoing remediation beyond initial 18-month scope
- CSRD reporting format changes may require 1-2 additional sprints of rework
- 10x scaling target in Optimization phase is aspirational and may require additional budget
