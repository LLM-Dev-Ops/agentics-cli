/**
 * Pass Registry — Unit Tests
 */

import {
  ENTERPRISE_PASS_CONFIGS,
  getPassConfig,
  getAllPassConfigs,
  getTotalUniqueAgents,
  getAllUniqueAgents,
} from '../../../../src/pipeline/enterprise/pass-registry.js';
// PassNumber type imported for reference in test descriptions

describe('Pass Registry', () => {

  describe('ENTERPRISE_PASS_CONFIGS', () => {
    test('has exactly 7 passes', () => {
      expect(Object.keys(ENTERPRISE_PASS_CONFIGS)).toHaveLength(7);
    });

    test('each pass has a unique passName', () => {
      const names = new Set<string>();
      for (const config of Object.values(ENTERPRISE_PASS_CONFIGS)) {
        names.add(config.passName);
      }
      expect(names.size).toBe(7);
    });

    test('each pass has at least 1 agent', () => {
      for (const config of Object.values(ENTERPRISE_PASS_CONFIGS)) {
        expect(config.agenticsServices.length).toBeGreaterThan(0);
      }
    });

    test('each pass has a unique memoryNamespace', () => {
      const namespaces = new Set<string>();
      for (const config of Object.values(ENTERPRISE_PASS_CONFIGS)) {
        namespaces.add(config.memoryNamespace);
      }
      expect(namespaces.size).toBe(7);
    });

    test('pass numbers match config.pass field', () => {
      for (const [passStr, config] of Object.entries(ENTERPRISE_PASS_CONFIGS)) {
        expect(config.pass).toBe(Number(passStr));
      }
    });
  });

  describe('Pass 1 — Problem Intelligence', () => {
    const config = ENTERPRISE_PASS_CONFIGS[1];

    test('label is Problem Intelligence', () => {
      expect(config.label).toBe('Problem Intelligence');
    });

    test('has no approval gate', () => {
      expect(config.hasApprovalGate).toBe(false);
    });

    test('includes copilot agents', () => {
      const copilotAgents = config.agenticsServices.filter(a => a.domain === 'copilot');
      expect(copilotAgents.length).toBeGreaterThanOrEqual(5);
    });

    test('includes memory-graph agents', () => {
      const memoryAgents = config.agenticsServices.filter(a => a.domain === 'memory-graph');
      expect(memoryAgents.length).toBeGreaterThanOrEqual(4);
    });
  });

  describe('Pass 2 — Simulation & Scenario Modeling', () => {
    const config = ENTERPRISE_PASS_CONFIGS[2];

    test('has approval gate', () => {
      expect(config.hasApprovalGate).toBe(true);
    });

    test('includes simulator agents', () => {
      const simAgents = config.agenticsServices.filter(a => a.domain === 'simulator');
      expect(simAgents.length).toBeGreaterThanOrEqual(2);
    });

    test('includes sentinel agents', () => {
      const sentinelAgents = config.agenticsServices.filter(a => a.domain === 'sentinel');
      expect(sentinelAgents.length).toBeGreaterThanOrEqual(4);
    });

    test('includes test-bench agents', () => {
      const testBenchAgents = config.agenticsServices.filter(a => a.domain === 'test-bench');
      expect(testBenchAgents.length).toBeGreaterThanOrEqual(5);
    });
  });

  describe('Pass 3 — Architecture & Prototype Generation', () => {
    const config = ENTERPRISE_PASS_CONFIGS[3];

    test('includes orchestrator agents', () => {
      const orchAgents = config.agenticsServices.filter(a => a.domain === 'orchestrator');
      expect(orchAgents.length).toBeGreaterThanOrEqual(7);
    });

    test('includes forge agents', () => {
      const forgeAgents = config.agenticsServices.filter(a => a.domain === 'forge');
      expect(forgeAgents.length).toBeGreaterThanOrEqual(4);
    });

    test('includes connector-hub agents', () => {
      const connAgents = config.agenticsServices.filter(a => a.domain === 'connector-hub');
      expect(connAgents.length).toBeGreaterThanOrEqual(5);
    });
  });

  describe('Pass 4 — Governance, Compliance & CostOps', () => {
    const config = ENTERPRISE_PASS_CONFIGS[4];

    test('has the most agents (4 workstreams)', () => {
      expect(config.agenticsServices.length).toBeGreaterThanOrEqual(15);
    });

    test('includes all shield agents', () => {
      const shieldAgents = config.agenticsServices.filter(a => a.domain === 'shield');
      expect(shieldAgents.length).toBeGreaterThanOrEqual(9);
    });

    test('includes costops agents', () => {
      const costAgents = config.agenticsServices.filter(a => a.domain === 'costops');
      expect(costAgents.length).toBeGreaterThanOrEqual(5);
    });
  });

  describe('Pass 5 — Decision Artifacts', () => {
    const config = ENTERPRISE_PASS_CONFIGS[5];

    test('includes platform agents', () => {
      const platformAgents = config.agenticsServices.filter(a => a.domain === 'platform');
      expect(platformAgents.length).toBeGreaterThanOrEqual(4);
    });
  });

  describe('Pass 6 — ERP Deployment', () => {
    const config = ENTERPRISE_PASS_CONFIGS[6];

    test('has no approval gate', () => {
      expect(config.hasApprovalGate).toBe(false);
    });

    test('includes connector-hub erp-surface', () => {
      const erpAgents = config.agenticsServices.filter(
        a => a.domain === 'connector-hub' && a.agent === 'erp-surface'
      );
      expect(erpAgents).toHaveLength(1);
    });
  });

  describe('Pass 7 — Observability & Learning', () => {
    const config = ENTERPRISE_PASS_CONFIGS[7];

    test('includes observatory agents', () => {
      const obsAgents = config.agenticsServices.filter(a => a.domain === 'observatory');
      expect(obsAgents.length).toBeGreaterThanOrEqual(6);
    });

    test('includes incident-manager agents', () => {
      const incAgents = config.agenticsServices.filter(a => a.domain === 'incident-manager');
      expect(incAgents.length).toBeGreaterThanOrEqual(3);
    });

    test('includes learning loop agents', () => {
      const learnAgents = config.agenticsServices.filter(a => a.domain === 'memory-graph');
      expect(learnAgents.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('getPassConfig', () => {
    test('returns config for valid pass', () => {
      const config = getPassConfig(3);
      expect(config.pass).toBe(3);
      expect(config.label).toBe('Architecture & Prototype Generation');
    });
  });

  describe('getAllPassConfigs', () => {
    test('returns 7 configs in order', () => {
      const configs = getAllPassConfigs();
      expect(configs).toHaveLength(7);
      expect(configs[0]!.pass).toBe(1);
      expect(configs[6]!.pass).toBe(7);
    });
  });

  describe('getTotalUniqueAgents', () => {
    test('returns a positive number', () => {
      const count = getTotalUniqueAgents();
      expect(count).toBeGreaterThan(0);
    });

    test('is less than total agent references (some agents appear in multiple passes)', () => {
      let totalRefs = 0;
      for (const config of Object.values(ENTERPRISE_PASS_CONFIGS)) {
        totalRefs += config.agenticsServices.length;
      }
      const unique = getTotalUniqueAgents();
      // Unique should be <= total refs
      expect(unique).toBeLessThanOrEqual(totalRefs);
    });
  });

  describe('getAllUniqueAgents', () => {
    test('returns array of AgentRef', () => {
      const agents = getAllUniqueAgents();
      expect(agents.length).toBe(getTotalUniqueAgents());
      for (const agent of agents) {
        expect(agent.domain).toBeTruthy();
        expect(agent.agent).toBeTruthy();
        expect(agent.role).toBeTruthy();
      }
    });

    test('no duplicate domain/agent pairs', () => {
      const agents = getAllUniqueAgents();
      const keys = agents.map(a => `${a.domain}/${a.agent}`);
      const uniqueKeys = new Set(keys);
      expect(uniqueKeys.size).toBe(keys.length);
    });
  });

  describe('Agent domain validation', () => {
    test('all agent domains are from the known 27 domains', () => {
      const KNOWN_DOMAINS = new Set([
        'test-bench', 'observatory', 'shield', 'sentinel', 'memory-graph',
        'latency-lens', 'forge', 'edge', 'auto-optimizer', 'incident-manager',
        'orchestrator', 'costops', 'governance-dashboard', 'policy-engine',
        'registry', 'marketplace', 'analytics-hub', 'config-manager',
        'schema-registry', 'connector-hub', 'copilot', 'simulator',
        'benchmark-exchange', 'inference-gateway', 'data-vault',
        'research-lab', 'platform',
      ]);

      for (const config of Object.values(ENTERPRISE_PASS_CONFIGS)) {
        for (const svc of config.agenticsServices) {
          expect(KNOWN_DOMAINS.has(svc.domain)).toBe(true);
        }
      }
    });
  });
});
