# System Diagrams

## 1. End-to-End Trading Flow

```mermaid
flowchart LR
  A[Market Data] --> B[Strategy Signals]
  B --> C{Has Positions}
  C -->|Yes| D[Check Exits]
  C -->|No| E[Check Entries]
  D -->|Should Exit| F[Close Position]
  D -->|Hold| G[Update Tracking]
  E -->|Should Enter| H[Market Allocator]
  H --> I[Position Sizing]
  I --> J[Leverage Selection]
  J --> K[Validation]
  K -->|Pass| L[Execute]
  K -->|Fail| G
  F --> M[Update PnL]
  L --> M
  M --> G
  G --> A
```

## 2. Main Trading Loop

```mermaid
sequenceDiagram
  participant Bot as Trading Loop
  participant Data as Market Data
  participant Strat as Strategies
  participant Alloc as Allocator
  participant Risk as Risk Layer
  participant Exec as Execution

  loop Every cycle
    Bot->>Data: Fetch prices and indicators
    Data-->>Bot: Updated market state
    Bot->>Strat: Refresh strategy state
    Strat-->>Bot: Signals by market
    Bot->>Bot: Check active positions
    Bot->>Alloc: Score opportunities
    Alloc-->>Bot: Ranked candidates
    loop For each selected trade
      Bot->>Risk: Size and validate
      Risk-->>Bot: Size or reject
      alt Approved
        Bot->>Exec: Open position
        Exec-->>Bot: Position opened
      else Rejected
        Bot->>Bot: Skip trade
      end
    end
  end
```

## 3. Strategy Signal Generation

```mermaid
flowchart TB
  Start([New Bar]) --> Update[Update EMA RSI ADX ATR Donchian VWAP]
  Update --> Ready{Warm Up Complete}
  Ready -->|No| Hold1[Return HOLD]
  Ready -->|Yes| HasPos{Has Position}
  HasPos -->|Yes| CheckExit{Should Exit}
  CheckExit -->|Yes| Exit[Return CLOSE]
  CheckExit -->|No| CheckPyramid{Can Add}
  CheckPyramid -->|Yes| Pyramid[Return PYRAMID]
  CheckPyramid -->|No| Hold2[Return HOLD]
  HasPos -->|No| Gates[Evaluate Entry Gates]
  Gates --> LongGate{Long Gates Pass}
  Gates --> ShortGate{Short Gates Pass}
  LongGate --> LongFactors[Trend Momentum Volume Volatility Cooldown HTF]
  ShortGate --> ShortFactors[Trend Momentum Volume Volatility Cooldown HTF]
  LongFactors --> Edge{Edge Detected}
  ShortFactors --> Edge
  Edge -->|Long| OpenLong[Return OPEN LONG]
  Edge -->|Short| OpenShort[Return OPEN SHORT]
  Edge -->|None| Hold3[Return HOLD]
```

## 4. Market Ranking And Selection

```mermaid
flowchart TB
  A[All Market Signals] --> B[Score Each Opportunity]
  B --> C[Confidence Return Volatility Performance]
  C --> D[Apply Diversification Correlation Cooldown Bias]
  D --> E{Score Above Threshold}
  E -->|No| Drop[Discard]
  E -->|Yes| Keep[Keep Candidate]
  Keep --> F[Sort By Score]
  F --> G[Select Best N]
  G --> H{Portfolio Limit OK}
  H -->|No| Skip[Skip]
  H -->|Yes| I{Per Market Limit OK}
  I -->|No| Penalize[Apply Penalty Or Skip]
  I -->|Yes| Final[Final Selection]
  Penalize --> Final
```

## 5. Strategy-Aware Risk Hierarchy

```mermaid
flowchart TB
  Trade[Trade Request] --> L1[Portfolio Risk Checks]
  L1 --> A[Exposure Limit]
  L1 --> B[Total Leverage]
  L1 --> C[Position Count]
  A --> D{All Pass}
  B --> D
  C --> D
  D -->|No| Reject1[Reject Trade]
  D -->|Yes| L2[Position Risk Checks]
  L2 --> E[Position Size Bounds]
  L2 --> F[Stop Distance]
  L2 --> G[Leverage Bounds]
  E --> H{All Pass}
  F --> H
  G --> H
  H -->|No| Reject2[Reject Trade]
  H -->|Yes| L3[Validation Checks]
  L3 --> I[Slippage]
  L3 --> J[Market Impact]
  L3 --> K[Funding]
  I --> L{All Pass}
  J --> L
  K --> L
  L -->|No| Reject3[Reject Trade]
  L -->|Yes| Execute[Allow Execution]
```

## 6. Pre-Trade Validation Pipeline

```mermaid
sequenceDiagram
  participant Bot
  participant Slip as Slippage Check
  participant Impact as Impact Check
  participant Funding as Funding Check
  participant Gate as Execution Gate
  participant Exec as Venue Executor

  Bot->>Slip: Validate slippage
  alt Slippage too high
    Slip-->>Bot: Fail
  else Slippage ok
    Slip-->>Bot: Pass
    Bot->>Impact: Estimate market impact
    alt Impact too high
      Impact-->>Bot: Fail
    else Impact ok
      Impact-->>Bot: Pass
      Bot->>Funding: Check funding conditions
      Funding-->>Bot: Pass or warn
      Bot->>Gate: Request execution approval
      Gate-->>Bot: Approved or rejected
      alt Approved
        Bot->>Exec: Execute trade
        Exec-->>Bot: Position opened
      else Rejected
        Gate-->>Bot: Skip trade
      end
    end
  end
```

## 7. Venue-Aware Execution

```mermaid
flowchart LR
  A[Trade Request] --> B[Resolve Market]
  B --> C{Primary Or Alt Venue}
  C -->|Primary| D[Primary Venue Client]
  C -->|Alt| E[Alt Venue Client]
  E --> F{Live State Gate}
  F -->|Shadow Only| G[Record Shadow Trade]
  F -->|Limited Live| H[Apply Guardrails]
  F -->|Full Live| I[Submit Order]
  D --> J[Track Position Venue]
  H --> I
  I --> J
  J --> K[Update Stats And Logs]
```

## 8. Multi-Market Execution

```mermaid
flowchart TB
  A[Cycle Starts] --> B[Fetch Prices For All Markets]
  B --> C[Update Per Market Strategy State]
  C --> D[Check Position Exits]
  D --> E[Collect Signals]
  E --> F[Rank Opportunities]
  F --> G[Select Best Trades]
  G --> H1[Trade 1]
  G --> H2[Trade 2]
  G --> H3[Trade 3]
  H1 --> I1[Size And Validate]
  H2 --> I2[Size And Validate]
  H3 --> I3[Size And Validate]
  I1 --> J[Execute]
  I2 --> J
  I3 --> J
  J --> K[Update Tracking]
  K --> L[Wait Until Next Cycle]
```
