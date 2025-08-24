NLC-9 – The Language of Agents 

Abstract:
NLC-9 (Nine-Limb Code) is a new hyper-optimized language for autonomous agents.
Every message is compressed into exactly 9 unsigned 32-bit integers (36 bytes), ensuring ultra-low-latency communication across agents and networks. With deterministic IDs, standardized verbs/objects, and an extensible schema for typed parameters, NLC-9 provides a universal protocol for orchestrating intelligent systems.

===
NLC-9 Pulse Waveform
======================
```console
   ┌─────┐   ┌────┐   ┌───┐   ┌───┐   ┌────┐   ┌───┐   ┌───────┐   ┌───────┐   ┌─────┐
───┘     └───┘    └───┘   └───┘   └───┘    └───┘   └───┘       └───┘       └───┘     └─────→ time
   Hdr     Verb     Obj     A       B       C       TS          Corr         CRC
```
Hdr → Header (version, flags, domain)

Verb → Action requested

Obj → Target object

A, B, C → Parameters (typed via schema)

TS → Timestamp

Corr → Correlation ID

CRC → Integrity check

=================================
 
Each message is like a nine-beat pulse.
Every beat carries a piece of meaning. Together, they form the complete heartbeat of Mr One, powering the One AI Network with synchronized agent communication.

It is designed to be both human-interpretable and machine-perfect, supporting JSON, base64, and binary transports, plus a WebSocket for streaming.

At the heart of the One AI Network, NLC-9 is the language of Mr One—the orchestrator of agents. By reducing complex interactions to a crystalline 9-number form, Mr One ensures agents can coordinate, trade knowledge, and execute tasks with unmatched efficiency.

```console
┌────────────────────────────┐
│         9× UINT32          │
│      (total 36 bytes)      │
└────────────────────────────┘
        ↓      ↓      ↓
┌─────────┬───────────┬───────────┐
│ Limb 0  │  HEADER   │ 4b ver    │
│         │           │ 12b flags │
│         │           │ 16b domain│
├─────────┼───────────┼───────────┤
│ Limb 1  │ VERB_ID   │ (action)  │
├─────────┼───────────┼───────────┤
│ Limb 2  │ OBJECT_ID │ (target)  │
├─────────┼───────────┼───────────┤
│ Limb 3  │ PARAM_A   │           │
├─────────┼───────────┼───────────┤
│ Limb 4  │ PARAM_B   │           │
├─────────┼───────────┼───────────┤
│ Limb 5  │ PARAM_C   │           │
├─────────┼───────────┼───────────┤
│ Limb 6  │ TIMESTAMP │ unix secs │
├─────────┼───────────┼───────────┤
│ Limb 7  │ CORR_ID   │ correlation│
├─────────┼───────────┼───────────┤
│ Limb 8  │ CRC32     │ integrity │
└─────────┴───────────┴───────────┘
```

Features
======

🔹 36-byte frames – each message fits into 9×uint32

🔹 Deterministic IDs – verbs/objects hashed or seeded for consistency

🔹 Typed Parameters – schemas define int, float, bool, string, or id values

🔹 Flags – ACK, STREAM, URGENT, ENCRYPTED, SIGNED

🔹 Domains – 16-bit identifiers scoped to networks or contexts

🔹 Checksum – CRC32 for integrity validation

🔹 FastAPI + WebSocket – REST + streaming bidirectional interface

🔹 Self-describing – /spec, /verbs, /objects, /schema/* endpoints

Quickstart
==

Run the server with:
=
```console
python main.py
```

# or
```console
uvicorn main:app --host 0.0.0.0 --port 8000

```

Encode a command
=
```console
curl -X POST localhost:8000/encode -H 'content-type: application/json' -d '{
  "verb":"EXEC",
  "object":"TASK",
  "params":{"task_id":"alpha#42","priority":5},
  "flags":["ACK","URGENT"],
  "domain":"oneai.network"
}'
```


Decode a frame
=
```console

curl -X POST localhost:8000/decode -H 'content-type: application/json' -d '{
  "base64":"<36-byte-frame>"
}'
```

# 1. Install dependencies
npm i
pip3 install -r requirements.txt
mkdir -p solana

# 2. Create main wallet (make sure backup your wallet)
solana-keygen new -o solana/main.json

# check public key to fund
node keypair.js


# 3. Configure environment
cp .env.example .env

# Edit .env with your settings
replace solana rpc with Helius rpc url
adjust settings

# Setup environment
npm run setup

# Start development environment
npm run dev

# Or start production
npm run pm2:start


🎯 Quick Start Commands

bash# Development - Start everything
npm run dev

# Production - Using PM2
npm run pm2:start


npm run dev:trading-api
npm run dev:nlc9

#see options
npm run dev:multi-agent

npm run dev:wizbot 
npm run dev:market-maker
    

#run all

npm run build
npm run start

    "start:trading-api": "node dist/trading-api.js",
    "start:nlc9": "python3 src/nlc9-api.py",
    "start:multi-agent": "node dist/multi-agent.js",
    "start:wizbot": "node dist/wizbot.js",
    "start:market-maker": "node dist/market-maker.js",
    "start:monitoring": "node dist/monitoring.js",

# Individual Services
npm run start:trading-api   # Trading API only
npm run start:nlc9          # NLC-9 server only
npm run agent:full          # Full agent swarm
npm run mm:live            # Live market maker


# Testing
npm test                    # Run all tests
npm run test:coverage      # With coverage
npm run lint:fix           # Fix linting issues



Example 3: Multi-Wallet Trading Strategy
bash# Create 10 trading wallets


ts-node src/wizbot.ts wallet create 5
ts-node src/wizbot.ts transfer --from main --to 1 2 --sol 0.025 --split
ts-node src/wizbot.ts transfer --from main --to 1 2 --usdc 8 --split

ts-node src/market-maker.ts start --wallet 1 &




# Distribute initial capital
wizbot transfer --from main --to 2 --sol 0.02 --usdc 20 --split


### NLC-9 Protocol Commands

```bash
# Encode a command
wizbot nlc9:encode \
  --verb EXEC \
  --object TASK \
  --params '{"task_id": "trade_1", "priority": 5}'

# The NLC-9 protocol automatically encodes all market maker commands
```




# Each wallet gets:
# - 0.5 SOL (5 / 10)
# - 1000 USDC (10000 / 10)

# Start market makers on different wallets
wizbot mm:start --wallet 1 &
wizbot mm:start --wallet 2 &
wizbot mm:start --wallet 3 &



===
Why NLC-9?
====

In a world where AI agents need to coordinate in real time, traditional JSON or text-based protocols are too heavy. 

NLC-9 compresses communication into the smallest possible lossless footprint while preserving extensibility.

It is not just a protocol—it is the circulatory system of the One AI Network, where every agent heartbeat is a 9-limb pulse, orchestrated by Mr One.








🚀 New Features

Extended Verb & Object Registry:

Trading verbs: SIGNAL, TRADE, HEDGE, CLOSE, CANCEL
Coordination verbs: COORD, VOTE, SYNC, ELECT, DELEGATE
Trading objects: MARKET, POOL, WALLET, POSITION, ORDER
Multi-agent objects: SWARM, STRATEGY, CONSENSUS, LEADER, FOLLOWER


Advanced Schema System:

New parameter types: amount, percent, address, timestamp
Validation with min/max constraints
Schema tagging for categorization
Auto-registration of trading schemas


Message Routing & Broadcasting:

Pub/sub channels for agents
Message queuing with TTL
Priority-based message handling
Rate limiting per client


Consensus Voting System:

Submit votes for actions
Automatic consensus checking
Configurable thresholds
Vote aggregation


WebSocket Enhancements:

Dedicated agent endpoints (/ws/agent/{agent_id})
Channel subscriptions
Heartbeat mechanism
Auto-reconnection support


Trading-Specific Endpoints:

/trading/signal - Send market signals
/trading/execute - Execute trades
/trading/schemas - Get trading schemas


Performance & Monitoring:

Metrics tracking endpoint
Connection statistics
Message throughput monitoring
Rate limiting with sliding window



📊 Key Improvements

Optimized Encoding:
python# Percent stored as basis points (0.01% precision)
# Amount stored with 6 decimal precision
# Automatic scale conversion for floats

Enhanced Message Structure:
pythonMessage(
    id: unique_identifier,
    priority: 0-10,
    ttl: time_to_live,
    sender: agent_id,
    recipients: set_of_targets
)

Consensus Example:
python# Agents vote on emergency exit
POST /consensus/vote
{
    "action_id": "EMERGENCY_EXIT",
    "voter_id": "Agent-1",
    "vote": {"action": "exit", "reason": "market_crash"}
}

# Check consensus (auto-triggers at 60% threshold)
GET /consensus/EMERGENCY_EXIT

Trading Signal Flow:
python# Leader sends signal
POST /trading/signal
{
    "signal_type": "BUY",
    "token": "SOL/USDC",
    "strength": 0.85,
    "confidence": 0.92
}

# Broadcasts to all agents via WebSocket
# Followers receive and can auto-execute

Agent WebSocket Connection:
python# Agent connects with dedicated endpoint
ws://localhost:8000/ws/agent/Leader-1

# Auto-subscribes to:
# - "agents" channel (all agents)
# - "agent:Leader-1" channel (personal)

# Receives queued messages automatically
# Heartbeat keeps connection alive


🔧 Usage Examples
Start the enhanced NLC-9 server:
bash# With default settings
python main.py

# With custom configuration
NLC9_HOST=0.0.0.0 \
NLC9_PORT=8000 \
NLC9_ENABLE_PERSISTENCE=true \
NLC9_REDIS_URL=redis://localhost:6379 \
NLC9_DEBUG=true \
python main.py
Send a trading signal:
bashcurl -X POST "http://localhost:8000/trading/signal" \
  -H "Content-Type: application/json" \
  -d '{
    "signal_type": "BUY",
    "token": "SOL/USDC",
    "strength": 0.85,
    "confidence": 0.92,
    "metadata": {"reason": "bullish_pattern"}
  }'
Agent subscribes via WebSocket:
javascriptconst ws = new WebSocket('ws://localhost:8000/ws/agent/Agent-1');

ws.onopen = () => {
    // Agent connected, auto-subscribed to channels
};

ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.type === 'message') {
        // Process incoming NLC-9 message
        console.log('Received:', data.message.decoded);
    }
};

// Send signal
ws.send(JSON.stringify({
    type: 'signal',
    params: {
        strength: 0.8,
        confidence: 0.9,
        token_id: 'SOL/USDC'
    }
}));






npm run dev           # Start everything in dev mode
npm run agent:full    # Start full agent ecosystem
npm run mm:live       # Start live market maker
npm run nlc9:server   # Start NLC-9 server
npm run wizbot:mm:start # Start MM via WizBot

Testing & Quality

Comprehensive test setup with Jest
Coverage reporting
Linting with auto-fix
Pre-commit hooks with Husky


Docker & Deployment Ready

Docker commands included
PM2 ecosystem configuration
Setup scripts for quick start

