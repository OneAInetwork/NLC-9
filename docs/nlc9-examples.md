# NLC-9 Multi-Agent Trading Command Examples

## Overview
Each NLC-9 message is exactly 36 bytes (9 uint32 values):
```
[HEADER, VERB_ID, OBJ_ID, PARAM_A, PARAM_B, PARAM_C, TIMESTAMP, CORR_ID, CRC32]
```

## Quick Reference

### Verbs (Actions)
- `SIGNAL` (id: hash) - Market signal broadcast
- `EXEC` (id: 7) - Execute trade/action
- `COORD` (id: hash) - Coordination message
- `PLAN` (id: 6) - Strategy planning
- `REPORT` (id: 8) - Status report
- `ASK` (id: 4) - Request information
- `TELL` (id: 5) - Provide information
- `ACK` (id: 9) - Acknowledge
- `NACK` (id: 10) - Negative acknowledge

### Objects (Targets)
- `MARKET` (id: hash) - Market data/signals
- `TRADE` (id: hash) - Trade execution
- `SWARM` (id: hash) - Swarm coordination
- `WALLET` (id: hash) - Wallet operations
- `STRATEGY` (id: hash) - Strategy parameters
- `AGENT` (id: 1) - Agent entity
- `TASK` (id: 2) - Task/job
- `POOL` (id: hash) - Liquidity pool

---

## 1. Market Signal Examples

### 📊 Leader broadcasts BUY signal with high confidence
```bash
# Command
multi-agent nlc9:encode \
  --verb SIGNAL \
  --object MARKET \
  --params '{"strength": 0.85, "confidence": 0.92, "token_id": "SOL/USDC"}'

# NLC-9 Encoded (conceptual representation)
[header, SIGNAL, MARKET, 850, 920, token_hash("SOL/USDC"), timestamp, corr_id, crc32]

# Decoded
"Leader-1 SIGNALS MARKET: BUY SOL/USDC strength=85% confidence=92%"

# Agent Response
Followers with confidence > 0.7 threshold will copy trade
Market makers adjust spreads based on signal strength
Scouts begin monitoring correlated pairs
```

### 📉 Scout detects arbitrage opportunity
```bash
# Command
multi-agent nlc9:encode \
  --verb SIGNAL \
  --object MARKET \
  --params '{"strength": 1.0, "confidence": 0.95, "token_id": "ARB_SOL_POOLS"}'

# NLC-9 Encoded
[header, SIGNAL, MARKET, 1000, 950, token_hash("ARB_SOL_POOLS"), timestamp, corr_id, crc32]

# Decoded
"Scout-1 SIGNALS MARKET: ARBITRAGE opportunity strength=100% confidence=95%"

# Swarm Reaction
Arbitrage agents immediately attempt execution
Leader evaluates and may pause other activities
Followers prepare capital for potential rebalance
```

---

## 2. Trade Execution Examples

### 💰 Execute market making orders
```bash
# Command
multi-agent nlc9:encode \
  --verb EXEC \
  --object TRADE \
  --params '{"pool_id": "SOL_USDC_POOL_1", "amount": 1000.5, "slippage": 50}'

# NLC-9 Encoded
[header, EXEC, TRADE, pool_hash, 1000500000, 50, timestamp, corr_id, crc32]

# Decoded
"MM-1 EXEC TRADE: Place orders in pool SOL_USDC_POOL_1, volume=1000.5 USDC, slippage=0.5%"

# Execution Flow
1. Market maker places balanced buy/sell orders
2. Reports fills to swarm
3. Adjusts spreads based on volatility
```

### 🎯 Leader executes strategic position
```bash
# Command
multi-agent nlc9:encode \
  --verb EXEC \
  --object TRADE \
  --params '{"pool_id": "MAIN_POOL", "amount": 5000, "slippage": 30}'

# NLC-9 Encoded
[header, EXEC, TRADE, pool_hash, 5000000000, 30, timestamp, corr_id, crc32]

# Decoded
"Leader-1 EXEC TRADE: Strategic buy 5000 USDC in MAIN_POOL, slippage=0.3%"

# Cascade Effect
- Followers receive copy-trade signal
- Each follower scales position by risk factor
- Market makers adjust liquidity provision
```

---

## 3. Swarm Coordination Examples

### 🤝 Consensus voting for major action
```bash
# Command
multi-agent nlc9:encode \
  --verb COORD \
  --object SWARM \
  --params '{"action_id": "EMERGENCY_EXIT", "consensus": 0.75, "priority": 10}'

# NLC-9 Encoded
[header, COORD, SWARM, action_hash("EMERGENCY_EXIT"), 750, 10, timestamp, corr_id, crc32]

# Decoded
"Agent-X COORD SWARM: Vote EMERGENCY_EXIT, consensus=75%, priority=MAX"

# Consensus Process
1. Action requires 60% threshold (configured)
2. Current vote: 75% approval
3. Coordinator triggers emergency exit
4. All agents begin position unwinding
```

### 🔄 Rebalancing coordination
```bash
# Command
multi-agent nlc9:encode \
  --verb COORD \
  --object SWARM \
  --params '{"action_id": "REBALANCE_PORTFOLIO", "consensus": 0.6, "priority": 5}'

# NLC-9 Encoded
[header, COORD, SWARM, action_hash("REBALANCE_PORTFOLIO"), 600, 5, timestamp, corr_id, crc32]

# Decoded
"Coordinator COORD SWARM: Initiate REBALANCE_PORTFOLIO, consensus=60%, priority=MEDIUM"

# Rebalancing Steps
1. All agents report current positions
2. Coordinator calculates optimal allocation
3. Agents adjust positions in coordinated manner
4. Profit sharing executed if enabled
```

---

## 4. Wallet Operations Examples

### 💼 Create new agent wallets
```bash
# Command (via WizBot integration)
wizbot distribute --create 5 --from main --sol 1 --usdc 1000

# NLC-9 Encoded for each wallet creation
[header, EXEC, WALLET, wallet_count(5), sol_amount(1000000), usdc_amount(1000000000), timestamp, corr_id, crc32]

# Decoded
"System EXEC WALLET: Create 5 wallets, fund 0.2 SOL + 200 USDC each"

# Multi-Agent Integration
1. Each wallet assigned to new agent
2. Agents initialize with funded wallets
3. Begin autonomous trading operations
```

### 💸 Transfer between agents
```bash
# Command
multi-agent nlc9:encode \
  --verb EXEC \
  --object WALLET \
  --params '{"from_agent": "Leader-1", "to_agent": "Follower-1", "amount": 500}'

# NLC-9 Encoded
[header, EXEC, WALLET, agent_hash("Leader-1"), agent_hash("Follower-1"), 500000000, timestamp, corr_id, crc32]

# Decoded
"Leader-1 EXEC WALLET: Transfer 500 USDC to Follower-1"

# Use Case
Leader provides capital to underperforming follower
Profit sharing distribution
Emergency fund allocation
```

---

## 5. Strategy Management Examples

### 📈 Adjust risk parameters
```bash
# Command
multi-agent nlc9:encode \
  --verb SET \
  --object STRATEGY \
  --params '{"risk_level": 0.7, "leverage": 2.5, "max_drawdown": 0.15}'

# NLC-9 Encoded
[header, SET, STRATEGY, 700, 2500, 150, timestamp, corr_id, crc32]

# Decoded
"Agent-1 SET STRATEGY: risk=70%, leverage=2.5x, max_drawdown=15%"

# Strategy Update Flow
1. Agent validates new parameters
2. Gradually adjusts positions
3. Reports changes to coordinator
```

### 🎯 Switch strategy type
```bash
# Command
multi-agent nlc9:encode \
  --verb PLAN \
  --object STRATEGY \
  --params '{"strategy_type": "AGGRESSIVE", "transition_time": 300, "reason": "MARKET_VOLATILITY"}'

# NLC-9 Encoded
[header, PLAN, STRATEGY, strategy_hash("AGGRESSIVE"), 300, reason_hash, timestamp, corr_id, crc32]

# Decoded
"MM-1 PLAN STRATEGY: Switch to AGGRESSIVE over 5 minutes due to MARKET_VOLATILITY"
```

---

## 6. Complex Multi-Agent Scenarios

### 🌊 Cascading Market Event Response
```bash
# Scenario: Major price movement detected

# 1. Scout Detection
[header, SIGNAL, MARKET, 950, 980, token_hash("CRASH_ALERT"), timestamp, corr_id, crc32]
"Scout-1 SIGNALS MARKET: CRASH_ALERT strength=95% confidence=98%"

# 2. Leader Decision
[header, COORD, SWARM, action_hash("DEFENSIVE_MODE"), 850, 10, timestamp, corr_id, crc32]
"Leader-1 COORD SWARM: Activate DEFENSIVE_MODE consensus=85% priority=MAX"

# 3. Followers Acknowledge
[header, ACK, AGENT, agent_hash("Leader-1"), 1, 0, timestamp, corr_id, crc32]
"Follower-1 ACK Leader-1: Confirmed DEFENSIVE_MODE"

# 4. Market Makers Adjust
[header, SET, STRATEGY, 200, 50, 100, timestamp, corr_id, crc32]
"MM-1 SET STRATEGY: Widen spreads to 2%, reduce depth to 50%, slow cycles"

# 5. Arbitrage Pause
[header, EXEC, TRADE, 0, 0, pause_flag, timestamp, corr_id, crc32]
"Arb-1 EXEC TRADE: Pause all arbitrage until volatility < threshold"
```

### 🎰 Profit Distribution Event
```bash
# Scenario: Daily profit sharing

# 1. Coordinator Calculates
[header, REPORT, SWARM, total_profit(50000), agent_count(10), 0, timestamp, corr_id, crc32]
"Coordinator REPORT SWARM: Total profit=50k, agents=10"

# 2. Initiate Distribution
[header, EXEC, WALLET, action_hash("PROFIT_SHARE"), 5000000000, 10, timestamp, corr_id, crc32]
"Coordinator EXEC WALLET: Distribute 5000 USDC to 10 agents"

# 3. Each Agent Receives
[header, ACK, WALLET, 500000000, agent_id, 0, timestamp, corr_id, crc32]
"Agent-X ACK WALLET: Received 500 USDC profit share"
```

---

## 7. Command Line Usage Examples

### Start Basic Trading Team
```bash
# Start with preset
multi-agent start --preset BASIC_TRADING_TEAM

# What happens internally:
# 1. Leader-1 initializes
[header, EXEC, AGENT, agent_hash("Leader-1"), strategy_hash("BALANCED"), capital(1000000000), timestamp, corr_id, crc32]

# 2. Followers initialize and subscribe to leader
[header, ASK, AGENT, agent_hash("Leader-1"), subscribe_flag, 0, timestamp, corr_id, crc32]

# 3. Scout begins scanning
[header, EXEC, TASK, task_hash("SCAN_MARKETS"), interval(30000), 0, timestamp, corr_id, crc32]
```

### Generate Custom Configuration
```bash
# Create custom swarm
multi-agent generate-config \
  --leaders 2 \
  --followers 5 \
  --market-makers 3 \
  --arbitrage 2 \
  --scouts 2

# Each agent gets encoded initialization
[header, EXEC, AGENT, role_hash, strategy_hash, capital, timestamp, corr_id, crc32]
```

### Monitor Performance
```bash
# Request status from all agents
multi-agent nlc9:encode \
  --verb ASK \
  --object AGENT \
  --params '{"request": "PERFORMANCE", "format": "DETAILED", "period": 3600}'

# NLC-9 Encoded
[header, ASK, AGENT, request_hash("PERFORMANCE"), format_hash("DETAILED"), 3600, timestamp, corr_id, crc32]

# Decoded
"Monitor ASK AGENT: Report PERFORMANCE in DETAILED format for last 3600 seconds"

# Each agent responds
[header, TELL, AGENT, trades(45), profit(1250000), success_rate(780), timestamp, corr_id, crc32]
"Agent-X TELL: trades=45, profit=$1250, success=78%"
```

---

## 8. Emergency Scenarios

### 🚨 Emergency Stop
```bash
# Trigger emergency stop
multi-agent nlc9:encode \
  --verb EXEC \
  --object SWARM \
  --params '{"action": "EMERGENCY_STOP", "reason": "CRITICAL_LOSS", "severity": 10}'

# NLC-9 Encoded
[header, EXEC, SWARM, action_hash("EMERGENCY_STOP"), reason_hash("CRITICAL_LOSS"), 10, timestamp, corr_id, crc32]

# Decoded
"Coordinator EXEC SWARM: EMERGENCY_STOP due to CRITICAL_LOSS severity=MAX"

# Cascade
1. All agents receive emergency broadcast
2. Open positions closed immediately
3. Trading halted
4. Final performance reported
5. Wallets secured
```

---

## 9. Testing & Simulation

### Run 10-minute test
```bash
# Start swarm with time limit
multi-agent start --preset MARKET_MAKING_SQUAD --duration 10

# Simulation messages flow
[header, EXEC, SWARM, duration(600), simulation_flag, 0, timestamp, corr_id, crc32]
"System EXEC SWARM: Run simulation for 600 seconds"
```

### Replay historical scenario
```bash
# Load and replay
multi-agent nlc9:encode \
  --verb PLAN \
  --object TASK \
  --params '{"task": "REPLAY", "scenario": "2024_BULL_RUN", "speed": 10}'

# NLC-9 Encoded
[header, PLAN, TASK, task_hash("REPLAY"), scenario_hash("2024_BULL_RUN"), 10, timestamp, corr_id, crc32]

# Decoded
"System PLAN TASK: REPLAY scenario 2024_BULL_RUN at 10x speed"
```

---

## Quick Reference Card

### Most Common Commands

```bash
# 1. Start trading
[EXEC, TRADE, pool, amount, slippage] → "Execute trade"

# 2. Signal opportunity  
[SIGNAL, MARKET, strength, confidence, token] → "Broadcast signal"

# 3. Coordinate action
[COORD, SWARM, action, consensus, priority] → "Coordinate swarm"

# 4. Adjust strategy
[SET, STRATEGY, risk, leverage, drawdown] → "Update parameters"

# 5. Report status
[REPORT, AGENT, trades, profit, success] → "Performance update"

# 6. Emergency stop
[EXEC, SWARM, emergency, reason, severity] → "Halt operations"
```

### Response Patterns

```
Leader signals → Followers copy → Market makers adjust → Scouts monitor
High confidence → Immediate action → Consensus not needed
Low confidence → Request consensus → Wait for threshold → Execute
Emergency → Broadcast all → Stop immediately → Report status
```