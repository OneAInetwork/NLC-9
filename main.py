#!/usr/bin/env python3
"""
NLC-9 Extended (Nine-Limb Code) – Enhanced Agent Command Language v2.0
========================================================================

Ultra-compact agent communication protocol optimized for multi-agent trading systems.
Each message is exactly 36 bytes (9 uint32 values) with extended capabilities:

  [0] HEADER  : 4b version | 12b flags | 16b domain_id
  [1] VERB_ID : uint32 (action identifier)
  [2] OBJ_ID  : uint32 (target identifier)
  [3] PARAM_A : uint32 (typed parameter)
  [4] PARAM_B : uint32 (typed parameter)
  [5] PARAM_C : uint32 (typed parameter)
  [6] TS_OR_V : uint32 (timestamp or value)
  [7] CORR_ID : uint32 (correlation/session id)
  [8] CRC32   : uint32 (checksum)

Enhanced Features:
- Trading-specific verbs and objects
- Multi-agent coordination primitives
- Message routing and broadcasting
- Priority queuing and urgency handling
- Consensus voting mechanisms
- Performance metrics tracking
- WebSocket pub/sub channels
- Message persistence and replay
- Rate limiting and throttling
- Encryption support ready
"""

from __future__ import annotations
import asyncio
import base64
import hashlib
import json
import os
import secrets
import struct
import time
import zlib
from collections import defaultdict, deque
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from enum import Enum, IntEnum
from typing import Any, Dict, List, Literal, Optional, Set, Tuple, Union

import aioredis
import uvicorn
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect, Depends, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, PlainTextResponse
from pydantic import BaseModel, Field, root_validator, validator
from starlette.websockets import WebSocketState

# ============================================
# CONFIGURATION
# ============================================

class Config:
    VERSION = 2  # Protocol version (4 bits: 0-15)
    UINT32_MASK = 0xFFFFFFFF
    MAX_MESSAGE_QUEUE = 10000
    MAX_CONSENSUS_ITEMS = 1000
    MESSAGE_TTL_SECONDS = 3600
    RATE_LIMIT_MESSAGES = 100
    RATE_LIMIT_WINDOW = 60
    WEBSOCKET_HEARTBEAT = 30
    ENABLE_PERSISTENCE = os.getenv("NLC9_ENABLE_PERSISTENCE", "false").lower() == "true"
    REDIS_URL = os.getenv("NLC9_REDIS_URL", "redis://localhost:6379")
    ENABLE_METRICS = os.getenv("NLC9_ENABLE_METRICS", "true").lower() == "true"
    DEBUG_MODE = os.getenv("NLC9_DEBUG", "false").lower() == "true"

config = Config()

# ============================================
# ENHANCED FLAGS & CONSTANTS
# ============================================

class Flags(IntEnum):
    ACK = 0          # Requires acknowledgment
    STREAM = 1       # Chunked/streaming message
    URGENT = 2       # Priority handling
    ENCRYPTED = 3    # Payload encrypted
    SIGNED = 4       # Message signed
    BROADCAST = 5    # Broadcast to all
    CONSENSUS = 6    # Consensus voting
    REPLAY = 7       # Replay protection
    COMPRESS = 8     # Compressed payload
    ROUTE = 9        # Routing enabled
    METRIC = 10      # Metrics included
    DEBUG = 11       # Debug mode

FLAG_BITS = {flag.name: flag.value for flag in Flags}

# Extended verb registry for trading
SEEDED_VERBS = {
    # Core verbs
    "PING": 1, "GET": 2, "SET": 3, "ASK": 4, "TELL": 5,
    "PLAN": 6, "EXEC": 7, "REPORT": 8, "ACK": 9, "NACK": 10,
    
    # Trading verbs
    "SIGNAL": 11,    # Market signal
    "TRADE": 12,     # Execute trade
    "HEDGE": 13,     # Hedge position
    "CLOSE": 14,     # Close position
    "CANCEL": 15,    # Cancel order
    
    # Coordination verbs
    "COORD": 16,     # Coordinate action
    "VOTE": 17,      # Cast vote
    "SYNC": 18,      # Synchronize state
    "ELECT": 19,     # Leader election
    "DELEGATE": 20,  # Delegate authority
    
    # Monitoring verbs
    "MONITOR": 21,   # Monitor status
    "ALERT": 22,     # Send alert
    "MEASURE": 23,   # Measure metric
    "ANALYZE": 24,   # Analyze data
    "OPTIMIZE": 25,  # Optimize parameters
}

# Extended object registry for trading
SEEDED_OBJECTS = {
    # Core objects
    "AGENT": 1, "TASK": 2, "TOOL": 3, "MEMORY": 4, "FILE": 5,
    "MODEL": 6, "ENV": 7, "HEALTH": 8, "EVENT": 9, "ERROR": 10,
    
    # Trading objects
    "MARKET": 11,    # Market data
    "POOL": 12,      # Liquidity pool
    "WALLET": 13,    # Wallet/account
    "POSITION": 14,  # Trading position
    "ORDER": 15,     # Trade order
    
    # Multi-agent objects
    "SWARM": 16,     # Agent swarm
    "STRATEGY": 17,  # Trading strategy
    "CONSENSUS": 18, # Consensus mechanism
    "LEADER": 19,    # Leader agent
    "FOLLOWER": 20,  # Follower agent
    
    # System objects
    "METRICS": 21,   # Performance metrics
    "CONFIG": 22,    # Configuration
    "NETWORK": 23,   # Network status
    "SECURITY": 24,  # Security settings
    "LOG": 25,       # Logging system
}

# Mutable registries
VERBS: Dict[str, int] = dict(SEEDED_VERBS)
OBJECTS: Dict[str, int] = dict(SEEDED_OBJECTS)
REV_VERBS: Dict[int, str] = {v: k for k, v in VERBS.items()}
REV_OBJECTS: Dict[int, str] = {v: k for k, v in OBJECTS.items()}

# ============================================
# UTILITY FUNCTIONS
# ============================================

def crc32_u32(data: bytes) -> int:
    """Calculate CRC32 and mask to uint32."""
    return zlib.crc32(data) & config.UINT32_MASK

def token_id(name: str) -> int:
    """Generate deterministic 32-bit ID from string."""
    return crc32_u32(name.strip().lower().encode("utf-8"))

def domain_id16(name: Optional[str]) -> int:
    """Generate 16-bit domain ID."""
    if not name:
        return 0
    return crc32_u32(name.strip().lower().encode("utf-8")) & 0xFFFF

def pack_header(version: int, flags_bits: int, domain16: int) -> int:
    """Pack header components into single uint32."""
    if not (0 <= version <= 15):
        raise ValueError("version must be 0..15")
    if not (0 <= flags_bits < (1 << 12)):
        raise ValueError("flags must fit in 12 bits")
    if not (0 <= domain16 <= 0xFFFF):
        raise ValueError("domain16 must be 0..65535")
    return ((version & 0xF) << 28) | ((flags_bits & 0xFFF) << 16) | (domain16 & 0xFFFF)

def unpack_header(header: int) -> Tuple[int, int, int]:
    """Unpack header into components."""
    version = (header >> 28) & 0xF
    flags = (header >> 16) & 0xFFF
    domain = header & 0xFFFF
    return version, flags, domain

def flags_to_bits(flags: Optional[List[str]]) -> int:
    """Convert flag names to bit field."""
    bits = 0
    if not flags:
        return bits
    for f in flags:
        f_up = f.strip().upper()
        if f_up not in FLAG_BITS:
            raise ValueError(f"Unknown flag: {f}")
        bits |= (1 << FLAG_BITS[f_up])
    return bits

def bits_to_flags(bits: int) -> List[str]:
    """Convert bit field to flag names."""
    return [name for name, pos in FLAG_BITS.items() if bits & (1 << pos)]

def u32(n: int) -> int:
    """Mask to uint32."""
    return n & config.UINT32_MASK

def to_fixed_u32(x: float, scale: int) -> int:
    """Convert float to fixed-point uint32."""
    return u32(int(round(x * scale)))

def from_fixed_u32(n: int, scale: int) -> float:
    """Convert fixed-point uint32 to float."""
    return (n & config.UINT32_MASK) / float(scale)

def pack9(nums: List[int]) -> bytes:
    """Pack 9 uint32s into 36 bytes."""
    if len(nums) != 9:
        raise ValueError("Need exactly 9 numbers")
    return struct.pack(">9I", *[u32(v) for v in nums])

def unpack9(b: bytes) -> List[int]:
    """Unpack 36 bytes into 9 uint32s."""
    if len(b) != 36:
        raise ValueError("Need exactly 36 bytes")
    return list(struct.unpack(">9I", b))

# ============================================
# ENHANCED SCHEMA SYSTEM
# ============================================

ParamType = Literal["int", "float", "bool", "string", "id", "hash", "address", "amount", "percent", "timestamp"]

class ParamSpec(BaseModel):
    name: str = Field(..., description="Parameter name")
    type: ParamType
    scale: Optional[int] = Field(default=1_000_000, description="Scale for float types")
    min_value: Optional[float] = Field(default=None, description="Minimum value")
    max_value: Optional[float] = Field(default=None, description="Maximum value")
    required: bool = Field(default=True, description="Is parameter required")
    description: Optional[str] = Field(default=None, description="Parameter description")

    @validator("name")
    def validate_name(cls, v):
        v = v.strip()
        if not v:
            raise ValueError("name must be non-empty")
        return v

class SchemaRegistration(BaseModel):
    verb: str
    object: str
    params: List[ParamSpec] = Field(default_factory=list, max_items=3)
    description: Optional[str] = None
    examples: Optional[List[Dict]] = None
    tags: Optional[List[str]] = None

    @validator("params")
    def max_three_params(cls, v):
        if len(v) > 3:
            raise ValueError("Maximum 3 parameters supported")
        return v

# Schema storage
SCHEMAS: Dict[Tuple[int, int], SchemaRegistration] = {}

# ============================================
# MESSAGE MODELS
# ============================================

JsonVal = Union[str, int, float, bool, None]

class EncodeRequest(BaseModel):
    verb: str
    object: str
    params: Optional[Dict[str, JsonVal]] = None
    flags: Optional[List[str]] = None
    domain: Optional[str] = None
    timestamp: Optional[int] = None
    correlation_id: Optional[int] = None
    priority: Optional[int] = Field(default=5, ge=0, le=10)
    ttl: Optional[int] = Field(default=3600, description="Time to live in seconds")

class EncodeResponse(BaseModel):
    numbers: List[int]
    base64: str
    hex: str
    header: Dict[str, Any]
    metadata: Optional[Dict[str, Any]] = None

class DecodeRequest(BaseModel):
    numbers: Optional[List[int]] = None
    base64: Optional[str] = None
    hex: Optional[str] = None

    @root_validator
    def one_input_required(cls, values):
        provided = sum(1 for v in [values.get("numbers"), values.get("base64"), values.get("hex")] if v)
        if provided != 1:
            raise ValueError("Provide exactly one of: numbers, base64, hex")
        return values

class DecodeResponse(BaseModel):
    numbers: List[int]
    header: Dict[str, Any]
    decoded: Dict[str, Any]
    base64: str
    hex: str
    checksum_ok: bool
    metadata: Optional[Dict[str, Any]] = None

# ============================================
# MESSAGE QUEUE & ROUTING
# ============================================

@dataclass
class Message:
    """Internal message representation."""
    id: str
    numbers: List[int]
    header: Dict[str, Any]
    decoded: Dict[str, Any]
    timestamp: float
    priority: int
    ttl: int
    sender: Optional[str] = None
    recipients: Set[str] = field(default_factory=set)
    
    def is_expired(self) -> bool:
        return time.time() - self.timestamp > self.ttl

class MessageRouter:
    """Routes messages between agents and handles pub/sub."""
    
    def __init__(self):
        self.queues: Dict[str, deque] = defaultdict(lambda: deque(maxlen=config.MAX_MESSAGE_QUEUE))
        self.subscriptions: Dict[str, Set[str]] = defaultdict(set)
        self.consensus_votes: Dict[str, Dict[str, Any]] = defaultdict(dict)
        self.metrics: Dict[str, int] = defaultdict(int)
        self.rate_limits: Dict[str, List[float]] = defaultdict(list)
    
    def publish(self, channel: str, message: Message) -> int:
        """Publish message to channel."""
        subscribers = self.subscriptions.get(channel, set())
        for subscriber in subscribers:
            self.queues[subscriber].append(message)
        self.metrics["messages_published"] += 1
        return len(subscribers)
    
    def subscribe(self, channel: str, subscriber: str) -> None:
        """Subscribe to channel."""
        self.subscriptions[channel].add(subscriber)
        self.metrics["subscriptions"] += 1
    
    def unsubscribe(self, channel: str, subscriber: str) -> None:
        """Unsubscribe from channel."""
        self.subscriptions[channel].discard(subscriber)
    
    def get_messages(self, subscriber: str, limit: int = 10) -> List[Message]:
        """Get messages for subscriber."""
        queue = self.queues.get(subscriber, deque())
        messages = []
        while queue and len(messages) < limit:
            msg = queue.popleft()
            if not msg.is_expired():
                messages.append(msg)
        return messages
    
    def add_consensus_vote(self, action_id: str, voter_id: str, vote: Any) -> None:
        """Add vote for consensus action."""
        if len(self.consensus_votes) >= config.MAX_CONSENSUS_ITEMS:
            # Remove oldest consensus item
            oldest = min(self.consensus_votes.keys())
            del self.consensus_votes[oldest]
        self.consensus_votes[action_id][voter_id] = vote
    
    def check_consensus(self, action_id: str, threshold: float) -> Optional[Any]:
        """Check if consensus reached."""
        votes = self.consensus_votes.get(action_id, {})
        if not votes:
            return None
        
        # Count votes
        vote_counts = defaultdict(int)
        for vote in votes.values():
            vote_key = json.dumps(vote, sort_keys=True)
            vote_counts[vote_key] += 1
        
        # Check if any vote exceeds threshold
        total_votes = len(votes)
        for vote_key, count in vote_counts.items():
            if count / total_votes >= threshold:
                return json.loads(vote_key)
        return None
    
    def check_rate_limit(self, client_id: str) -> bool:
        """Check if client exceeded rate limit."""
        now = time.time()
        window_start = now - config.RATE_LIMIT_WINDOW
        
        # Clean old timestamps
        self.rate_limits[client_id] = [
            ts for ts in self.rate_limits[client_id] 
            if ts > window_start
        ]
        
        # Check limit
        if len(self.rate_limits[client_id]) >= config.RATE_LIMIT_MESSAGES:
            return False
        
        self.rate_limits[client_id].append(now)
        return True
    
    def get_metrics(self) -> Dict[str, Any]:
        """Get router metrics."""
        return {
            "total_messages": self.metrics["messages_published"],
            "active_subscriptions": sum(len(subs) for subs in self.subscriptions.values()),
            "active_queues": len(self.queues),
            "consensus_items": len(self.consensus_votes),
            "rate_limited_clients": len(self.rate_limits),
        }

# ============================================
# WEBSOCKET CONNECTION MANAGER
# ============================================

class ConnectionManager:
    """Manages WebSocket connections and broadcasts."""
    
    def __init__(self):
        self.active_connections: Dict[str, WebSocket] = {}
        self.connection_metadata: Dict[str, Dict[str, Any]] = {}
        self.channels: Dict[str, Set[str]] = defaultdict(set)
    
    async def connect(self, client_id: str, websocket: WebSocket, metadata: Dict = None):
        """Accept new connection."""
        await websocket.accept()
        self.active_connections[client_id] = websocket
        self.connection_metadata[client_id] = metadata or {}
        self.connection_metadata[client_id]["connected_at"] = time.time()
    
    def disconnect(self, client_id: str):
        """Remove connection."""
        if client_id in self.active_connections:
            del self.active_connections[client_id]
            del self.connection_metadata[client_id]
            # Remove from all channels
            for channel in self.channels.values():
                channel.discard(client_id)
    
    async def send_personal_message(self, message: str, client_id: str):
        """Send message to specific client."""
        if client_id in self.active_connections:
            websocket = self.active_connections[client_id]
            if websocket.client_state == WebSocketState.CONNECTED:
                await websocket.send_text(message)
    
    async def broadcast(self, message: str, channel: str = None):
        """Broadcast message to all or channel."""
        disconnected = []
        targets = self.channels.get(channel, self.active_connections.keys()) if channel else self.active_connections.keys()
        
        for client_id in targets:
            if client_id in self.active_connections:
                try:
                    await self.active_connections[client_id].send_text(message)
                except:
                    disconnected.append(client_id)
        
        # Clean up disconnected clients
        for client_id in disconnected:
            self.disconnect(client_id)
    
    def join_channel(self, client_id: str, channel: str):
        """Join a broadcast channel."""
        self.channels[channel].add(client_id)
    
    def leave_channel(self, client_id: str, channel: str):
        """Leave a broadcast channel."""
        self.channels[channel].discard(client_id)
    
    def get_stats(self) -> Dict[str, Any]:
        """Get connection statistics."""
        return {
            "active_connections": len(self.active_connections),
            "channels": {ch: len(clients) for ch, clients in self.channels.items()},
            "uptime_seconds": {
                cid: time.time() - meta["connected_at"]
                for cid, meta in self.connection_metadata.items()
            }
        }

# ============================================
# ENHANCED CODEC
# ============================================

class NLC9Codec:
    """Enhanced encoder/decoder with schema support."""
    
    @staticmethod
    def encode_params(verb_id: int, obj_id: int, params: Optional[Dict[str, JsonVal]]) -> Tuple[int, int, int]:
        """Encode parameters into three uint32s."""
        a = b = c = 0
        if not params:
            return a, b, c
        
        # Try to get schema
        schema_key = (verb_id, obj_id)
        if schema_key in SCHEMAS:
            schema = SCHEMAS[schema_key]
            slots = [0, 0, 0]
            
            for i, spec in enumerate(schema.params[:3]):
                val = params.get(spec.name)
                if val is None:
                    if spec.required:
                        raise ValueError(f"Required parameter '{spec.name}' missing")
                    slots[i] = 0
                    continue
                
                # Encode based on type
                if spec.type == "int":
                    slots[i] = u32(int(val))
                elif spec.type == "float":
                    slots[i] = to_fixed_u32(float(val), spec.scale or 1_000_000)
                elif spec.type == "bool":
                    slots[i] = 1 if val else 0
                elif spec.type == "percent":
                    # Store as basis points (0.01% precision)
                    slots[i] = u32(int(float(val) * 10000))
                elif spec.type == "amount":
                    # Store with 6 decimal precision
                    slots[i] = to_fixed_u32(float(val), 1_000_000)
                elif spec.type == "timestamp":
                    slots[i] = u32(int(val))
                elif spec.type in ("string", "id", "hash", "address"):
                    slots[i] = token_id(str(val))
                else:
                    slots[i] = u32(int(val))
                
                # Apply constraints
                if spec.min_value is not None and slots[i] < spec.min_value:
                    raise ValueError(f"Parameter '{spec.name}' below minimum value")
                if spec.max_value is not None and slots[i] > spec.max_value:
                    raise ValueError(f"Parameter '{spec.name}' above maximum value")
            
            a, b, c = slots
        else:
            # Generic encoding for unknown schemas
            items = sorted(params.items())[:3]
            slots = []
            for k, v in items:
                if isinstance(v, bool):
                    enc = 1 if v else 0
                elif isinstance(v, (int, float)):
                    enc = to_fixed_u32(float(v), 1_000_000) if isinstance(v, float) else v
                else:
                    enc = token_id(str(v))
                slots.append(u32(enc))
            while len(slots) < 3:
                slots.append(0)
            a, b, c = slots
        
        return a, b, c
    
    @staticmethod
    def decode_params(verb_id: int, obj_id: int, a: int, b: int, c: int) -> Dict[str, JsonVal]:
        """Decode parameters from three uint32s."""
        schema_key = (verb_id, obj_id)
        
        if schema_key in SCHEMAS:
            schema = SCHEMAS[schema_key]
            result = {}
            slots = [a, b, c]
            
            for i, spec in enumerate(schema.params[:3]):
                if i >= 3:
                    break
                val = slots[i]
                
                if spec.type == "int":
                    result[spec.name] = val
                elif spec.type == "float":
                    result[spec.name] = from_fixed_u32(val, spec.scale or 1_000_000)
                elif spec.type == "bool":
                    result[spec.name] = bool(val & 1)
                elif spec.type == "percent":
                    result[spec.name] = val / 10000.0
                elif spec.type == "amount":
                    result[spec.name] = val / 1_000_000.0
                elif spec.type == "timestamp":
                    result[spec.name] = val
                elif spec.type in ("string", "id", "hash", "address"):
                    # Can't reverse hash, return as ID reference
                    result[spec.name] = f"ID#{val}"
                else:
                    result[spec.name] = val
            
            return result
        else:
            # Generic decoding
            return {
                "paramA": a,
                "paramB": b,
                "paramC": c,
            }
    
    @staticmethod
    def build_message(req: EncodeRequest) -> Tuple[List[int], Dict[str, Any]]:
        """Build NLC9 message from request."""
        # Get IDs
        verb_id = VERBS.get(req.verb.upper(), token_id(req.verb))
        obj_id = OBJECTS.get(req.object.upper(), token_id(req.object))
        
        # Encode parameters
        a, b, c = NLC9Codec.encode_params(verb_id, obj_id, req.params)
        
        # Build message
        ts = int(req.timestamp if req.timestamp is not None else time.time())
        corr = u32(req.correlation_id if req.correlation_id is not None else secrets.randbits(32))
        hdr = pack_header(config.VERSION, flags_to_bits(req.flags), domain_id16(req.domain))
        
        # Calculate checksum
        first8 = [hdr, verb_id, obj_id, a, b, c, u32(ts), corr]
        crc = crc32_u32(pack9(first8 + [0]))
        nums = first8 + [crc]
        
        # Build header info
        header_info = {
            "version": config.VERSION,
            "flags": bits_to_flags((hdr >> 16) & 0xFFF),
            "domain_id": hdr & 0xFFFF,
            "domain": req.domain,
            "verb_id": verb_id,
            "verb": REV_VERBS.get(verb_id, f"VERB#{verb_id}"),
            "object_id": obj_id,
            "object": REV_OBJECTS.get(obj_id, f"OBJECT#{obj_id}"),
            "priority": req.priority or 5,
            "ttl": req.ttl or 3600,
        }
        
        return [u32(n) for n in nums], header_info
    
    @staticmethod
    def parse_message(nums: List[int]) -> DecodeResponse:
        """Parse NLC9 message from numbers."""
        if len(nums) != 9:
            raise ValueError("Need exactly 9 numbers")
        
        hdr, v_id, o_id, a, b, c, ts, corr, crc = [u32(n) for n in nums]
        version, flags_bits, dom16 = unpack_header(hdr)
        
        # Verify checksum
        recompute = crc32_u32(pack9([hdr, v_id, o_id, a, b, c, ts, corr, 0]))
        checksum_ok = (recompute == crc)
        
        # Decode parameters
        decoded_params = NLC9Codec.decode_params(v_id, o_id, a, b, c)
        
        # Build response
        decoded = {
            "verb_id": v_id,
            "verb": REV_VERBS.get(v_id, f"VERB#{v_id}"),
            "object_id": o_id,
            "object": REV_OBJECTS.get(o_id, f"OBJECT#{o_id}"),
            "params": decoded_params,
            "timestamp": ts,
            "correlation_id": corr,
        }
        
        header = {
            "version": version,
            "flags": bits_to_flags(flags_bits),
            "domain_id": dom16,
        }
        
        # Get schema info if available
        metadata = None
        schema_key = (v_id, o_id)
        if schema_key in SCHEMAS:
            schema = SCHEMAS[schema_key]
            metadata = {
                "schema": {
                    "description": schema.description,
                    "tags": schema.tags,
                }
            }
        
        b = pack9(nums)
        return DecodeResponse(
            numbers=[int(x) for x in nums],
            header=header,
            decoded=decoded,
            base64=base64.b64encode(b).decode("ascii"),
            hex=b.hex(),
            checksum_ok=checksum_ok,
            metadata=metadata,
        )

# ============================================
# TRADING SCHEMAS
# ============================================

def register_trading_schemas():
    """Register all trading-related schemas."""
    
    # Market signal schema
    SCHEMAS[(VERBS["SIGNAL"], OBJECTS["MARKET"])] = SchemaRegistration(
        verb="SIGNAL",
        object="MARKET",
        params=[
            ParamSpec(name="strength", type="percent", min_value=0, max_value=1),
            ParamSpec(name="confidence", type="percent", min_value=0, max_value=1),
            ParamSpec(name="token_id", type="id"),
        ],
        description="Broadcast market signal",
        tags=["trading", "signal"],
    )
    
    # Trade execution schema
    SCHEMAS[(VERBS["EXEC"], OBJECTS.get("TRADE", token_id("trade")))] = SchemaRegistration(
        verb="EXEC",
        object="TRADE",
        params=[
            ParamSpec(name="pool_id", type="id"),
            ParamSpec(name="amount", type="amount", min_value=0),
            ParamSpec(name="slippage", type="int", min_value=0, max_value=10000),
        ],
        description="Execute trade order",
        tags=["trading", "execution"],
    )
    
    # Swarm coordination schema
    SCHEMAS[(VERBS.get("COORD", token_id("coord")), OBJECTS["SWARM"])] = SchemaRegistration(
        verb="COORD",
        object="SWARM",
        params=[
            ParamSpec(name="action_id", type="id"),
            ParamSpec(name="consensus", type="percent", min_value=0, max_value=1),
            ParamSpec(name="priority", type="int", min_value=0, max_value=10),
        ],
        description="Coordinate swarm action",
        tags=["coordination", "swarm"],
    )
    
    # Wallet operation schema
    SCHEMAS[(VERBS["EXEC"], OBJECTS["WALLET"])] = SchemaRegistration(
        verb="EXEC",
        object="WALLET",
        params=[
            ParamSpec(name="operation", type="id"),
            ParamSpec(name="amount", type="amount"),
            ParamSpec(name="target", type="address", required=False),
        ],
        description="Execute wallet operation",
        tags=["wallet", "transfer"],
    )
    
    # Strategy update schema
    SCHEMAS[(VERBS["SET"], OBJECTS["STRATEGY"])] = SchemaRegistration(
        verb="SET",
        object="STRATEGY",
        params=[
            ParamSpec(name="risk_level", type="percent", min_value=0, max_value=1),
            ParamSpec(name="leverage", type="float", scale=100, min_value=0, max_value=10),
            ParamSpec(name="max_drawdown", type="percent", min_value=0, max_value=1),
        ],
        description="Update strategy parameters",
        tags=["strategy", "risk"],
    )

# ============================================
# FASTAPI APPLICATION
# ============================================

app = FastAPI(
    title="NLC-9 Extended Protocol",
    version="2.0.0",
    description="Ultra-compact agent communication protocol for multi-agent trading systems",
)

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Initialize components
router = MessageRouter()
manager = ConnectionManager()
codec = NLC9Codec()

# Register trading schemas on startup
@app.on_event("startup")
async def startup_event():
    register_trading_schemas()
    if config.ENABLE_PERSISTENCE:
        # Initialize Redis connection if persistence enabled
        app.state.redis = await aioredis.create_redis_pool(config.REDIS_URL)

@app.on_event("shutdown")
async def shutdown_event():
    if hasattr(app.state, "redis"):
        app.state.redis.close()
        await app.state.redis.wait_closed()

# ============================================
# HTTP ENDPOINTS
# ============================================

@app.get("/", response_class=PlainTextResponse)
def root():
    return "NLC-9 Extended Protocol v2.0"

@app.get("/ping", response_class=PlainTextResponse)
def ping():
    return "pong"

@app.get("/spec")
def get_spec():
    """Get protocol specification."""
    return {
        "version": config.VERSION,
        "flags": list(FLAG_BITS.keys()),
        "verbs": VERBS,
        "objects": OBJECTS,
        "limbs": {
            "0": "HEADER: 4b version | 12b flags | 16b domain_id",
            "1": "VERB_ID: Action identifier",
            "2": "OBJECT_ID: Target identifier",
            "3": "PARAM_A: First parameter",
            "4": "PARAM_B: Second parameter",
            "5": "PARAM_C: Third parameter",
            "6": "TIMESTAMP: Unix seconds",
            "7": "CORRELATION_ID: Session/nonce",
            "8": "CRC32: Checksum",
        },
        "features": [
            "Trading-specific verbs and objects",
            "Multi-agent coordination",
            "Consensus voting",
            "Message routing",
            "WebSocket pub/sub",
            "Schema validation",
            "Rate limiting",
            "Metrics tracking",
        ],
    }

@app.get("/verbs")
def get_verbs(category: Optional[str] = None):
    """Get registered verbs."""
    if category == "trading":
        trading_verbs = {k: v for k, v in VERBS.items() if v >= 11 and v <= 15}
        return {"verbs": trading_verbs, "category": "trading"}
    elif category == "coordination":
        coord_verbs = {k: v for k, v in VERBS.items() if v >= 16 and v <= 20}
        return {"verbs": coord_verbs, "category": "coordination"}
    return {"verbs": VERBS}

@app.get("/objects")
def get_objects(category: Optional[str] = None):
    """Get registered objects."""
    if category == "trading":
        trading_objs = {k: v for k, v in OBJECTS.items() if v >= 11 and v <= 15}
        return {"objects": trading_objs, "category": "trading"}
    elif category == "agent":
        agent_objs = {k: v for k, v in OBJECTS.items() if v >= 16 and v <= 20}
        return {"objects": agent_objs, "category": "agent"}
    return {"objects": OBJECTS}

@app.post("/encode", response_model=EncodeResponse)
def encode_message(req: EncodeRequest):
    """Encode message to NLC-9 format."""
    try:
        nums, header = codec.build_message(req)
        b = pack9(nums)
        
        # Store message if persistence enabled
        if config.ENABLE_PERSISTENCE and hasattr(app.state, "redis"):
            message_id = f"msg:{header['verb']}:{header['object']}:{nums[7]}"
            asyncio.create_task(
                app.state.redis.setex(message_id, req.ttl or 3600, b)
            )
        
        return EncodeResponse(
            numbers=nums,
            base64=base64.b64encode(b).decode("ascii"),
            hex=b.hex(),
            header=header,
            metadata={"priority": req.priority, "ttl": req.ttl},
        )
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

@app.post("/decode", response_model=DecodeResponse)
def decode_message(req: DecodeRequest):
    """Decode NLC-9 message."""
    try:
        # Parse input
        if req.numbers:
            nums = req.numbers
        elif req.base64:
            b = base64.b64decode(req.base64)
            nums = unpack9(b)
        elif req.hex:
            b = bytes.fromhex(req.hex)
            nums = unpack9(b)
        else:
            raise ValueError("No input provided")
        
        return codec.parse_message(nums)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

@app.post("/schema/register")
def register_schema(schema: SchemaRegistration):
    """Register parameter schema for verb/object pair."""
    verb_id = VERBS.get(schema.verb.upper(), token_id(schema.verb))
    obj_id = OBJECTS.get(schema.object.upper(), token_id(schema.object))
    
    SCHEMAS[(verb_id, obj_id)] = schema
    
    return {
        "status": "registered",
        "verb": schema.verb.upper(),
        "verb_id": verb_id,
        "object": schema.object.upper(),
        "object_id": obj_id,
        "params": [p.dict() for p in schema.params],
    }

@app.get("/schema/{verb}/{object}")
def get_schema(verb: str, object: str):
    """Get schema for verb/object pair."""
    verb_id = VERBS.get(verb.upper(), token_id(verb))
    obj_id = OBJECTS.get(object.upper(), token_id(object))
    
    schema = SCHEMAS.get((verb_id, obj_id))
    if not schema:
        return {"verb": verb.upper(), "object": object.upper(), "schema": None}
    
    return {
        "verb": verb.upper(),
        "verb_id": verb_id,
        "object": object.upper(),
        "object_id": obj_id,
        "schema": schema.dict(),
    }

@app.get("/schemas")
def list_schemas(tag: Optional[str] = None):
    """List all registered schemas."""
    schemas = []
    for (v_id, o_id), schema in SCHEMAS.items():
        if tag and (not schema.tags or tag not in schema.tags):
            continue
        schemas.append({
            "verb": REV_VERBS.get(v_id, f"VERB#{v_id}"),
            "object": REV_OBJECTS.get(o_id, f"OBJECT#{o_id}"),
            "description": schema.description,
            "tags": schema.tags,
        })
    return {"schemas": schemas, "count": len(schemas)}

@app.post("/broadcast")
async def broadcast_message(req: EncodeRequest, channel: str = "general"):
    """Encode and broadcast message to channel."""
    try:
        # Check rate limit
        client_id = str(req.correlation_id or "anonymous")
        if not router.check_rate_limit(client_id):
            raise HTTPException(status_code=429, detail="Rate limit exceeded")
        
        # Encode message
        nums, header = codec.build_message(req)
        b = pack9(nums)
        
        # Create internal message
        message = Message(
            id=f"{header['verb']}:{header['object']}:{nums[7]}",
            numbers=nums,
            header=header,
            decoded={"params": req.params},
            timestamp=time.time(),
            priority=req.priority or 5,
            ttl=req.ttl or 3600,
            sender=client_id,
        )
        
        # Publish to channel
        subscribers = router.publish(channel, message)
        
        # Broadcast via WebSocket
        await manager.broadcast(
            json.dumps({
                "type": "broadcast",
                "channel": channel,
                "message": {
                    "base64": base64.b64encode(b).decode("ascii"),
                    "header": header,
                }
            }),
            channel=channel
        )
        
        return {
            "status": "broadcast",
            "channel": channel,
            "subscribers": subscribers,
            "message_id": message.id,
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))

@app.post("/consensus/vote")
def submit_consensus_vote(
    action_id: str,
    voter_id: str,
    vote: Dict[str, Any]
):
    """Submit vote for consensus action."""
    router.add_consensus_vote(action_id, voter_id, vote)
    
    # Check if consensus reached
    result = router.check_consensus(action_id, threshold=0.6)
    
    return {
        "action_id": action_id,
        "voter_id": voter_id,
        "vote_recorded": True,
        "consensus_reached": result is not None,
        "consensus_result": result,
    }

@app.get("/consensus/{action_id}")
def get_consensus_status(action_id: str):
    """Get consensus voting status."""
    votes = router.consensus_votes.get(action_id, {})
    result = router.check_consensus(action_id, threshold=0.6)
    
    return {
        "action_id": action_id,
        "total_votes": len(votes),
        "voters": list(votes.keys()),
        "consensus_reached": result is not None,
        "consensus_result": result,
    }

@app.get("/metrics")
def get_metrics():
    """Get system metrics."""
    return {
        "router": router.get_metrics(),
        "connections": manager.get_stats(),
        "schemas": len(SCHEMAS),
        "verbs": len(VERBS),
        "objects": len(OBJECTS),
    }

# ============================================
# WEBSOCKET ENDPOINTS
# ============================================

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    """Main WebSocket endpoint for bidirectional communication."""
    client_id = f"ws_{secrets.token_hex(8)}"
    await manager.connect(client_id, websocket)
    
    try:
        while True:
            # Receive message
            data = await websocket.receive()
            
            if "bytes" in data and data["bytes"]:
                # Binary message - try to decode as NLC-9
                try:
                    nums = unpack9(data["bytes"])
                    response = codec.parse_message(nums)
                    await websocket.send_json(response.dict())
                except Exception as e:
                    await websocket.send_json({"error": str(e)})
            
            elif "text" in data and data["text"]:
                # Text message - parse as JSON command
                try:
                    msg = json.loads(data["text"])
                    
                    if msg.get("type") == "subscribe":
                        # Subscribe to channel
                        channel = msg.get("channel", "general")
                        router.subscribe(channel, client_id)
                        manager.join_channel(client_id, channel)
                        await websocket.send_json({
                            "type": "subscribed",
                            "channel": channel,
                        })
                    
                    elif msg.get("type") == "encode":
                        # Encode message
                        req = EncodeRequest(**msg.get("data", {}))
                        nums, header = codec.build_message(req)
                        b = pack9(nums)
                        await websocket.send_json({
                            "type": "encoded",
                            "base64": base64.b64encode(b).decode("ascii"),
                            "header": header,
                        })
                    
                    elif msg.get("type") == "decode":
                        # Decode message
                        if "base64" in msg:
                            b = base64.b64decode(msg["base64"])
                            nums = unpack9(b)
                            response = codec.parse_message(nums)
                            await websocket.send_json(response.dict())
                    
                    elif msg.get("type") == "heartbeat":
                        # Heartbeat
                        await websocket.send_json({"type": "heartbeat", "timestamp": time.time()})
                    
                    else:
                        await websocket.send_json({"error": "Unknown message type"})
                        
                except Exception as e:
                    await websocket.send_json({"error": str(e)})
    
    except WebSocketDisconnect:
        manager.disconnect(client_id)
        router.unsubscribe("general", client_id)

@app.websocket("/ws/agent/{agent_id}")
async def agent_websocket(websocket: WebSocket, agent_id: str):
    """Dedicated WebSocket endpoint for agents."""
    await manager.connect(agent_id, websocket, {"type": "agent"})
    
    try:
        # Auto-subscribe to agent channels
        router.subscribe("agents", agent_id)
        router.subscribe(f"agent:{agent_id}", agent_id)
        manager.join_channel(agent_id, "agents")
        
        await websocket.send_json({
            "type": "connected",
            "agent_id": agent_id,
            "channels": ["agents", f"agent:{agent_id}"],
        })
        
        while True:
            # Check for queued messages
            messages = router.get_messages(agent_id, limit=10)
            for msg in messages:
                await websocket.send_json({
                    "type": "message",
                    "message": {
                        "id": msg.id,
                        "base64": base64.b64encode(pack9(msg.numbers)).decode("ascii"),
                        "header": msg.header,
                        "decoded": msg.decoded,
                    }
                })
            
            # Handle incoming messages
            try:
                data = await asyncio.wait_for(websocket.receive(), timeout=1.0)
                
                if "text" in data:
                    msg = json.loads(data["text"])
                    
                    # Process agent commands
                    if msg.get("type") == "signal":
                        # Agent broadcasting signal
                        await broadcast_message(
                            EncodeRequest(
                                verb="SIGNAL",
                                object="MARKET",
                                params=msg.get("params"),
                                flags=["BROADCAST", "URGENT"],
                                domain=f"agent.{agent_id}",
                            ),
                            channel="signals"
                        )
                    
                    elif msg.get("type") == "vote":
                        # Agent voting
                        submit_consensus_vote(
                            msg["action_id"],
                            agent_id,
                            msg["vote"]
                        )
                    
            except asyncio.TimeoutError:
                # Send heartbeat
                await websocket.send_json({"type": "heartbeat"})
                
    except WebSocketDisconnect:
        manager.disconnect(agent_id)
        router.unsubscribe("agents", agent_id)
        router.unsubscribe(f"agent:{agent_id}", agent_id)

# ============================================
# TRADING-SPECIFIC ENDPOINTS
# ============================================

@app.post("/trading/signal")
async def send_trading_signal(
    signal_type: Literal["BUY", "SELL", "HOLD", "ALERT"],
    token: str,
    strength: float = Query(ge=0, le=1),
    confidence: float = Query(ge=0, le=1),
    metadata: Optional[Dict] = None
):
    """Send trading signal to all agents."""
    req = EncodeRequest(
        verb="SIGNAL",
        object="MARKET",
        params={
            "strength": strength,
            "confidence": confidence,
            "token_id": token,
        },
        flags=["BROADCAST", "URGENT"] if signal_type in ["BUY", "SELL"] else ["BROADCAST"],
        domain="trading.signals",
    )
    
    result = await broadcast_message(req, channel="trading_signals")
    
    return {
        **result,
        "signal": {
            "type": signal_type,
            "token": token,
            "strength": strength,
            "confidence": confidence,
            "metadata": metadata,
        }
    }

@app.post("/trading/execute")
def execute_trade(
    pool_id: str,
    amount: float,
    slippage_bps: int = 50,
    agent_id: Optional[str] = None
):
    """Execute trade order."""
    req = EncodeRequest(
        verb="EXEC",
        object="TRADE",
        params={
            "pool_id": pool_id,
            "amount": amount,
            "slippage": slippage_bps,
        },
        flags=["ACK", "URGENT"],
        domain=f"agent.{agent_id}" if agent_id else "trading",
    )
    
    nums, header = codec.build_message(req)
    b = pack9(nums)
    
    return {
        "status": "trade_queued",
        "message": {
            "base64": base64.b64encode(b).decode("ascii"),
            "header": header,
        },
        "trade": {
            "pool_id": pool_id,
            "amount": amount,
            "slippage_bps": slippage_bps,
        }
    }

@app.get("/trading/schemas")
def get_trading_schemas():
    """Get all trading-related schemas."""
    trading_schemas = []
    for (v_id, o_id), schema in SCHEMAS.items():
        if schema.tags and "trading" in schema.tags:
            trading_schemas.append({
                "verb": REV_VERBS.get(v_id, f"VERB#{v_id}"),
                "object": REV_OBJECTS.get(o_id, f"OBJECT#{o_id}"),
                "params": [p.dict() for p in schema.params],
                "description": schema.description,
            })
    return {"schemas": trading_schemas}

# ============================================
# MAIN ENTRY POINT
# ============================================

if __name__ == "__main__":
    uvicorn.run(
        "main:app",
        host=os.getenv("NLC9_HOST", "0.0.0.0"),
        port=int(os.getenv("NLC9_PORT", "8000")),
        reload=config.DEBUG_MODE,
        log_level=os.getenv("NLC9_LOG_LEVEL", "info"),
    )