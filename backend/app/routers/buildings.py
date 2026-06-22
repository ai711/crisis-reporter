import logging
from fastapi import APIRouter, Query
import httpx

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api", tags=["buildings"])

_OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]

# Overpass docs: always set a meaningful User-Agent so the API can identify the
# caller. Python's default httpx UA triggers stricter throttling/queuing.
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

    Mobile's Android networking layer blocks direct connections to Overpass
    mirrors. This endpoint proxies from Railway → Overpass server-side.

    [timeout:60] gives Overpass adequate time when Railway → Overpass latency
    is high. Without a meaningful User-Agent, Overpass throttles automated
    requests — the header is required per the Overpass API usage guidelines.
    """
    # [timeout:60] — Overpass returns HTTP 200 with empty elements (not a 504)
    # when the internal timeout fires (github.com/drolbr/Overpass-API/issues/382).
    # 60 s gives adequate headroom vs the default 25 s used for browser requests.
    query = (
        f"[out:json][timeout:60]"
        f"[bbox:{south:.6f},{west:.6f},{north:.6f},{east:.6f}];"
        f'(way["building"];);'
        f"out body;>;out skel qt;"
    )

    bbox_desc = f"bbox=[{south:.4f},{west:.4f},{north:.4f},{east:.4f}]"
    # read=65 s > Overpass [timeout:60] so httpx never cuts off a valid slow response
    timeout = httpx.Timeout(connect=8.0, read=65.0, write=5.0, pool=2.0)
    async with httpx.AsyncClient(timeout=timeout, headers=_HEADERS) as client:
        for endpoint in _OVERPASS_ENDPOINTS:
            try:
                resp = await client.post(endpoint, data={"data": query})
                if resp.status_code != 200:
                    logger.warning(
                        "[buildings] %s → HTTP %d %s",
                        endpoint, resp.status_code, resp.text[:300],
                    )
                    continue
                payload = resp.json()
                elements = payload.get("elements", [])
                if not elements:
                    # remark field reveals the reason — usually "Query timed out"
                    logger.warning(
                        "[buildings] %s → 0 elements for %s; remark=%r",
                        endpoint, bbox_desc, payload.get("remark"),
                    )
                    continue
                fc = _overpass_to_geojson(elements)
                logger.info(
                    "[buildings] %s → %d elements → %d features for %s",
                    endpoint, len(elements), len(fc["features"]), bbox_desc,
                )
                return fc
            except httpx.TimeoutException as exc:
                logger.warning("[buildings] %s timeout for %s: %s", endpoint, bbox_desc, exc)
            except Exception as exc:
                logger.warning("[buildings] %s error for %s: %s", endpoint, bbox_desc, exc)

    logger.error("[buildings] all endpoints failed for %s", bbox_desc)
    return {"type": "FeatureCollection", "features": []}
