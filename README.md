# Automated Trading Platform Showcase

This is a small, hiring-friendly snapshot of a larger personal project: an automated trading and monitoring platform built to test ideas, manage risk, and monitor live activity in real time.

## Resume Bullets

- Built an automated trading platform that combined strategy execution, live monitoring, performance tracking, and operational controls in one system.
- Added risk controls including capital sizing, stop-loss rules, position limits, and pause/close safeguards.
- Created web, terminal, and mobile-friendly monitoring tools with real-time updates, alerts, and control actions.
- Developed a testing and backtesting workflow to compare ideas, validate changes, and improve reliability before live use.

## What The System Included

- Multiple trading strategies and configurable execution logic
- Risk management rules for sizing, exits, and exposure control
- Real-time dashboards, alerts, and operator controls
- Trade journaling, performance tracking, and status reporting
- Backtesting, diagnostics, and validation tooling

## Quick Snapshot

- Purpose: automate research, execution, monitoring, and control in one place
- Build: Node.js backend, live dashboards, local data storage, real-time event streaming
- Operations: web dashboard, terminal dashboard, and alert-based monitoring
- Reliability: 60+ automated tests plus a large set of targeted validation scripts

## System Map

```mermaid
flowchart LR
  A[Market Data] --> B[Strategy Engine]
  B --> C[Risk Controls]
  C --> D[Trade Execution]
  D --> E[Trade Log and Metrics]
  E --> F[Dashboards and Alerts]
  F --> G[Operator Actions]
  G --> C
```

## How To Review This Project

If you are scanning quickly, the main takeaway is that this project was not just a trading script. It was a full operating system around automated decision-making: strategy logic, risk controls, execution, monitoring, reporting, and operational safety tools.
