from fastapi import APIRouter, Query
import httpx

router = APIRouter(prefix="/api", tags=["buildings"])

_OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]


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

    Timeout budget: connect=5 s + read=13 s = 18 s max. Overpass internal
    timeout is capped at [timeout:10] so the round-trip stays well within
    Railway's per-request limit and the mobile's 22 s abort controller.
    """
    query = (
        f"[out:json][timeout:25]"
        f"[bbox:{south:.6f},{west:.6f},{north:.6f},{east:.6f}];"
        f'(way["building"];relation["building"]["type"="multipolygon"];);'
        f"out body;>;out skel qt;"
    )

    # Overpass internal timeout is 25 s; read=28 s gives it the full window
    # before httpx cuts off. Mobile abort is 35 s > 5+28 = 33 s max.
    timeout = httpx.Timeout(connect=5.0, read=28.0, write=5.0, pool=2.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        for endpoint in _OVERPASS_ENDPOINTS:
            try:
                resp = await client.get(endpoint, params={"data": query})
                if resp.status_code != 200:
                    continue
                elements = resp.json().get("elements", [])
                if not elements:
                    continue
                return _overpass_to_geojson(elements)
            except Exception:
                continue

    return {"type": "FeatureCollection", "features": []}
