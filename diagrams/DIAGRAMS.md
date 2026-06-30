# System Diagrams

This file is the canonical architecture and flow reference for the trading engine. It renders natively on GitHub and is the **single source of truth** for diagrams: the [Product Requirements Document](../docs/PRD.md) and [Engineering Requirements Document](../docs/ERD.md) embed focused excerpts, and the local `view-diagrams.html` viewer renders this file directly.

Terminology is shared across all documents. Solana-based venues are named explicitly (**Jupiter** and **Drift**, the latter through an isolated subprocess), strategy families and the five execution modes match the runtime, and the SQLite operational store is referenced by its real tables.

**Contents**

- **Part 1 — System and Architecture:** context, layers, runtime components
- **Part 2 — Orchestration and Lifecycle:** end-to-end flow, main loop, multi-market execution
- **Part 3 — Signals, Allocation, and Risk:** signal generation, allocation, risk hierarchy, validation
- **Part 4 — Execution and Venues:** venue-aware routing, staged execution modes
- **Part 5 — Subsystems, Data, and Operations:** copy-trading, persistence, security, operator controls

---

## Part 1 — System and Architecture

### 1. System Context

Who and what the runtime talks to: human actors, the Solana network, market-data sources, and the perpetuals venues. Research tooling reuses the same strategy and risk logic to limit live/backtest drift.

```mermaid
flowchart LR
  Operator["Operator"] --> Controls["Dashboards, API, Telegram-style controls"]
  Researcher["Strategy researcher"] --> Backtests["Backtest runners and tests"]
  Backtests -.->|"reuses strategy and risk logic"| Runtime

  subgraph External["Solana network and market data"]
    Solana["Solana network"]
    RPC["RPC providers"]
    Oracles["Oracle and price streams (Pyth, venue feeds)"]
    Venues["Perpetuals venues (Jupiter, Drift)"]
  end

  Solana --> Runtime["Trading engine runtime (bot.js)"]
  RPC --> Runtime
  Oracles --> Runtime
  Venues --> Runtime

  Runtime --> Strategies["Strategy engines"]
  Runtime --> Allocator["Market allocator"]
  Runtime --> Risk["Risk manager"]
  Runtime --> Execution["Venue-aware execution"]
  Execution --> Solana
  Execution --> Venues
  Runtime --> Store["SQLite operational store"]
  Store --> Controls
  Runtime --> Alerts["Alerts and structured logs"]
```

### 2. Layered Architecture

The engine keeps concerns in separate layers so network access, strategy logic, risk, execution, persistence, and operator controls do not bleed into each other. Security and secrets handling is cross-cutting, and research reuses production logic.

```mermaid
flowchart TB
  Operator["Operator layer<br/>dashboards, API/WebSocket, Telegram-style controls, terminal panel"]
  Strategy["Strategy layer<br/>signal generation, entry/exit logic, gate diagnostics"]
  Allocation["Allocation and risk layer<br/>ranking, sizing, exposure, leverage, stops"]
  Network["Network integration layer<br/>RPC, oracle and price feeds, venue state, WebSocket streams"]
  Execution["DeFi execution layer<br/>wallet-based venue access, open/close routing, retries, error classification"]
  Persistence["Persistence layer<br/>SQLite trades, guards, diagnostics, locks, market cache"]
  Research["Research layer<br/>backtests, sweeps, deterministic tests"]
  Security["Security and secrets layer<br/>encrypted wallets/secrets, permission checks, masking, secure loading"]

  Strategy --> Allocation --> Execution
  Network --> Strategy
  Network --> Execution
  Execution --> Persistence
  Persistence --> Operator
  Operator -.->|"pause, resume, close"| Allocation
  Research -.->|"reuses strategy and risk logic"| Strategy
  Security -.->|"protects"| Execution
  Security -.->|"protects"| Network
```

### 3. Runtime Component Architecture

The concrete modules in a running process: configuration and feeds initialize the loop, the strategy factory produces candidate signals, the allocator and risk manager select and size trades, validation gates them, and the venue-aware executor routes to Jupiter or Drift while persisting lifecycle state for the operator surfaces.

```mermaid
flowchart TB
  Config["Config and env loader (config.js, strategy-env-manager)"] --> Bot["bot.js runtime loop"]
  RPC["RPC manager"] --> Bot
  Pyth["Pyth and price streams"] --> Price["Price and market-data providers"]
  VenueMeta["Venue state and market metadata"] --> Price
  Bot --> Price
  Bot --> Factory["Strategy factory"]

  Factory --> Momentum["Momentum"]
  Factory --> Breakout["BTC breakout"]
  Factory --> RSI["RSI mean reversion"]
  Factory --> Scalping["Scalping"]
  Factory --> Ichimoku["Ichimoku cloud breakout"]
  Factory --> Predicta["Predicta"]
  Factory --> Copy["Copy-trading (base, event, meta)"]

  Momentum --> Signals["Candidate signals"]
  Breakout --> Signals
  RSI --> Signals
  Scalping --> Signals
  Ichimoku --> Signals
  Predicta --> Signals
  Copy --> Signals

  Signals --> Gates["Gate diagnostics"]
  Signals --> Allocator["Market allocator (ranking)"]
  Allocator --> Risk["Risk manager (sizing and exposure)"]
  Risk --> Validation["Pre-trade validation"]
  RPC --> Validation
  VenueMeta --> Validation
  Validation --> Router["Venue-aware executor"]
  Router --> Jupiter["Jupiter client"]
  Router --> Drift["Drift client and Drift subprocess"]
  Router --> Retry["Transaction retry and error classification"]
  Router --> Ledger["Trade store (SQLite)"]
  Gates --> Ledger
  Allocator --> Ledger
  Ledger --> Ops["API, dashboards, alerts"]
  Ops --> ControlsOut["Operator controls"]
  ControlsOut --> Bot
```

---

## Part 2 — Orchestration and Lifecycle

### 4. End-to-End Trading Lifecycle

From market data to execution, persistence, monitoring, and operator control. Closes route back to the venue that opened the position, and the dashboard/operator surfaces feed back into the loop.

```mermaid
flowchart LR
  A["Market data"] --> B["Per-strategy signals"]
  B --> C{"Open positions?"}
  C -->|Yes| D["Check strategy and risk exits"]
  C -->|No| E["Collect entry candidates"]
  D -->|Exit| F["Close on opening venue"]
  D -->|Hold| G["Update tracking"]
  E --> H["Market allocator ranks"]
  H --> I["Risk sizing and exposure"]
  I --> J["Leverage selection"]
  J --> K["Pre-trade validation"]
  K -->|Pass| L["Venue-aware execute"]
  K -->|Fail| G
  F --> M["Persist close and PnL"]
  L --> M
  M --> N["Dashboards and alerts"]
  N --> O["Operator controls"]
  O --> G
  G --> A
```

### 5. Main Trading Loop

The per-cycle sequence across the major subsystems, including validation, persistence, and status streaming. Rejected candidates still record gate and allocator diagnostics for review.

```mermaid
sequenceDiagram
  participant Loop as Trading loop (bot.js)
  participant Data as Price and market data
  participant Strat as Strategy factory
  participant Alloc as Allocator
  participant Risk as Risk manager
  participant Val as Validation
  participant Exec as Venue-aware executor
  participant Store as Trade store
  participant Ops as Dashboards and alerts

  loop Every cycle
    Loop->>Data: Refresh prices and indicators
    Data-->>Loop: Normalized market state
    Loop->>Strat: Evaluate enabled strategies
    Strat-->>Loop: Signals by market
    Loop->>Loop: Check open positions and exits
    Loop->>Alloc: Rank opportunities
    Alloc-->>Loop: Selected candidates
    loop For each selected trade
      Loop->>Risk: Size and check exposure
      Risk-->>Loop: Approved sizing or rejection
      alt Approved
        Loop->>Val: Slippage, funding, collateral, duplicate checks
        Val-->>Loop: Execution approval
        Loop->>Exec: Open or close request
        Exec->>Store: Persist lifecycle result
        Store-->>Ops: Stream status and alerts
      else Rejected
        Loop->>Store: Record gate and allocator diagnostics
      end
    end
  end
```

### 6. Multi-Market Parallel Execution

Signals from every enabled market are evaluated together; only the best candidates under portfolio limits are sized, validated, and routed.

```mermaid
flowchart TB
  A["Cycle starts"] --> B["Fetch prices for all markets"]
  B --> C["Update per-market strategy state"]
  C --> D["Check position exits"]
  D --> E["Collect signals across markets"]
  E --> F["Allocator ranks opportunities"]
  F --> G["Select best N under portfolio limits"]
  G --> H1["Market A candidate"]
  G --> H2["Market B candidate"]
  G --> H3["Market C candidate"]
  H1 --> I1["Size, validate, route"]
  H2 --> I2["Size, validate, route"]
  H3 --> I3["Size, validate, route"]
  I1 --> J["Venue-aware execute"]
  I2 --> J
  I3 --> J
  J --> K["Persist and update tracking"]
  K --> L["Wait until next cycle"]
```

---

## Part 3 — Signals, Allocation, and Risk

### 7. Strategy Signal Generation

Signal logic is multi-factor and position-aware. Each strategy waits for warm-up, then either manages an open position (exit, pyramid, or hold) or evaluates long/short entry gates across trend, momentum, volume, volatility, cooldown, and higher-timeframe context.

```mermaid
flowchart TB
  Start(["New bar"]) --> Update["Update EMA, RSI, ADX, ATR, Donchian, VWAP"]
  Update --> Ready{"Warm-up complete?"}
  Ready -->|No| Hold1["Return HOLD"]
  Ready -->|Yes| HasPos{"Has position?"}
  HasPos -->|Yes| CheckExit{"Should exit?"}
  CheckExit -->|Yes| Exit["Return CLOSE"]
  CheckExit -->|No| CheckPyramid{"Can add?"}
  CheckPyramid -->|Yes| Pyramid["Return PYRAMID"]
  CheckPyramid -->|No| Hold2["Return HOLD"]
  HasPos -->|No| Gates["Evaluate entry gates"]
  Gates --> LongGate{"Long gates pass?"}
  Gates --> ShortGate{"Short gates pass?"}
  LongGate --> LongFactors["Trend, momentum, volume, volatility, cooldown, HTF"]
  ShortGate --> ShortFactors["Trend, momentum, volume, volatility, cooldown, HTF"]
  LongFactors --> Edge{"Edge detected?"}
  ShortFactors --> Edge
  Edge -->|Long| OpenLong["Return OPEN LONG"]
  Edge -->|Short| OpenShort["Return OPEN SHORT"]
  Edge -->|None| Hold3["Return HOLD"]
```

### 8. Strategy- and Market-Aware Allocation

The allocator is dynamic, not round-robin. It builds features from the candidate signal, the strategy profile, and market/venue/portfolio/history context, scores with strategy-aware weights, applies constraint and correlation overlays, then emits a ranked recommendation (size, leverage, stop, rank tilt) plus diagnostics — while final approval stays in the risk manager.

```mermaid
flowchart TB
  subgraph StrategyLayer["Strategy layer"]
    Signals["Candidate signals<br/>direction, confidence, expected return"]
    StrategyProfile["Strategy profile<br/>weights, risk class, holding style"]
  end

  subgraph ContextLayer["Market and venue context"]
    MarketState["Market state<br/>volatility, trend, structure, liquidity"]
    VenueState["Venue state<br/>support, capital pool, constraints"]
    PortfolioState["Portfolio state<br/>open exposure, correlated baskets"]
    HistoryState["Historical context<br/>market tier, performance, cooldowns"]
  end

  Signals --> FeatureBuilder["Allocator feature builder"]
  StrategyProfile --> FeatureBuilder
  MarketState --> FeatureBuilder
  VenueState --> FeatureBuilder
  PortfolioState --> FeatureBuilder
  HistoryState --> FeatureBuilder

  FeatureBuilder --> ScoreEngine["Strategy-aware scoring engine"]
  ScoreEngine --> ConstraintLayer["Constraint and risk overlay<br/>market caps, venue caps, correlation limits"]
  ConstraintLayer --> Ranking["Opportunity ranking<br/>best market, side, strategy fit"]
  Ranking --> Recommendation["Allocator recommendation<br/>size, leverage, stop, rank tilt"]

  Recommendation --> RiskManager["Risk manager"]
  Recommendation --> Executor["Venue-aware executor"]
  Recommendation --> Diagnostics["Allocator diagnostics<br/>score components, reason codes"]
```

### 9. Strategy-Aware Risk Hierarchy

Risk is enforced in tiers. Portfolio-level checks run first, then strategy-aware position-level checks, then execution-quality validation. A failure at any tier rejects the trade.

```mermaid
flowchart TB
  Trade["Trade request"] --> L1["Portfolio risk checks"]
  L1 --> A["Exposure limit"]
  L1 --> B["Total leverage"]
  L1 --> C["Position count"]
  A --> D{"All pass?"}
  B --> D
  C --> D
  D -->|No| Reject1["Reject trade"]
  D -->|Yes| L2["Position risk checks (strategy-aware)"]
  L2 --> E["Position size bounds"]
  L2 --> F["Stop distance"]
  L2 --> G["Leverage bounds"]
  E --> H{"All pass?"}
  F --> H
  G --> H
  H -->|No| Reject2["Reject trade"]
  H -->|Yes| L3["Validation checks"]
  L3 --> I["Slippage"]
  L3 --> J["Market impact"]
  L3 --> K["Funding"]
  I --> M{"All pass?"}
  J --> M
  K --> M
  M -->|No| Reject3["Reject trade"]
  M -->|Yes| Execute["Allow execution"]
```

### 10. Pre-Trade Validation Pipeline

Before any live order, the request runs a fail-closed gauntlet: price freshness and network readiness, duplicate-order guard, collateral and margin, slippage, market impact, funding, and the execution-mode gate. Any unsafe condition skips the trade rather than guessing.

```mermaid
flowchart TB
  Req["Approved sizing"] --> Fresh{"Price fresh and network ready?"}
  Fresh -->|No| Reject["Fail closed and skip trade"]
  Fresh -->|Yes| Dup{"Duplicate-order guard clear?"}
  Dup -->|No| Reject
  Dup -->|Yes| Coll{"Collateral and margin OK?"}
  Coll -->|No| Reject
  Coll -->|Yes| Slip{"Slippage within bounds?"}
  Slip -->|No| Reject
  Slip -->|Yes| Impact{"Market impact acceptable?"}
  Impact -->|No| Reject
  Impact -->|Yes| Fund{"Funding conditions OK?"}
  Fund -->|No| Reject
  Fund -->|Yes| Gate{"Execution-mode gate"}
  Gate -->|Approved| Exec["Route to venue executor"]
  Gate -->|Rejected| Reject
```

---

## Part 4 — Execution and Venues

### 11. Venue-Aware Execution and Routing

Opens select a venue by market support; closes route back to the venue that opened the position using venue metadata. Drift runs through an isolated SDK subprocess. The execution-mode gate decides whether the order is simulated, approval-gated, shadowed, capped, or fully live, and transaction results are classified for retry or state reconciliation.

```mermaid
flowchart TB
  Req["Open or close request"] --> Resolve["Resolve market and venue support"]
  Resolve --> Close{"Closing an open position?"}
  Close -->|Yes| Orig["Route to the venue that opened it (venue metadata on position)"]
  Close -->|No| Pick{"Select venue by market support"}
  Pick -->|Jupiter| Jup["Jupiter client"]
  Pick -->|Drift| Drift["Drift client to Drift subprocess (isolated SDK)"]
  Orig --> Mode{"Execution-mode gate"}
  Jup --> Mode
  Drift --> Mode
  Mode -->|Paper| Paper["Simulate fill, no chain transaction"]
  Mode -->|Guarded| Guard["Require operator approval"]
  Mode -->|Shadow| Shadow["Record shadow trade, no live order"]
  Mode -->|Limited live| Limited["Apply guardrails, capped exposure"]
  Mode -->|Live| Live["Submit transaction"]
  Guard --> Submit["Build, sign, submit, confirm"]
  Limited --> Submit
  Live --> Submit
  Submit --> Result{"Transaction result"}
  Result -->|Retryable| Retry["Retry with backoff"]
  Retry --> Submit
  Result -->|Fatal or state sync| Classify["Classify error and reconcile state"]
  Result -->|Filled| Track["Track position and venue metadata"]
  Paper --> Track
  Shadow --> Track
  Classify --> Track
  Track --> Persist["Persist lifecycle, update stats and logs"]
```

### 12. Staged Execution Modes

Execution modes form an explicit rollout ladder. Each mode is gated and selected by configuration so strategy and execution changes can be validated before full live exposure, with no accidental escalation between modes.

```mermaid
flowchart LR
  Paper["Paper<br/>simulated fills, no chain tx"] --> Guarded["Guarded<br/>live tx require operator approval"]
  Guarded --> Shadow["Shadow<br/>compute live decisions, record only"]
  Shadow --> Limited["Limited-live<br/>real orders, capped size and guardrails"]
  Limited --> Live["Live<br/>full execution"]
```

---

## Part 5 — Subsystems, Data, and Operations

### 13. Copy-Trading Subsystem

Copy-trading is a self-contained signal source. Leader-wallet activity is streamed in, a cohort is selected, a consensus engine measures agreement, and event and meta models plus a market-confluence check produce signals that flow into the same shared allocator. Cohort state is snapshotted to SQLite.

```mermaid
flowchart TB
  Leaders["Leader wallets and on-chain activity"] --> WS["WebSocket and Helius webhooks"]
  WS --> Selector["Leader selector"]
  Selector --> Cohort["Cohort builder (top-K)"]
  Cohort --> Consensus["Consensus engine (agreement across leaders)"]
  Consensus --> Event["Event model (features, labeler, edge analysis)"]
  Consensus --> Meta["Meta model (cross-leader weighting)"]
  Event --> Confluence["Market confluence check"]
  Meta --> Confluence
  Confluence --> Signal["Copy-trading signals"]
  Signal --> Allocator["Market allocator (shared)"]
  Cohort --> Snap["copy_topk_snapshots (SQLite)"]
```

### 14. Persistence and Data Model

The runtime uses a lightweight SQLite operational store rather than a full relational domain model. The executor, strategy gates, allocator, copy-trading, and the loop write distinct tables; operator and review surfaces read them.

```mermaid
flowchart LR
  subgraph Writers["Writers"]
    Exec["Venue-aware executor"]
    Strat["Strategy gates"]
    Alloc["Allocator"]
    Copy["Copy-trading cohort"]
    Loop["Runtime loop"]
  end

  subgraph DB["SQLite operational store (db.js)"]
    T1["trades_open"]
    T2["trades_close"]
    T3["order_guard"]
    T4["gate_events"]
    T5["allocator_decisions"]
    T6["market_data"]
    T7["bot_instances"]
    T8["copy_topk_snapshots"]
  end

  subgraph Readers["Readers"]
    API["API and WebSocket"]
    Dash["Dashboards"]
    Analytics["Gate analytics and review"]
  end

  Exec --> T1
  Exec --> T2
  Exec --> T3
  Strat --> T4
  Alloc --> T5
  Loop --> T6
  Loop --> T7
  Copy --> T8

  T1 --> API
  T2 --> API
  T1 --> Dash
  T2 --> Dash
  T4 --> Analytics
  T5 --> Analytics
```

### 15. Security and Secrets Operations

Wallet and credential material is treated as production infrastructure. Files are encrypted at rest with authenticated encryption and password-derived keys, permission-checked, loaded through secure paths, masked in operator tooling, and never written to logs or passed through IPC. Public env templates carry structure only, never values.

```mermaid
flowchart TB
  subgraph AtRest["Encrypted at rest"]
    Wallet["Wallet file"]
    Secrets["Secrets bundle"]
  end

  Wallet --> Enc["AES-256-GCM with PBKDF2-SHA256 (per-file salt)"]
  Secrets --> Enc
  Enc --> Perms["File permission check (0600)"]
  Perms --> Loader["Secure loader<br/>encrypted file, JSON array, or base58 env"]
  Loader --> Runtime["Runtime (signing, RPC, API keys)"]
  Runtime --> Mask["Masked displays in operator tooling"]
  Runtime -.->|"never logged, never via IPC"| NoLeak["No private key bytes in logs or IPC"]
  Templates["Public env templates (structure only)"] -.->|"excludes values"| Runtime
```

### 16. Operator Control Surface

Operators supervise and intervene without shell access. Control surfaces share authentication, rate limiting, and payload validation, then drive runtime actions — pause/resume, close position(s), and read-only inspection — while live state streams back to the surfaces. The full Telegram command tree is documented in the [README](../README.md).

```mermaid
flowchart TB
  Operator["Operator"] --> Surfaces

  subgraph Surfaces["Control surfaces"]
    UI["ui-server: API and WebSocket"]
    Dash["Terminal dashboard"]
    TG["Telegram-style controls"]
    Panel["Terminal control panel"]
  end

  Surfaces --> Auth["Auth, rate limit, payload validation"]
  Auth --> Actions

  subgraph Actions["Actions"]
    Pause["Pause and resume"]
    CloseOne["Close position"]
    CloseAll["Close all"]
    Inspect["Inspect status, positions, risk"]
  end

  Pause --> Runtime["Runtime loop"]
  CloseOne --> Exec["Venue-aware executor"]
  CloseAll --> Exec
  Inspect --> Store["Trade store and diagnostics"]
  Runtime --> Surfaces
  Store --> Surfaces
```
