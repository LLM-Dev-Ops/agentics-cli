# SPARC Modes Overview

SPARC (Specification, Pseudocode, Architecture, Refinement, Completion) is a comprehensive development methodology with specialized modes for secure, modular, testable delivery.

## Core Modes (Canonical)

| Slug | Mode | Description |
|------|------|-------------|
| `sparc` | ⚡️ SPARC Orchestrator | Central coordinator — breaks objectives into delegated subtasks |
| `spec-pseudocode` | 📋 Specification Writer | Captures requirements and translates to modular pseudocode with TDD anchors |
| `architect` | 🏗️ Architect | Designs scalable, secure architectures with service boundaries |
| `code` | 🧠 Auto-Coder | Writes clean, modular code using configuration for environments |
| `tdd` | 🧪 Tester (TDD) | Implements London School TDD — tests first, refactor after green |
| `debug` | 🪲 Debugger | Troubleshoots runtime bugs via tracing and analysis |
| `security-review` | 🛡️ Security Reviewer | Audits for exposed secrets, poor boundaries, oversized files |
| `docs-writer` | 📚 Documentation Writer | Produces concise Markdown documentation |
| `integration` | 🔗 System Integrator | Merges outputs into cohesive, production-ready systems |
| `post-deployment-monitoring-mode` | 📈 Deployment Monitor | Observes post-launch performance and flags regressions |
| `refinement-optimization-mode` | 🧹 Optimizer | Refactors for clarity, modularity, and performance |
| `ask` | ❓ Ask | Guides users to the correct SPARC mode for their task |
| `devops` | 🚀 DevOps | Deployment automation and infrastructure management |
| `tutorial` | 📘 SPARC Tutorial | Onboarding and education for the SPARC methodology |

## Extended Modes (Claude Flow)

| Slug | Mode | Description |
|------|------|-------------|
| `orchestrator` | Multi-Agent Orchestrator | Multi-agent task orchestration |
| `swarm-coordinator` | Swarm Coordinator | Specialized swarm management |
| `workflow-manager` | Workflow Manager | Process automation |
| `batch-executor` | Batch Executor | Parallel task execution |
| `coder` | Coder | Autonomous code generation |
| `researcher` | Researcher | Deep research capabilities |
| `analyzer` | Analyzer | Code and data analysis |
| `optimizer` | Optimizer | Performance optimization |
| `designer` | Designer | UI/UX design |
| `innovator` | Innovator | Creative problem solving |
| `documenter` | Documenter | Documentation generation |
| `debugger` | Debugger | Systematic debugging |
| `tester` | Tester | Comprehensive testing |
| `memory-manager` | Memory Manager | Knowledge management |
| `mcp` | MCP Integration | MCP server and tool integration |
| `supabase-admin` | Supabase Admin | Database and auth management |

## Enforcement Standards

All modes enforce:
- ✅ Files < 500 lines
- ✅ No hard-coded environment variables or secrets
- ✅ Modular, testable outputs
- ✅ All subtasks delegated via `new_task`
- ✅ All tasks finalized with `attempt_completion`

## Usage

```bash
# Run a SPARC mode
npx claude-flow sparc run <mode> "task description"

# List all modes
npx claude-flow sparc modes

# Full development cycle
npx claude-flow sparc run sparc "orchestrate full implementation"
```
