# main.py
"""
NLC-9 (Nine-Limb Code) – ultra-compact agent command language
--------------------------------------------------------------

Each message is represented by exactly 9 unsigned 32-bit integers (uint32):
  [0] HEADER  : 4b version | 12b flags | 16b domain_id
  [1] VERB_ID : uint32 (well-known or hashed)
  [2] OBJ_ID  : uint32 (well-known or hashed)
  [3] PARAM_A : uint32 (typed via schema or generic)
  [4] PARAM_B : uint32
  [5] PARAM_C : uint32
  [6] TS_OR_V : uint32 (unix timestamp by default)
  [7] CORR_ID : uint32 (correlation id / nonce)
  [8] CRC32   : uint32 checksum of limbs [0..7] (big-endian packed)

Binary frame = struct.pack('>9I') → 36 bytes.
Default JSON transport returns: numbers[], base64, and hex.

Key ideas:
- "Standardized commands": VERB × OBJECT pairs (e.g., ASK/TASK, EXEC/TOOL)
- Extensible schema per (verb, object) defines how to type/quantize up to 3 params
- Deterministic IDs: Known names map to seeded IDs; unknown names use CRC32 of the lowercase token
- Flags: ACK, STREAM, URGENT, ENCRYPTED, SIGNED
- Domain: 16-bit domain id = CRC16 (CRC32 masked) of a provided domain label
- Safe decode without schema returns raw uint32s + best-effort inference
- WebSocket for streaming: send JSON (encode requests) or base64(36b) to decode

HTTP API (selected):
- POST /encode        -> {verb, object, params{..}, flags[], domain, ts, corr_id} → NLC-9
- POST /decode        -> {numbers[9]} | {base64} | {hex} → expanded message
- POST /schema/register   -> register typing for (verb, object) params
- GET  /schema/{verb}/{object}
- GET  /verbs, /objects, /spec, /ping
- WS   /ws            -> bidirectional encode/decode

This file is self-contained and stateful in-memory (no external DB).
"""

from __future__ import annotations
import base64
import os
import secrets
import struct
import time
import zlib
from typing import Dict, List, Literal, Optional, Tuple, Union

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse, PlainTextResponse
from pydantic import BaseModel, Field, root_validator, validator

app = FastAPI(title="NLC-9 Agent Language", version="1.0.0")

# ---------------------------
# Constants & seeded registries
# ---------------------------

VERSION = 1  # 4 bits (0..15)
UINT32_MASK = 0xFFFFFFFF

FLAG_BITS = {
    "ACK": 0,         # requires ack
    "STREAM": 1,      # chunked/streaming
    "URGENT": 2,      # priority handling
    "ENCRYPTED": 3,   # payload is encrypted elsewhere
    "SIGNED": 4,      # payload authenticity attested
}

SEEDED_VERBS = {
    "PING": 1, "GET": 2, "SET": 3, "ASK": 4, "TELL": 5,
    "PLAN": 6, "EXEC": 7, "REPORT": 8, "ACK": 9, "NACK": 10,
}

SEEDED_OBJECTS = {
    "AGENT": 1, "TASK": 2, "TOOL": 3, "MEMORY": 4, "FILE": 5,
    "MODEL": 6, "ENV": 7, "HEALTH": 8, "EVENT": 9, "ERROR": 10,
}

# Mutable at runtime (kept separate from seed for transparency)
VERBS: Dict[str, int] = dict(SEEDED_VERBS)
OBJECTS: Dict[str, int] = dict(SEEDED_OBJECTS)
REV_VERBS: Dict[int, str] = {v: k for k, v in VERBS.items()}
REV_OBJECTS: Dict[int, str] = {v: k for k, v in OBJECTS.items()}

# ---------------------------
# Utilities
# ---------------------------

def crc32_u32(data: bytes) -> int:
    return zlib.crc32(data) & UINT32_MASK

def token_id(name: str) -> int:
    """Deterministic 32-bit id for unknown verbs/objects/strings."""
    return crc32_u32(name.strip().lower().encode("utf-8"))

def domain_id16(name: Optional[str]) -> int:
    if not name:
        return 0
    return crc32_u32(name.strip().lower().encode("utf-8")) & 0xFFFF

def pack_header(version: int, flags_bits: int, domain16: int) -> int:
    if not (0 <= version <= 15):
        raise ValueError("version must be 0..15")
    if not (0 <= flags_bits < (1 << 12)):
        raise ValueError("flags must fit in 12 bits")
    if not (0 <= domain16 <= 0xFFFF):
        raise ValueError("domain16 must be 0..65535")
    return ((version & 0xF) << 28) | ((flags_bits & 0xFFF) << 16) | (domain16 & 0xFFFF)

def unpack_header(header: int) -> Tuple[int, int, int]:
    version = (header >> 28) & 0xF
    flags = (header >> 16) & 0xFFF
    domain = header & 0xFFFF
    return version, flags, domain

def flags_to_bits(flags: Optional[List[str]]) -> int:
    bits = 0
    if not flags:
        return bits
    for f in flags:
        f_up = f.strip().upper()
        if f_up not in FLAG_BITS:
            raise HTTPException(400, f"Unknown flag: {f}")
        bits |= (1 << FLAG_BITS[f_up])
    return bits

def bits_to_flags(bits: int) -> List[str]:
    out = []
    for name, pos in FLAG_BITS.items():
        if bits & (1 << pos):
            out.append(name)
    return out

def id_for_verb(verb: str) -> int:
    name = verb.strip().upper()
    if name in VERBS:
        return VERBS[name]
    # Use deterministic hash so different services agree
    return token_id(name)

def id_for_object(obj: str) -> int:
    name = obj.strip().upper()
    if name in OBJECTS:
        return OBJECTS[name]
    return token_id(name)

def name_for_verb_id(vid: int) -> str:
    return REV_VERBS.get(vid, f"VERB#{vid}")

def name_for_object_id(oid: int) -> str:
    return REV_OBJECTS.get(oid, f"OBJECT#{oid}")

def u32(n: int) -> int:
    return n & UINT32_MASK

def to_fixed_u32(x: float, scale: int) -> int:
    return u32(int(round(x * scale)))

def from_fixed_u32(n: int, scale: int) -> float:
    return (n & UINT32_MASK) / float(scale)

def pack9(nums: List[int]) -> bytes:
    if len(nums) != 9:
        raise ValueError("Need exactly 9 numbers")
    return struct.pack(">9I", *[u32(v) for v in nums])

def unpack9(b: bytes) -> List[int]:
    if len(b) != 36:
        raise ValueError("Need exactly 36 bytes")
    return list(struct.unpack(">9I", b))

# ---------------------------
# Schema registry for typed params
# ---------------------------

ParamType = Literal["int", "float", "bool", "string", "id"]

class ParamSpec(BaseModel):
    name: str = Field(..., description="Param key (e.g., 'tool_id', 'count', 'temp')")
    type: ParamType
    scale: Optional[int] = Field(
        default=1_000_000,
        description="Only for type='float': multiply by this on encode; divide on decode."
    )

    @validator("name")
    def v_name(cls, v):
        v = v.strip()
        if not v:
            raise ValueError("name must be non-empty")
        return v

class SchemaRegistration(BaseModel):
    verb: str
    object: str
    params: List[ParamSpec] = Field(
        default_factory=list,
        description="Up to 3 param specs; extra ones are ignored."
    )

    @validator("params")
    def max_three(cls, v):
        if len(v) > 3:
            raise ValueError("At most 3 params supported")
        return v

# keyed by (verb_id, object_id) -> [ParamSpec,...]
SCHEMAS: Dict[Tuple[int, int], List[ParamSpec]] = {}

def get_schema(verb_id: int, obj_id: int) -> Optional[List[ParamSpec]]:
    return SCHEMAS.get((verb_id, obj_id))

# ---------------------------
# Encode/Decode models
# ---------------------------

JsonVal = Union[str, int, float, bool]

class EncodeRequest(BaseModel):
    verb: str
    object: str
    params: Optional[Dict[str, JsonVal]] = Field(default=None)
    flags: Optional[List[str]] = Field(default=None)
    domain: Optional[str] = Field(default=None)
    timestamp: Optional[int] = Field(default=None, description="Unix seconds (default now)")
    correlation_id: Optional[int] = Field(default=None, ge=0, le=UINT32_MASK)

class EncodeResponse(BaseModel):
    numbers: List[int]
    base64: str
    hex: str
    header: Dict[str, Union[int, str, List[str]]]

class DecodeRequest(BaseModel):
    numbers: Optional[List[int]] = None
    base64: Optional[str] = None
    hex: Optional[str] = None

    @root_validator
    def one_input(cls, values):
        nums, b64, hx = values.get("numbers"), values.get("base64"), values.get("hex")
        provided = sum(1 for x in (nums, b64, hx) if x is not None)
        if provided != 1:
            raise ValueError("Provide exactly one of: numbers, base64, hex")
        return values

class DecodeResponse(BaseModel):
    numbers: List[int]
    header: Dict[str, Union[int, str, List[str]]]
    decoded: Dict[str, Union[str, int, float, bool, Dict[str, JsonVal]]]
    base64: str
    hex: str
    checksum_ok: bool

# ---------------------------
# Core encode/decode helpers
# ---------------------------

def encode_params_into_slots(
    verb_id: int, obj_id: int, params: Optional[Dict[str, JsonVal]]
) -> Tuple[int, int, int]:
    """
    Returns three uint32s for PARAM_A/B/C via registered schema if present.
    Fallback: take up to 3 keys (sorted) and encode generically:
      - int -> uint32
      - bool -> {False:0, True:1}
      - float -> fixed with scale=1e6
      - string -> token_id(string)
    """
    a = b = c = 0
    if not params:
        return a, b, c

    schema = get_schema(verb_id, obj_id)
    if schema:
        # map by spec order
        slots = [0, 0, 0]
        for i, spec in enumerate(schema):
            if i >= 3:
                break
            val = params.get(spec.name)
            if val is None:
                enc = 0
            else:
                if spec.type == "int":
                    if isinstance(val, bool):
                        enc = 1 if val else 0
                    elif isinstance(val, (int, float)):
                        enc = int(val)
                    elif isinstance(val, str) and val.isdigit():
                        enc = int(val)
                    else:
                        enc = token_id(str(val))
                elif spec.type == "bool":
                    if isinstance(val, bool):
                        enc = 1 if val else 0
                    elif isinstance(val, (int, float)):
                        enc = 1 if int(val) != 0 else 0
                    else:
                        enc = 1 if str(val).lower() in {"1", "true", "yes"} else 0
                elif spec.type == "float":
                    scale = spec.scale or 1_000_000
                    if isinstance(val, (int, float)):
                        enc = to_fixed_u32(float(val), scale)
                    elif isinstance(val, str):
                        try:
                            enc = to_fixed_u32(float(val), scale)
                        except ValueError:
                            enc = token_id(val)
                    else:
                        enc = 0
                elif spec.type in ("string", "id"):
                    enc = token_id(str(val))
                else:
                    enc = 0
            slots[i] = u32(enc)
        a, b, c = slots
        return a, b, c

    # generic fallback
    items = sorted(params.items(), key=lambda kv: kv[0])[:3]
    slots = []
    for k, v in items:
        if isinstance(v, bool):
            enc = 1 if v else 0
        elif isinstance(v, int):
            enc = v
        elif isinstance(v, float):
            enc = to_fixed_u32(v, 1_000_000)
        else:
            enc = token_id(str(v))
        slots.append(u32(enc))
    while len(slots) < 3:
        slots.append(0)
    return slots[0], slots[1], slots[2]

def decode_params_from_slots(
    verb_id: int, obj_id: int, a: int, b: int, c: int
) -> Dict[str, JsonVal]:
    out: Dict[str, JsonVal] = {}
    schema = get_schema(verb_id, obj_id)
    if not schema:
        # Without schema, return raw ints with generic hints
        return {"paramA": a, "paramB": b, "paramC": c}

    slots = [a, b, c]
    for i, spec in enumerate(schema):
        if i >= 3:
            break
        n = slots[i]
        if spec.type == "int":
            out[spec.name] = int(n)
        elif spec.type == "bool":
            out[spec.name] = bool(n & 1)
        elif spec.type == "float":
            out[spec.name] = from_fixed_u32(n, spec.scale or 1_000_000)
        elif spec.type in ("string", "id"):
            # Can't reverse the hash; expose both.
            out[spec.name] = f"ID#{n}"
        else:
            out[spec.name] = n
    return out

def build_numbers(req: EncodeRequest) -> Tuple[List[int], Dict]:
    v_id = id_for_verb(req.verb)
    o_id = id_for_object(req.object)
    a, b, c = encode_params_into_slots(v_id, o_id, req.params or {})
    ts = int(req.timestamp if req.timestamp is not None else time.time())
    corr = u32(req.correlation_id if req.correlation_id is not None else secrets.randbits(32))
    hdr = pack_header(VERSION, flags_to_bits(req.flags), domain_id16(req.domain))

    first8 = [hdr, v_id, o_id, a, b, c, u32(ts), corr]
    crc = crc32_u32(pack9(first8 + [0]))  # compute over first 8 limbs (pad zero)
    nums = first8 + [crc]

    header_info = {
        "version": VERSION,
        "flags": bits_to_flags((hdr >> 16) & 0xFFF),
        "domain_id": hdr & 0xFFFF,
        "verb_id": v_id,
        "verb": name_for_verb_id(v_id),
        "object_id": o_id,
        "object": name_for_object_id(o_id),
    }
    return [u32(n) for n in nums], header_info

def parse_input_to_numbers(data: DecodeRequest) -> List[int]:
    if data.numbers is not None:
        if len(data.numbers) != 9:
            raise HTTPException(400, "numbers must contain exactly 9 integers")
        return [u32(n) for n in data.numbers]
    if data.base64 is not None:
        try:
            b = base64.b64decode(data.base64, validate=True)
        except Exception as e:
            raise HTTPException(400, f"Invalid base64: {e}")
        return unpack9(b)
    if data.hex is not None:
        try:
            b = bytes.fromhex(data.hex)
        except Exception as e:
            raise HTTPException(400, f"Invalid hex: {e}")
        return unpack9(b)
    raise HTTPException(400, "No input provided")

def expand_numbers(nums: List[int]) -> DecodeResponse:
    if len(nums) != 9:
        raise HTTPException(400, "Need 9 numbers")

    hdr, v_id, o_id, a, b, c, ts, corr, crc = [u32(n) for n in nums]
    version, flags_bits, dom16 = unpack_header(hdr)
    if version != VERSION:
        # we allow different version but signal it
        pass
    # verify checksum
    recompute = crc32_u32(pack9([hdr, v_id, o_id, a, b, c, ts, corr, 0]))
    checksum_ok = (recompute == crc)

    decoded_params = decode_params_from_slots(v_id, o_id, a, b, c)

    decoded = {
        "verb_id": int(v_id),
        "verb": name_for_verb_id(v_id),
        "object_id": int(o_id),
        "object": name_for_object_id(o_id),
        "params": decoded_params,
        "timestamp": int(ts),
        "correlation_id": int(corr),
    }
    header = {
        "version": int(version),
        "flags": bits_to_flags(flags_bits),
        "domain_id": int(dom16),
    }
    b = pack9(nums)
    return DecodeResponse(
        numbers=[int(x) for x in nums],
        header=header,
        decoded=decoded,
        base64=base64.b64encode(b).decode("ascii"),
        hex=b.hex(),
        checksum_ok=bool(checksum_ok),
    )

# ---------------------------
# HTTP Endpoints
# ---------------------------

@app.get("/ping", response_class=PlainTextResponse)
def ping():
    return "pong"

@app.get("/spec")
def spec():
    return {
        "version": VERSION,
        "flags": list(FLAG_BITS.keys()),
        "limbs": {
            "0": "HEADER: 4b version | 12b flags | 16b domain_id",
            "1": "VERB_ID",
            "2": "OBJECT_ID",
            "3": "PARAM_A",
            "4": "PARAM_B",
            "5": "PARAM_C",
            "6": "TIMESTAMP (unix seconds) or value",
            "7": "CORRELATION_ID / nonce",
            "8": "CRC32 of limbs[0..7] (big-endian packed)",
        },
        "seeded_verbs": SEEDED_VERBS,
        "seeded_objects": SEEDED_OBJECTS,
        "notes": [
            "Unknown verbs/objects/strings map via CRC32(name.lower()).",
            "Use /schema/register to type params for precise round-trips.",
            "Binary frame is exactly 36 bytes: struct.pack('>9I').",
        ],
    }

@app.get("/verbs")
def verbs():
    return {"verbs": VERBS}

@app.get("/objects")
def objects():
    return {"objects": OBJECTS}

@app.post("/schema/register")
def schema_register(body: SchemaRegistration):
    v_id = id_for_verb(body.verb)
    o_id = id_for_object(body.object)
    SCHEMAS[(v_id, o_id)] = list(body.params)
    return {
        "verb": body.verb.upper(),
        "verb_id": v_id,
        "object": body.object.upper(),
        "object_id": o_id,
        "params": [p.dict() for p in body.params],
        "message": "Schema registered",
    }

@app.get("/schema/{verb}/{object}")
def schema_get(verb: str, object: str):
    v_id = id_for_verb(verb)
    o_id = id_for_object(object)
    sch = get_schema(v_id, o_id)
    if not sch:
        return {"verb": verb.upper(), "object": object.upper(), "schema": None}
    return {
        "verb": verb.upper(),
        "verb_id": v_id,
        "object": object.upper(),
        "object_id": o_id,
        "params": [p.dict() for p in sch],
    }

@app.post("/encode", response_model=EncodeResponse)
def encode(body: EncodeRequest):
    nums, header_info = build_numbers(body)
    b = pack9(nums)
    return EncodeResponse(
        numbers=nums,
        base64=base64.b64encode(b).decode("ascii"),
        hex=b.hex(),
        header=header_info,
    )

@app.post("/decode", response_model=DecodeResponse)
def decode(body: DecodeRequest):
    nums = parse_input_to_numbers(body)
    return expand_numbers(nums)

# ---------------------------
# WebSocket for streaming encode/decode
# ---------------------------

@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    try:
        while True:
            msg = await ws.receive()
            if "bytes" in msg and msg["bytes"] is not None:
                data = msg["bytes"]
                # If it's exactly 36 bytes, try decode as NLC-9
                try:
                    nums = unpack9(data)
                    resp = expand_numbers(nums)
                    await ws.send_json(resp.dict())
                except Exception as e:
                    await ws.send_json({"error": f"binary decode failed: {str(e)}"})
                continue

            text = msg.get("text")
            if not text:
                await ws.send_json({"error": "empty message"})
                continue

            # Heuristic: if looks like base64(36b), try decode; else expect JSON EncodeRequest
            try:
                b = base64.b64decode(text, validate=True)
                if len(b) == 36:
                    nums = unpack9(b)
                    resp = expand_numbers(nums)
                    await ws.send_json(resp.dict())
                    continue
            except Exception:
                pass

            # Try JSON encode request
            try:
                from json import loads
                payload = loads(text)
                req = EncodeRequest(**payload)
                nums, header_info = build_numbers(req)
                b = pack9(nums)
                await ws.send_json({
                    "numbers": nums,
                    "base64": base64.b64encode(b).decode("ascii"),
                    "hex": b.hex(),
                    "header": header_info,
                })
            except Exception as e:
                await ws.send_json({"error": f"unrecognized frame: {str(e)}"})
    except WebSocketDisconnect:
        return

# ---------------------------
# Optional: simple admin to add new verb/object IDs
# ---------------------------

class RegistryItem(BaseModel):
    name: str
    id: Optional[int] = Field(default=None, ge=1, le=UINT32_MASK)

@app.post("/verbs/register")
def verbs_register(item: RegistryItem):
    key = item.name.strip().upper()
    if key in VERBS:
        return {"status": "exists", "name": key, "id": VERBS[key]}
    vid = item.id if item.id else token_id(key)
    VERBS[key] = vid
    REV_VERBS[vid] = key
    return {"status": "ok", "name": key, "id": vid}

@app.post("/objects/register")
def objects_register(item: RegistryItem):
    key = item.name.strip().upper()
    if key in OBJECTS:
        return {"status": "exists", "name": key, "id": OBJECTS[key]}
    oid = item.id if item.id else token_id(key)
    OBJECTS[key] = oid
    REV_OBJECTS[oid] = key
    return {"status": "ok", "name": key, "id": oid}

# ---------------------------
# Example convenience route (demo)
# ---------------------------

@app.post("/demo/ask-tool")
def demo_ask_tool():
    """
    Demo: ASK the TOOL to 'summarize' with temperature 0.2.
    Schema registers two params:
      - tool_id: id
      - temperature: float (scale=1e6)
    """
    # Ensure schema
    SCHEMAS[(id_for_verb("ASK"), id_for_object("TOOL"))] = [
        ParamSpec(name="tool_id", type="id").dict(),
        ParamSpec(name="temperature", type="float", scale=1_000_000).dict(),
    ]  # type: ignore

    req = EncodeRequest(
        verb="ASK",
        object="TOOL",
        params={"tool_id": "summarizer.v1", "temperature": 0.2},
        flags=["ACK"],
        domain="oneainetwork.com",
    )
    nums, header_info = build_numbers(req)
    b = pack9(nums)
    return {
        "numbers": nums,
        "base64": base64.b64encode(b).decode("ascii"),
        "hex": b.hex(),
        "header": header_info,
    }

# ---------------------------
# Entrypoint
# ---------------------------

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "main:app",
        host=os.getenv("HOST", "0.0.0.0"),
        port=int(os.getenv("PORT", "8000")),
        reload=False,
        log_level=os.getenv("LOG_LEVEL", "info"),
    )
