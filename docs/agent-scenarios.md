# Multi-Agent Trading Scenarios & Playbooks

## 🎯 Real-World Trading Scenarios

### Scenario 1: Morning Market Open Strategy
```bash
# 1. Initialize swarm at market open
multi-agent start --preset FULL_ECOSYSTEM --duration 480  # 8 hour trading day

# 2. Scouts begin scanning for opportunities
[EXEC, TASK, scan_all_markets, frequency(5000), depth(10)]
"Scouts scan every 5 seconds, depth 10 pools"

# 3. Market makers establish initial positions
[EXEC, TRADE, initial_liquidity, amount(10000), spread(100)]
"MMs provide $10k liquidity, 1% spread"

# 4. Leaders analyze and set daily strategy
[PLAN, STRATEGY, market_analysis, bullish(700), volume_target(100000)]
"Leaders detect 70% bullish, target $100k volume"

# 5. Followers align with leader strategy
[ASK, AGENT, leader_strategy, copy_ratio(500), max_risk(300)]
"Followers copy at 50% size, 30% max risk"
```

### Scenario 2: Volatility Spike Response
```bash
# Triggered when volatility > 5%

# 1. Scout detects volatility
[SIGNAL, MARKET, volatility_alert, severity(850), token("SOL")]
"ALERT: SOL volatility at 8.5%"

# 2. Coordinator requests consensus
[COORD, SWARM, volatility_response, required(600), timeout(30)]
"Need 60% consensus within 30 seconds"

# 3. Agents vote on response
[ACK, SWARM, reduce_exposure, vote(1), agent_id]
"Agent votes: reduce exposure"

# 4. Execute consensus decision
[EXEC, SWARM, reduce_positions, percentage(500), priority(10)]
"Reduce all positions by 50%, max priority"

# 5. Market makers widen spreads
[SET, STRATEGY, spread(300), depth(3), frequency(60000)]
"Widen to 3% spread, depth 3, slow to 1min cycles"
```

### Scenario 3: Arbitrage Opportunity Chain
```bash
# Multi-hop arbitrage detected

# 1. Arbitrage agent finds opportunity
[SIGNAL, MARKET, arb_chain, profit(250), confidence(920)]
"Found 2.5% arb, 92% confidence"

# 2. Request capital from swarm
[ASK, WALLET, need_capital, amount(50000), duration(60)]
"Need $50k for 60 seconds"

# 3. Leader approves and coordinates
[COORD, WALLET, lend_capital, from_agents(3), amount(50000)]
"Lend from 3 agents, total $50k"

# 4. Execute arbitrage
[EXEC, TRADE, arb_execute, hop1, hop2, hop3]
"Execute: USDC→SOL→wSOL→USDC"

# 5. Distribute profits
[EXEC, WALLET, distribute_profit, total(1250), participants(4)]
"Share $1250 profit among 4 agents"
```

### Scenario 4: Cascading Stop-Loss Event
```bash
# One agent hits stop-loss, triggers cascade

# 1. Agent hits stop-loss
[SIGNAL, AGENT, stop_loss_hit, loss(500), position("SOL")]
"Agent-3 stop-loss: -$500 on SOL"

# 2. Evaluate contagion risk
[ASK, SWARM, position_correlation, token("SOL"), threshold(700)]
"Check if >70% agents have SOL exposure"

# 3. Coordinated exit if correlated
[COORD, SWARM, coordinated_exit, token("SOL"), urgency(8)]
"Exit SOL positions, urgency 8/10"

# 4. Staggered execution to minimize impact
[PLAN, TRADE, stagger_exits, waves(3), interval(20000)]
"Exit in 3 waves, 20 seconds apart"

# 5. Regroup and reassess
[EXEC, STRATEGY, defensive_mode, duration(3600), recovery_plan]
"Defensive for 1 hour, then recovery"
```

---

## 📊 Market Maker Playbook

### Setup Phase
```bash
# 1. Deploy MM squad
multi-agent start --preset MARKET_MAKING_SQUAD

# 2. Each MM takes a price range
MM-1: [EXEC, TRADE, range(9900,10000), volume(2000)]  # $99-100
MM-2: [EXEC, TRADE, range(10000,10100), volume(2000)] # $100-101
MM-3: [EXEC, TRADE, range(10100,10200), volume(2000)] # $101-102
MM-4: [EXEC, TRADE, range(9800,9900), volume(2000)]   # $98-99
MM-5: [EXEC, TRADE, range(10200,10300), volume(2000)] # $102-103

# 3. Coordinate spread management
[COORD, SWARM, maintain_spreads, target(50), rebalance(150)]
"Maintain 0.5% spreads, rebalance at 1.5% deviation"
```

### Active Market Making
```bash
# Continuous operation loop

# Every 30 seconds
[REPORT, MARKET, depth, bid_liquidity, ask_liquidity]
"Report order book depth"

# Adjust for imbalances
if (bid_liquidity < ask_liquidity * 0.8):
    [EXEC, TRADE, add_bids, amount(1000), levels(5)]
    "Add $1000 across 5 bid levels"

# Profit taking
if (unrealized_profit > 100):
    [EXEC, TRADE, take_profit, percentage(50), reinvest(50)]
    "Take 50% profit, reinvest 50%"
```

---

## 🦅 Arbitrage Hunter Playbook

### Continuous Scanning
```bash
# 1. Initialize hunters
multi-agent start --preset ARBITRAGE_HUNTERS

# 2. Assign pool pairs to each hunter
Hunter-1: [EXEC, TASK, monitor_pools, ["POOL_A", "POOL_B"]]
Hunter-2: [EXEC, TASK, monitor_pools, ["POOL_B", "POOL_C"]]
Hunter-3: [EXEC, TASK, monitor_pools, ["POOL_C", "POOL_A"]]

# 3. Set profit thresholds
[SET, STRATEGY, min_profit(100), max_slippage(50), speed(1)]
"Min $100 profit, max 0.5% slippage, fastest execution"
```

### Execution Protocol
```bash
# When opportunity found

# 1. Lock capital
[EXEC, WALLET, lock_funds, amount, duration(10)]
"Lock funds for 10 seconds max"

# 2. Execute atomic swap
[EXEC, TRADE, atomic_arb, path[], expected_profit]
"Execute arbitrage atomically"

# 3. Release capital
[EXEC, WALLET, release_funds, actual_profit]
"Release funds with profit"

# 4. Report to swarm
[REPORT, SWARM, arb_complete, profit, pools_used]
"Report successful arbitrage"
```

---

## 🎖️ Leader-Follower Playbook

### Leader Strategy Broadcast
```bash
# Leader daily strategy

# 1. Morning analysis
[PLAN, STRATEGY, daily_plan, bias("BULLISH"), targets[]]
"Leader sets bullish bias with targets"

# 2. Position sizing
[TELL, SWARM, position_sizes, btc(30), eth(30), sol(40)]
"Recommend: 30% BTC, 30% ETH, 40% SOL"

# 3. Risk parameters
[SET, STRATEGY, stop_loss(200), take_profit(500), leverage(150)]
"Stop at -2%, profit at +5%, 1.5x leverage"
```

### Follower Synchronization
```bash
# Followers adapt leader signals

# 1. Subscribe to leader
[ASK, AGENT, subscribe, leader_id, filter_confidence(700)]
"Follow leader, only >70% confidence signals"

# 2. Scale positions by risk
if (follower.risk < leader.risk):
    scale_factor = follower.risk / leader.risk
    [EXEC, TRADE, scaled_position, amount * scale_factor]

# 3. Delayed execution for safety
[PLAN, TRADE, delay_execution, seconds(5), confirm_signal]
"Wait 5 seconds, confirm signal still valid"
```

---

## 🚨 Emergency Procedures

### Market Crash Response
```bash
# Coordinated crash response

# 1. Detection
[SIGNAL, MARKET, crash_detected, drop(1500), timeframe(300)]
"15% drop in 5 minutes detected"

# 2. Emergency broadcast
[EXEC, SWARM, emergency_stop, all_agents, immediate]
"ALL AGENTS: EMERGENCY STOP"

# 3. Position unwinding
[EXEC, TRADE, close_all, market_orders, ignore_slippage]
"Close everything at market"

# 4. Capital preservation
[EXEC, WALLET, move_to_stable, percentage(100), asset("USDC")]
"Move 100% to USDC"

# 5. Wait for all-clear
[EXEC, SWARM, pause_trading, until_signal, minimum(3600)]
"Pause minimum 1 hour"
```

### Coordinated Recovery
```bash
# Post-emergency recovery

# 1. System check
[ASK, SWARM, health_check, all_systems, report_issues]
"Check all systems, report issues"

# 2. Gradual restart
[PLAN, SWARM, phased_restart, phases(3), interval(1800)]
"Restart in 3 phases, 30 min apart"

# 3. Reduced risk parameters
[SET, STRATEGY, recovery_mode, risk(30), positions(50)]
"30% normal risk, 50% position sizes"

# 4. Monitor stability
[EXEC, TASK, monitor_stability, duration(7200), alerts(true)]
"Monitor for 2 hours with alerts"
```

---

## 💰 Profit Optimization Strategies

### Daily Profit Taking
```bash
# Automated profit management

# Every hour check:
[ASK, SWARM, unrealized_pnl, all_positions]

if (total_profit > daily_target):
    # Take profits
    [EXEC, TRADE, take_profits, percentage(60), keep(40)]
    
    # Redistribute
    [EXEC, WALLET, redistribute, to_underperformers, amount(50%)]
    
    # Compound remainder
    [EXEC, STRATEGY, compound, reinvest(40%), boost_positions]
```

### Loss Recovery Protocol
```bash
# When agent is down >5%

# 1. Reduce risk
[SET, STRATEGY, reduce_risk, factor(50), duration(3600)]
"Halve risk for 1 hour"

# 2. Request assistance
[ASK, SWARM, need_assistance, deficit(500), strategy_help]
"Request help covering $500 deficit"

# 3. Copy successful agents
[ASK, AGENT, copy_strategy, from_profitable, duration(3600)]
"Copy profitable agent strategies"

# 4. Gradual recovery
[PLAN, STRATEGY, recovery_ladder, steps(5), target(breakeven)]
"5 steps back to breakeven"
```

---

## 📈 Performance Optimization

### A/B Testing Strategies
```bash
# Test different strategies simultaneously

# Split agents into groups
Group_A: [SET, STRATEGY, aggressive, risk(70), frequency(high)]
Group_B: [SET, STRATEGY, conservative, risk(30), frequency(low)]

# Run for test period
[EXEC, SWARM, ab_test, duration(3600), track_metrics]

# Compare results
[REPORT, SWARM, ab_results, profit_a, profit_b, risk_adjusted]

# Apply winning strategy
[EXEC, SWARM, apply_winner, all_agents, gradual_transition]
```

### Dynamic Parameter Adjustment
```bash
# Auto-tune based on performance

every 15 minutes:
    [ASK, AGENT, performance_metrics, last_15min]
    
    if (success_rate < 40%):
        [SET, STRATEGY, adjust_entry, threshold(+10%), confidence(+5%)]
        "Tighten entry criteria"
    
    if (success_rate > 70%):
        [SET, STRATEGY, increase_size, factor(120%), max(200%)]
        "Increase position sizes by 20%"
    
    if (volatility > normal * 2):
        [SET, STRATEGY, volatility_adjust, spreads(*1.5), frequency(/2)]
        "Widen spreads, reduce frequency"
```

---

## 🎮 Interactive Commands

### Manual Intervention
```bash
# Override agent decisions

# Force position close
wizbot nlc9:encode \
  --verb EXEC --object TRADE \
  --params '{"action": "FORCE_CLOSE", "agent": "MM-1", "reason": "MANUAL"}'

# Pause specific agent
wizbot nlc9:encode \
  --verb EXEC --object AGENT \
  --params '{"action": "PAUSE", "agent": "Scout-1", "duration": 1800}'

# Adjust swarm consensus threshold
wizbot nlc9:encode \
  --verb SET --object SWARM \
  --params '{"consensus_threshold": 0.75, "immediate": true}'
```

### Monitoring Commands
```bash
# Real-time monitoring

# Get swarm status
wizbot nlc9:encode --verb ASK --object SWARM --params '{"info": "STATUS"}'

# Get agent positions
wizbot nlc9:encode --verb ASK --object AGENT --params '{"info": "POSITIONS", "agent": "ALL"}'

# Get profit breakdown
wizbot nlc9:encode --verb REPORT --object SWARM --params '{"metrics": "PROFIT", "breakdown": true}'
```

---

## 🔧 Troubleshooting Commands

### Debug Agent Issues
```bash
# Agent not responding
[ASK, AGENT, health_check, agent_id, verbose(true)]
[EXEC, AGENT, restart, agent_id, clean_state]

# Agent making bad trades
[ASK, AGENT, trade_log, last(20), analyze]
[SET, STRATEGY, safe_mode, disable_auto, require_consensus]

# Agent out of sync
[EXEC, AGENT, resync, with_coordinator, full_state]
[REPORT, AGENT, sync_status, timestamp, positions]
```

### Network Issues
```bash
# NLC-9 connection problems
[EXEC, SWARM, reconnect_nlc9, all_agents, retry(3)]
[ASK, SWARM, connection_status, protocol("NLC9")]

# API connection issues
[EXEC, SWARM, fallback_mode, local_decisions, cache_signals]
[PLAN, SWARM, reconnect_schedule, attempts(5), backoff(exponential)]
```