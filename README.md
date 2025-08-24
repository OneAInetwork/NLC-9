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


Why NLC-9?
====

In a world where AI agents need to coordinate in real time, traditional JSON or text-based protocols are too heavy. 

NLC-9 compresses communication into the smallest possible lossless footprint while preserving extensibility.

It is not just a protocol—it is the circulatory system of the One AI Network, where every agent heartbeat is a 9-limb pulse, orchestrated by Mr One.



