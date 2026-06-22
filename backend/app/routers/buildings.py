import asyncio
import logging
import random
from fastapi import APIRouter, Query
import httpx

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api", tags=["buildings"])

# Four independent Overpass mirrors — load is distributed by shuffling per request.
# overpass-api.de is included but often rate-limits (429); the others balance the load.
_OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
]

# Overpass docs require a meaningful User-Agent; Python's default httpx UA triggers
# stricter throttling.
_HEADERS = {
    "User-Agent": "CrisisReporter/1.0 (+https://github.com/ai711/crisis-reporter)",
    "Accept": "application/json",
}


def _overpass_to_geojson(elements: list) -> dict:
    nodes: dict[int, list[float]] = {}
    for el in elements:
        if el.get("type") == "node":
            nodes[el["id"]] = [el["lon"], el["lat"]]

    features = []
    for el in elements:
        if el.get("type") != "way":
            continue
        tags = el.get("tags") or {}
        if not tags.get("building"):
            continue
        ring = [nodes[nid] for nid in el.get("nodes", []) if nid in nodes]
        if len(ring) < 3:
            continue
        if ring[0] != ring[-1]:
            ring.append(ring[0])
        features.append({
            "type": "Feature",
            "properties": {
                "osm_id": el["id"],
                "name": tags.get("name", ""),
                "building": tags.get("building", "yes"),
            },
            "geometry": {"type": "Polygon", "coordinates": [ring]},
        })

    return {"type": "FeatureCollection", "features": features}


@router.get("/buildings")
async def get_buildings(
    south: float = Query(...),
    west: float = Query(...),
    north: float = Query(...),
    east: float = Query(...),
):
    """Proxy Overpass building footprints for mobile clients.

    Fires requests to all mirrors in parallel and returns the first
    successful response, cancelling the rest. This avoids the sequential
    penalty (overpass-api.de 429 → kumi.systems 65 s timeout = 65 s total)
    and keeps total latency ≤ the fastest mirror (~5–15 s).

    Mirror order is shuffled per request to distribute load.
    """
    query = (
        f"[out:json][timeout:30]"
        f"[bbox:{south:.6f},{west:.6f},{north:.6f},{east:.6f}];"
        f'(way["building"];);'
        f"out body;>;out skel qt;"
    )
    bbox_desc = f"bbox=[{south:.4f},{west:.4f},{north:.4f},{east:.4f}]"

    # Per-request per-endpoint timeout: connect 5 s + read 33 s (> Overpass [timeout:30])
    timeout = httpx.Timeout(connect=5.0, read=33.0, write=5.0, pool=2.0)

    async def _try(endpoint: str, client: httpx.AsyncClient) -> dict | None:
        try:
            resp = await client.post(endpoint, data={"data": query})
            if resp.status_code == 429:
                logger.warning("[buildings] %s → 429 rate-limited", endpoint)
                return None
            if resp.status_code != 200:
                logger.warning("[buildings] %s → HTTP %d", endpoint, resp.status_code)
                return None
            payload = resp.json()
            elements = payload.get("elements", [])
            if not elements:
                logger.warning(
                    "[buildings] %s → 0 elements for %s; remark=%r",
                    endpoint, bbox_desc, payload.get("remark"),
                )
                return None
            fc = _overpass_to_geojson(elements)
            logger.info(
                "[buildings] %s → %d elements → %d features for %s",
                endpoint, len(elements), len(fc["features"]), bbox_desc,
            )
            return fc
        except asyncio.CancelledError:
            return None  # another mirror already won
        except httpx.TimeoutException:
            logger.warning("[buildings] %s timeout for %s", endpoint, bbox_desc)
            return None
        except Exception as exc:
            logger.warning("[buildings] %s error for %s: %s", endpoint, bbox_desc, exc)
            return None

    endpoints = random.sample(_OVERPASS_ENDPOINTS, len(_OVERPASS_ENDPOINTS))

    async with httpx.AsyncClient(timeout=timeout, headers=_HEADERS) as client:
        tasks = [asyncio.create_task(_try(ep, client)) for ep in endpoints]
        pending: set[asyncio.Task] = set(tasks)

        try:
            while pending:
                done, pending = await asyncio.wait(
                    pending, return_when=asyncio.FIRST_COMPLETED
                )
                for task in done:
                    result = task.result()
                    if result is not None:
                        for t in pending:
                            t.cancel()
                        await asyncio.gather(*pending, return_exceptions=True)
                        return result
        except Exception as exc:
            logger.error("[buildings] race error for %s: %s", bbox_desc, exc)
            for t in tasks:
                t.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)

    logger.error("[buildings] all %d endpoints failed for %s", len(endpoints), bbox_desc)
    return {"type": "FeatureCollection", "features": []}
